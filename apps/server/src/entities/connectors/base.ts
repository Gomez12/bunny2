import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import type { EntityRef, EntityExternalLink, EntitySyncState } from '@bunny2/shared';
import {
  ENTITY_EVENT_TYPES,
  type EntityConnectorSyncFailedPayload,
  type EntityConnectorSyncRequestedPayload,
  type EntityConnectorSyncSucceededPayload,
} from '../events';

/**
 * Phase 4.0 — base contract every external-system connector implements.
 *
 * A connector is a thin adapter between an `EntityModule` and a third-
 * party system (KvK, Google Calendar, vCard import, ...). It owns:
 *
 *  - `pull(ctx)` — fetch new/changed external records into the layer.
 *  - `push(ctx, entity)` — propagate local changes upstream (NOOP for
 *    one-way connectors like KvK and vCard import).
 *  - `verify(config)` — boot-time / on-attach validation of the
 *    connector's per-link config blob. Returns `null` on success or a
 *    localized error key on failure (see ADR `0009` §error keys).
 *
 * Secrets must NEVER leave `entity_external_links.payload_json`. The
 * helpers in this file scrub the payload before publishing — phase-6
 * risk row "Connector tokens leak via event log" in
 * `docs/dev/plans/phase-04-first-entities.md §13`.
 */
export interface EntityConnector<Payload> {
  readonly id: string;
  readonly kind: string;
  /**
   * Pull external data into the layer. The dispatcher resolves the
   * external-link row that triggered this pull and passes the
   * `externalId` here so the connector knows which external record to
   * fetch. Connectors that need per-link state can read it from
   * `ctx.db` via `listExternalLinks` — the link's `payload_json` carries
   * non-secret state. Secrets travel via `ctx.config`, never via the
   * link payload (see file-level doc).
   */
  pull(ctx: ConnectorContext, input: ConnectorPullInput): Promise<void>;
  push(ctx: ConnectorContext, entity: ConnectorEntityInput<Payload>): Promise<void>;
  verify(config: Readonly<Record<string, unknown>>): Promise<string | null>;
}

/**
 * Runtime context handed to every connector method. Connectors must
 * use the provided `bus` and `db` — they do not own their own
 * persistence; every state change must be observable through the bus.
 *
 * `config` is the per-layer attachment config (kind=`connector`,
 * ref_id=connector id) resolved by the dispatcher. It is the ONLY place
 * an apiKey / OAuth token ever lives at runtime; it is NEVER copied into
 * `entity_external_links.payload_json` nor into any bus event payload.
 */
export interface ConnectorContext {
  readonly db: Database;
  readonly bus: MessageBus;
  readonly now: () => Date;
  readonly correlationId?: string;
  readonly config: Readonly<Record<string, unknown>>;
}

/** What `pull(...)` receives per dispatch (one call per external link). */
export interface ConnectorPullInput {
  readonly ref: EntityRef;
  readonly externalId: string;
}

/** Minimal projection of an `Entity` that a connector needs for `push`. */
export interface ConnectorEntityInput<Payload> {
  readonly ref: EntityRef;
  readonly payload: Payload;
  readonly externalLinks: readonly EntityExternalLink[];
}

// ---------------------------------------------------------------------------
// Row shape for the shared `entity_external_links` table.
// ---------------------------------------------------------------------------

interface ExternalLinkRow {
  id: string;
  entity_id: string;
  entity_kind: string;
  connector: string;
  external_id: string;
  sync_state: EntitySyncState;
  synced_at: string | null;
  error: string | null;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

function rowToLink(row: ExternalLinkRow): EntityExternalLink {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    // Repos in this codebase coerce malformed JSON to `{}` rather than
    // throwing — keeps a partial migration recoverable.
    payload = {};
  }
  return {
    id: row.id,
    connector: row.connector,
    externalId: row.external_id,
    syncState: row.sync_state,
    syncedAt: row.synced_at,
    error: row.error,
    payload,
  };
}

const SELECT_COLS =
  'id, entity_id, entity_kind, connector, external_id, sync_state, ' +
  'synced_at, error, payload_json, created_at, updated_at';

// ---------------------------------------------------------------------------
// Sync-state helpers — connector implementations call these instead of
// touching the table directly so the bus side-effects stay centralized.
// ---------------------------------------------------------------------------

export interface SyncTransitionInput {
  readonly db: Database;
  readonly bus: MessageBus;
  readonly ref: EntityRef;
  readonly connector: string;
  readonly externalId: string;
  readonly now: string;
  readonly correlationId?: string;
}

export interface SyncFailureInput extends SyncTransitionInput {
  readonly error: string;
}

/**
 * Move an external link to `syncing` WITHOUT publishing the request
 * event. Used by the dispatcher subscriber: the request event is the
 * trigger, not the consequence, so we must not republish it from the
 * handler. Publishing the request event is the responsibility of the
 * caller that ASKS for a sync (HTTP route on link creation, runner on
 * stale-link tick); see `publishSyncRequested`.
 */
export function setSyncingState(input: {
  readonly db: Database;
  readonly connector: string;
  readonly externalId: string;
  readonly now: string;
}): void {
  updateState(input.db, {
    connector: input.connector,
    externalId: input.externalId,
    syncState: 'syncing',
    syncedAt: null,
    error: null,
    now: input.now,
  });
}

/**
 * Publish `entity.connector.sync.requested`. Callers that ASK for a
 * sync (router POST, runner tick) call this once; the dispatcher
 * subscriber transitions the row to `syncing` via `setSyncingState`
 * before invoking the connector's `pull`. Splitting the state-write
 * half from the publish half avoids the double-publish that would
 * otherwise occur when the subscriber tried to "mark" the row syncing.
 */
export async function publishSyncRequested(input: {
  readonly bus: MessageBus;
  readonly ref: EntityRef;
  readonly connector: string;
  readonly externalId: string;
  readonly correlationId?: string;
}): Promise<void> {
  const payload: EntityConnectorSyncRequestedPayload = {
    ref: input.ref,
    connector: input.connector,
    externalId: input.externalId,
  };
  await input.bus.publish({
    type: ENTITY_EVENT_TYPES.ConnectorSyncRequested,
    payload,
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
  });
}

/**
 * Legacy combined helper kept for callers that ask for a sync AND want
 * the row left in `syncing` in one shot. Internally calls
 * `setSyncingState` + `publishSyncRequested`. New code should prefer
 * the split halves so a request-event subscriber does not double-
 * publish. Do not call this from a `ConnectorSyncRequested` subscriber.
 */
export async function markSyncing(input: SyncTransitionInput): Promise<void> {
  setSyncingState({
    db: input.db,
    connector: input.connector,
    externalId: input.externalId,
    now: input.now,
  });
  await publishSyncRequested({
    bus: input.bus,
    ref: input.ref,
    connector: input.connector,
    externalId: input.externalId,
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
  });
}

/** Move an external link to `idle` after a successful sync. */
export async function markSucceeded(input: SyncTransitionInput): Promise<void> {
  updateState(input.db, {
    connector: input.connector,
    externalId: input.externalId,
    syncState: 'idle',
    syncedAt: input.now,
    error: null,
    now: input.now,
  });
  const payload: EntityConnectorSyncSucceededPayload = {
    ref: input.ref,
    connector: input.connector,
    externalId: input.externalId,
    syncState: 'idle',
    syncedAt: input.now,
  };
  await input.bus.publish({
    type: ENTITY_EVENT_TYPES.ConnectorSyncSucceeded,
    payload,
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
  });
}

/** Move an external link to `error` and publish the failure. */
export async function markFailed(input: SyncFailureInput): Promise<void> {
  updateState(input.db, {
    connector: input.connector,
    externalId: input.externalId,
    syncState: 'error',
    syncedAt: null,
    error: input.error,
    now: input.now,
  });
  const payload: EntityConnectorSyncFailedPayload = {
    ref: input.ref,
    connector: input.connector,
    externalId: input.externalId,
    // The error message is the connector author's responsibility — by
    // contract it MUST be an i18n key (e.g. `errors.connector.kvk.rateLimited`)
    // or a redacted string. Never raw stack traces or secrets.
    error: input.error,
  };
  await input.bus.publish({
    type: ENTITY_EVENT_TYPES.ConnectorSyncFailed,
    payload,
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
  });
}

interface UpdateStateInput {
  connector: string;
  externalId: string;
  syncState: EntitySyncState;
  syncedAt: string | null;
  error: string | null;
  now: string;
}

function updateState(db: Database, input: UpdateStateInput): void {
  db.query<unknown, [EntitySyncState, string | null, string | null, string, string, string]>(
    `UPDATE entity_external_links
        SET sync_state = ?, synced_at = ?, error = ?, updated_at = ?
      WHERE connector = ? AND external_id = ?`,
  ).run(input.syncState, input.syncedAt, input.error, input.now, input.connector, input.externalId);
}

// ---------------------------------------------------------------------------
// Repo-style accessors so the generic store + tests do not duplicate SQL.
// ---------------------------------------------------------------------------

export interface InsertExternalLinkInput {
  readonly id: string;
  readonly ref: EntityRef;
  readonly connector: string;
  readonly externalId: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly now: string;
}

export function insertExternalLink(
  db: Database,
  input: InsertExternalLinkInput,
): EntityExternalLink {
  const payloadJson = JSON.stringify(input.payload ?? {});
  db.query<unknown, [string, string, string, string, string, string, string, string]>(
    `INSERT INTO entity_external_links
       (id, entity_id, entity_kind, connector, external_id, sync_state,
        payload_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'idle', ?, ?, ?)`,
  ).run(
    input.id,
    input.ref.id,
    input.ref.kind,
    input.connector,
    input.externalId,
    payloadJson,
    input.now,
    input.now,
  );
  const row = db
    .query<
      ExternalLinkRow,
      [string]
    >(`SELECT ${SELECT_COLS} FROM entity_external_links WHERE id = ?`)
    .get(input.id);
  if (row === null) {
    throw new Error(`entity-external-links: failed to read back row ${input.id} after insert`);
  }
  return rowToLink(row);
}

export function listExternalLinks(
  db: Database,
  ref: { entityId: string; kind: string },
): readonly EntityExternalLink[] {
  return db
    .query<ExternalLinkRow, [string, string]>(
      `SELECT ${SELECT_COLS} FROM entity_external_links
        WHERE entity_kind = ? AND entity_id = ?
        ORDER BY created_at`,
    )
    .all(ref.kind, ref.entityId)
    .map(rowToLink);
}

export function removeExternalLink(db: Database, id: string): void {
  db.query<unknown, [string]>('DELETE FROM entity_external_links WHERE id = ?').run(id);
}

/**
 * Strips known-secret keys from a payload before it crosses an
 * untrusted boundary (bus log, HTTP response). The whitelist is
 * conservative; connectors with bespoke secret keys are expected to
 * extend this via `scrubConnectorPayload(payload, ['my_token'])`.
 */
const DEFAULT_SECRET_KEYS = new Set([
  'token',
  'access_token',
  'refresh_token',
  'apiKey',
  'api_key',
  'password',
  'secret',
  'clientSecret',
  'client_secret',
  'private_key',
]);

export function scrubConnectorPayload(
  payload: Readonly<Record<string, unknown>>,
  extraSecretKeys: readonly string[] = [],
): Record<string, unknown> {
  const blockList = new Set<string>([...DEFAULT_SECRET_KEYS, ...extraSecretKeys]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (blockList.has(key)) continue;
    out[key] = value;
  }
  return out;
}
