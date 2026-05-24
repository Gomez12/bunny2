import type { Database } from 'bun:sqlite';
import type { BusEvent, MessageBus, Unsubscribe } from '@bunny2/bus';
import {
  ENTITY_EVENT_TYPES,
  type EntityConnectorIngestCompletedPayload,
  type EntityConnectorIngestRequestedPayload,
  type EntityConnectorSyncRequestedPayload,
} from './events';
import {
  markFailed,
  markSucceeded,
  persistConnectorPayloadPatch,
  setSyncingState,
  type ConnectorIngestPayload,
  type ConnectorIngestResult,
  type EntityConnector,
} from './connectors/base';
import { getConnector, getEntityModule } from './registry';
import { createLayerAttachmentsRepo } from '../repos/layer-attachments-repo';
import type { LayerAttachmentKind } from '@bunny2/shared';
import { createEntityStore, type EntityStore } from './store';
import type { LlmClient } from '../llm';

/**
 * Phase 4a.2 — single subscriber that turns
 * `entity.connector.sync.requested` events into actual `connector.pull`
 * calls.
 *
 * Why a dispatcher (vs. each connector subscribing for itself):
 *  - One place to scrub secrets out of the bus event payload (none are
 *    in it by design — see `events.ts` invariants — but the dispatcher
 *    is the choke point where we resolve `ctx.config` from
 *    `layer_attachments`).
 *  - One place to call `setSyncingState` so a future connector author
 *    cannot accidentally re-publish `requested` from the handler.
 *  - One place to call `markSucceeded` / `markFailed` so the
 *    sync-state transitions stay consistent across kinds.
 *
 * The dispatcher is registered ONCE per process (boot wiring in
 * `apps/server/src/index.ts`). Tests inject a fresh dispatcher via
 * `createConnectorDispatcher(...)` and explicitly `start()` it on the
 * test bus, then `stop()` in teardown — that is the only way to avoid
 * piling up subscribers when `makeTestApp` rebuilds the app multiple
 * times against the same bus.
 */
export interface ConnectorDispatcherDeps {
  readonly db: Database;
  readonly bus: MessageBus;
  readonly clock?: () => Date;
  /**
   * Resolver for the per-link connector config. Defaults to the
   * production resolver which reads from `layer_attachments` rows
   * scoped to the entity's layer with `kind = 'connector'` and
   * `ref_id = <connectorId>`. Tests pass a stub to inject an apiKey
   * without touching the DB. Returns `null` when no attachment exists;
   * the dispatcher then marks the sync failed with
   * `errors.connectors.notConfigured`.
   */
  readonly resolveConfig?: ConnectorConfigResolver;
  /**
   * Optional explicit lookup. Defaults to the process-wide registry's
   * `getConnector`. Tests pass a fake to avoid touching the registry
   * (which is process-global and shared with other tests).
   */
  readonly lookup?: (kind: string, connectorId: string) => EntityConnector<unknown> | null;
  /**
   * Phase 4b.2 — LLM client wired into the per-kind `EntityStore` that
   * `ingest` instantiates. The store is built lazily (only on the first
   * `ingest(...)` call for a given kind). Optional: tests for `pull`
   * never trigger the store factory, so they can omit the field.
   */
  readonly llm?: LlmClient;
}

export type ConnectorConfigResolver = (input: {
  readonly layerId: string;
  readonly connectorId: string;
}) => Readonly<Record<string, unknown>> | null;

export interface ConnectorDispatcher {
  /**
   * Subscribes to `entity.connector.sync.requested`. Idempotent on the
   * same instance — calling `start()` twice is a no-op. A different
   * dispatcher instance against the same bus DOES register a second
   * subscriber; production wiring constructs the dispatcher exactly
   * once.
   */
  start(): void;
  stop(): void;
  /**
   * Direct entry point for tests that want to drive a single sync
   * synchronously without going through the bus. Returns the same
   * promise the subscriber would await. Errors are mapped to
   * `markFailed` and re-thrown so test assertions can observe them.
   */
  handle(payload: EntityConnectorSyncRequestedPayload, correlationId?: string): Promise<void>;
  /**
   * Phase 4b.2 — synchronous ingest dispatch. The HTTP route awaits
   * this call; the result feeds the JSON response the user sees.
   * Throws on unknown connector / no `ingest` method / connector parse
   * failure — the route handler maps the throw to the right HTTP status
   * + error key. On a successful run the dispatcher emits one
   * `entity.connector.ingest.requested` BEFORE the connector runs and
   * one `entity.connector.ingest.completed` AFTER. Per-entity events
   * are emitted by the generic store's `create` / `update` calls — the
   * dispatcher does NOT publish per-entity events itself.
   */
  ingest(input: ConnectorIngestDispatchInput): Promise<ConnectorIngestSummary>;
}

/** Input to `ConnectorDispatcher.ingest(...)`. */
export interface ConnectorIngestDispatchInput {
  readonly kind: string;
  readonly connectorId: string;
  readonly layerId: string;
  readonly actorId: string;
  readonly payload: ConnectorIngestPayload;
  readonly correlationId?: string;
  /**
   * Default-locale to stamp on `entity.<kind>` rows created via the
   * ingest path. vCard 3.0/4.0 has no per-card locale, so the route
   * passes the configured server default (typically `en`).
   */
  readonly originalLocale: string;
}

/** Summary returned from `ConnectorDispatcher.ingest(...)`. */
export interface ConnectorIngestSummary {
  readonly created: number;
  readonly updated: number;
  readonly warnings: readonly string[];
}

const CONNECTOR_KIND: LayerAttachmentKind = 'connector';

/**
 * Default config resolver. Reads from `layer_attachments` where
 * `layer_id = ref.layerId AND kind = 'connector' AND ref_id =
 * connectorId`. Returns the first matching row's config; multiple rows
 * would be a programming error caught by the table's `UNIQUE
 * (layer_id, kind, ref_id)` index — but defensively we still take the
 * first.
 */
export function createLayerAttachmentConfigResolver(db: Database): ConnectorConfigResolver {
  const repo = createLayerAttachmentsRepo(db);
  return ({ layerId, connectorId }) => {
    const rows = repo.listAttachments(layerId, CONNECTOR_KIND);
    const match = rows.find((r) => r.refId === connectorId);
    return match === undefined ? null : (match.config as Readonly<Record<string, unknown>>);
  };
}

export function createConnectorDispatcher(deps: ConnectorDispatcherDeps): ConnectorDispatcher {
  const clock = deps.clock ?? (() => new Date());
  const lookup = deps.lookup ?? ((kind, id) => getConnector(kind, id));
  const resolveConfig = deps.resolveConfig ?? createLayerAttachmentConfigResolver(deps.db);
  let unsubscribe: Unsubscribe | null = null;

  async function handle(
    payload: EntityConnectorSyncRequestedPayload,
    correlationId?: string,
  ): Promise<void> {
    const { ref, connector: connectorId, externalId } = payload;
    const connector = lookup(ref.kind, connectorId);
    const nowIso = clock().toISOString();
    if (connector === null) {
      // Unknown connector: leave the row in `idle` is misleading
      // (it'll keep firing on the next runner tick). Mark it failed
      // with a stable error key so a developer who removes a connector
      // sees the symptom in the link's `error` column.
      await markFailed({
        db: deps.db,
        bus: deps.bus,
        ref,
        connector: connectorId,
        externalId,
        error: 'errors.entity.connectorUnknown',
        now: nowIso,
        ...(correlationId === undefined ? {} : { correlationId }),
      });
      return;
    }
    const config = resolveConfig({ layerId: ref.layerId, connectorId });
    if (config === null) {
      await markFailed({
        db: deps.db,
        bus: deps.bus,
        ref,
        connector: connectorId,
        externalId,
        error: 'errors.connectors.notConfigured',
        now: nowIso,
        ...(correlationId === undefined ? {} : { correlationId }),
      });
      return;
    }
    const pull = connector.pull;
    if (pull === undefined) {
      // 4b.2 — connectors that implement `ingest` only (vCard) MUST NOT
      // accumulate `entity_external_links` rows that would loop the
      // runner. Surface the misconfiguration with a stable key so a
      // developer sees the symptom immediately.
      await markFailed({
        db: deps.db,
        bus: deps.bus,
        ref,
        connector: connectorId,
        externalId,
        error: 'errors.connectors.pullNotSupported',
        now: nowIso,
        ...(correlationId === undefined ? {} : { correlationId }),
      });
      return;
    }
    // Transition the row to `syncing` WITHOUT re-publishing
    // `requested` — `setSyncingState` only writes the row. The
    // `requested` event was already published by the caller that
    // asked for the sync (router POST or runner tick); re-publishing
    // here would loop the subscriber.
    setSyncingState({
      db: deps.db,
      connector: connectorId,
      externalId,
      now: nowIso,
    });
    try {
      await pull(
        {
          db: deps.db,
          bus: deps.bus,
          now: clock,
          config,
          ...(correlationId === undefined ? {} : { correlationId }),
          // 4a.3 — capture the connector's mapped payload patch so the
          // enrichment runner can read the latest external ground-truth
          // from `entity_external_links.payload_json`. The patch is
          // scrubbed by `persistConnectorPayloadPatch` before write;
          // bus events stay closed (no payload field) as in 4a.2.
          onPayloadPatch: (patchInput) => {
            persistConnectorPayloadPatch({
              db: deps.db,
              connector: connectorId,
              externalId: patchInput.externalId,
              patch: patchInput.patch,
              now: clock().toISOString(),
            });
          },
        },
        { ref, externalId },
      );
      await markSucceeded({
        db: deps.db,
        bus: deps.bus,
        ref,
        connector: connectorId,
        externalId,
        now: clock().toISOString(),
        ...(correlationId === undefined ? {} : { correlationId }),
      });
    } catch (err) {
      // Connectors are expected to throw `Error` whose `.message` is
      // an i18n key (e.g. `errors.connectors.kvk.kvkUnauthorized`).
      // Anything else lands as `errors.entity.syncFailed` so we never
      // leak a raw stack trace into the bus event or the link row.
      const message = err instanceof Error ? err.message : String(err);
      const safe = message.startsWith('errors.') ? message : 'errors.entity.syncFailed';
      await markFailed({
        db: deps.db,
        bus: deps.bus,
        ref,
        connector: connectorId,
        externalId,
        error: safe,
        now: clock().toISOString(),
        ...(correlationId === undefined ? {} : { correlationId }),
      });
    }
  }

  /**
   * Phase 4b.2 — lazy per-kind store cache. The dispatcher builds an
   * `EntityStore<unknown>` the first time it sees a kind on the
   * `ingest` path. Production wiring shares the same store cache across
   * ingest calls; tests that drive `ingest` directly with a per-fixture
   * dispatcher get a fresh cache per fixture.
   */
  const storeCache = new Map<string, EntityStore<unknown>>();

  function resolveStore(kind: string): EntityStore<unknown> {
    const cached = storeCache.get(kind);
    if (cached !== undefined) return cached;
    const module = getEntityModule(kind);
    if (module === null) {
      throw new Error(`connector-dispatcher: no module registered for kind '${kind}'`);
    }
    if (deps.llm === undefined) {
      throw new Error(
        `connector-dispatcher: ingest requires an LlmClient dep — pass { llm } to createConnectorDispatcher`,
      );
    }
    const store = createEntityStore({
      module,
      db: deps.db,
      bus: deps.bus,
      llm: deps.llm,
    });
    storeCache.set(kind, store as EntityStore<unknown>);
    return store as EntityStore<unknown>;
  }

  /**
   * Match an ingest result entity against an existing layer row.
   * Returns the existing entity id when a non-soft-deleted match
   * exists; `null` otherwise.
   *
   * Currently supported `matchKey` kinds:
   *  - `email`: case-insensitive lookup against the
   *    `primary_email` indexed column on the per-kind table. The
   *    `contacts` module already maintains this column (4b.1).
   *  - `externalId`: lookup via `entity_external_links` for a row with
   *    `{ connector, external_id }` in the target layer.
   *
   * The dispatcher reads the per-kind `tableName` from the registry to
   * keep the SQL kind-agnostic. The column name (`primary_email`) is
   * baked in for the `email` strategy — currently only contacts use
   * the strategy and they declare the column verbatim. If a future
   * kind needs a different column the contract gains an optional
   * `matchByEmailColumn` on `EntityModule`; not now.
   */
  function findExistingByMatchKey(input: {
    readonly kind: string;
    readonly tableName: string;
    readonly layerId: string;
    readonly connectorId: string;
    readonly matchKey: NonNullable<ConnectorIngestResult<unknown>['entities'][number]['matchKey']>;
  }): string | null {
    if (input.matchKey.kind === 'email') {
      // The contacts table writes `primary_email` lowercased only when
      // the payload's primary email is lowercased — we cannot rely on
      // it. Do an explicit case-insensitive compare.
      const row = deps.db
        .query<
          { id: string },
          [string, string]
        >(`SELECT id FROM ${input.tableName} WHERE layer_id = ? AND LOWER(primary_email) = ? AND deleted_at IS NULL LIMIT 1`)
        .get(input.layerId, input.matchKey.value.toLowerCase());
      return row?.id ?? null;
    }
    // externalId strategy: find the entity that already holds the
    // upstream-system link. The link is per-kind via `entity_kind` so
    // collisions across kinds do not cross-match.
    const row = deps.db
      .query<{ entity_id: string; layer_id: string }, [string, string, string]>(
        `SELECT l.entity_id, t.layer_id
            FROM entity_external_links l
            JOIN ${input.tableName} t ON t.id = l.entity_id
           WHERE l.entity_kind = ? AND l.connector = ? AND l.external_id = ?
             AND t.deleted_at IS NULL
           LIMIT 1`,
      )
      .get(input.kind, input.connectorId, input.matchKey.value);
    if (row === null) return null;
    return row.layer_id === input.layerId ? row.entity_id : null;
  }

  async function ingest(input: ConnectorIngestDispatchInput): Promise<ConnectorIngestSummary> {
    const connector = lookup(input.kind, input.connectorId);
    if (connector === null) {
      throw new Error('errors.entity.connectorUnknown');
    }
    if (connector.ingest === undefined) {
      throw new Error('errors.connectors.ingestNotSupported');
    }
    const module = getEntityModule(input.kind);
    if (module === null) {
      // Defensive: the registry rebuilds the connector index against
      // the module list, so getting here means a developer mutated the
      // registry between calls. Surface as a generic 500-mapped error.
      throw new Error('errors.entity.connectorUnknown');
    }
    // Resolve per-layer attachment config (apiKey, OAuth tokens, ...).
    // Connectors with no config (vCard) declare an empty zod object in
    // `verify`; an absent attachment is then still acceptable. The
    // dispatcher hands `{}` to the connector so `ctx.config` is always
    // a usable object.
    const resolved = resolveConfig({ layerId: input.layerId, connectorId: input.connectorId });
    const config = resolved ?? {};
    const corr = input.correlationId;
    const requestedPayload: EntityConnectorIngestRequestedPayload = {
      kind: input.kind,
      connectorId: input.connectorId,
      layerId: input.layerId,
      contentType: input.payload.contentType,
      byteLength: input.payload.bytes.byteLength,
    };
    await deps.bus.publish({
      type: ENTITY_EVENT_TYPES.ConnectorIngestRequested,
      payload: requestedPayload,
      ...(corr === undefined ? {} : { correlationId: corr }),
    });
    const ctx = {
      db: deps.db,
      bus: deps.bus,
      now: clock,
      config,
      layerId: input.layerId,
      actorId: input.actorId,
      ...(corr === undefined ? {} : { correlationId: corr }),
    };
    const result = (await connector.ingest(ctx, input.payload)) as ConnectorIngestResult<unknown>;

    const store = resolveStore(input.kind);
    let created = 0;
    let updated = 0;
    for (const entity of result.entities) {
      let existingId: string | null = null;
      if (entity.matchKey !== undefined) {
        existingId = findExistingByMatchKey({
          kind: input.kind,
          tableName: module.tableName,
          layerId: input.layerId,
          connectorId: input.connectorId,
          matchKey: entity.matchKey,
        });
      }
      if (existingId === null) {
        await store.create({
          layerId: input.layerId,
          title: entity.title,
          originalLocale: input.originalLocale,
          payload: entity.payload,
          actorId: input.actorId,
          ...(corr === undefined ? {} : { correlationId: corr }),
        });
        created += 1;
      } else {
        await store.update({
          id: existingId,
          title: entity.title,
          payload: entity.payload,
          actorId: input.actorId,
          ...(corr === undefined ? {} : { correlationId: corr }),
        });
        updated += 1;
      }
    }

    const completedPayload: EntityConnectorIngestCompletedPayload = {
      kind: input.kind,
      connectorId: input.connectorId,
      layerId: input.layerId,
      created,
      updated,
      warningCount: result.warnings.length,
    };
    await deps.bus.publish({
      type: ENTITY_EVENT_TYPES.ConnectorIngestCompleted,
      payload: completedPayload,
      ...(corr === undefined ? {} : { correlationId: corr }),
    });
    return { created, updated, warnings: result.warnings };
  }

  return {
    start() {
      if (unsubscribe !== null) return;
      unsubscribe = deps.bus.subscribe<EntityConnectorSyncRequestedPayload>(
        ENTITY_EVENT_TYPES.ConnectorSyncRequested,
        async (event: BusEvent<EntityConnectorSyncRequestedPayload>) => {
          await handle(event.payload, event.correlationId);
        },
      );
    },
    stop() {
      if (unsubscribe !== null) {
        unsubscribe();
        unsubscribe = null;
      }
    },
    handle,
    ingest,
  };
}
