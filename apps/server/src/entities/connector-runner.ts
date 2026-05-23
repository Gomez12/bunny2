import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import type { EntityRef } from '@bunny2/shared';
import { publishSyncRequested, type EntityConnector } from './connectors/base';
import { listConnectorsForKind, listEntityModules } from './registry';
import {
  createLayerAttachmentConfigResolver,
  type ConnectorConfigResolver,
} from './connector-dispatcher';

/**
 * Phase 4a.2 — interval-driven poll runner.
 *
 * On every tick the runner iterates every `(kind, connector)` pair in
 * the registry, finds external links whose `synced_at` is older than
 * the configured `pollIntervalMinutes` for the link's layer, and
 * emits one `entity.connector.sync.requested` per stale link. The
 * dispatcher subscriber (registered separately at boot) consumes the
 * event and runs the connector's `pull`.
 *
 * Splitting the runner from the dispatcher keeps the responsibilities
 * crisp: the runner asks for syncs (one publish per stale link), the
 * dispatcher does syncs (one pull per request). Both halves are
 * test-injectable.
 *
 * `pollIntervalMinutes` lives in the per-layer `layer_attachments` row
 * (`kind = 'connector'`, `ref_id = <connectorId>`, `config.pollIntervalMinutes`).
 * A connector's `verify` schema is the source of truth for both the
 * value range and the default — the runner reads whatever
 * `resolveConfig` hands back.
 */
export interface ConnectorRunnerDeps {
  readonly db: Database;
  readonly bus: MessageBus;
  readonly clock?: () => Date;
  readonly intervalMs?: number;
  /** Default 1440 minutes (24h) — matches the §brief default. */
  readonly defaultPollIntervalMinutes?: number;
  /**
   * Pluggable connector listing so tests don't need to touch the
   * process-global registry. Defaults to `listEntityModules() +
   * listConnectorsForKind()`.
   */
  readonly listConnectors?: () => readonly RegisteredConnector[];
  readonly resolveConfig?: ConnectorConfigResolver;
}

export interface RegisteredConnector {
  readonly kind: string;
  readonly connector: EntityConnector<unknown>;
}

export interface ConnectorRunner {
  start(): void;
  stop(): void;
  /**
   * Drives a single tick synchronously. Returns the number of
   * `requested` events emitted, which makes for tidy assertions in
   * the runner test.
   */
  tickOnce(): Promise<number>;
}

interface StaleLinkRow {
  id: string;
  entity_id: string;
  entity_kind: string;
  connector: string;
  external_id: string;
  layer_id: string;
  entity_slug: string;
  synced_at: string | null;
  sync_state: string;
}

const DEFAULT_INTERVAL_MS = 60_000;

export function createConnectorRunner(deps: ConnectorRunnerDeps): ConnectorRunner {
  const clock = deps.clock ?? (() => new Date());
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const defaultPoll = deps.defaultPollIntervalMinutes ?? 1440;
  const listConnectors = deps.listConnectors ?? defaultListConnectors;
  const resolveConfig = deps.resolveConfig ?? createLayerAttachmentConfigResolver(deps.db);
  let timer: ReturnType<typeof setInterval> | null = null;

  async function tickOnce(): Promise<number> {
    const now = clock().getTime();
    let emitted = 0;
    for (const { kind, connector } of listConnectors()) {
      const tableName = lookupTable(kind);
      if (tableName === null) continue;
      const rows = listExternalLinksForKindAndConnector(deps.db, {
        kind,
        connectorId: connector.id,
        tableName,
      });
      for (const row of rows) {
        // Pulls already in-flight (`syncing`) or in `error` are NOT
        // re-requested by the runner. `error` rows need a developer
        // or a `POST /external-links` retry; the runner does not
        // implement exponential backoff in v1.
        if (row.sync_state !== 'idle') continue;
        const config = resolveConfig({ layerId: row.layer_id, connectorId: connector.id });
        const intervalMinutes = readPollMinutes(config) ?? defaultPoll;
        const intervalMsForLink = intervalMinutes * 60_000;
        const lastSyncMs =
          row.synced_at === null ? Number.NEGATIVE_INFINITY : Date.parse(row.synced_at);
        if (now - lastSyncMs < intervalMsForLink) continue;
        const ref: EntityRef = {
          id: row.entity_id,
          kind: row.entity_kind,
          layerId: row.layer_id,
          slug: row.entity_slug,
        };
        await publishSyncRequested({
          bus: deps.bus,
          ref,
          connector: row.connector,
          externalId: row.external_id,
        });
        emitted += 1;
      }
    }
    return emitted;
  }

  return {
    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        // The tick is fire-and-forget — failures are logged but must
        // not crash the timer loop. Connectors signal errors via
        // `markFailed`; anything that escapes here is a runner bug.
        tickOnce().catch((err: unknown) => {
          console.error('[connector-runner] tick failed:', err);
        });
      }, intervalMs);
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    tickOnce,
  };
}

function defaultListConnectors(): readonly RegisteredConnector[] {
  const out: RegisteredConnector[] = [];
  for (const module of listEntityModules()) {
    for (const connector of listConnectorsForKind(module.kind)) {
      out.push({ kind: module.kind, connector });
    }
  }
  return out;
}

function readPollMinutes(config: Readonly<Record<string, unknown>> | null): number | null {
  if (config === null) return null;
  const raw = (config as Record<string, unknown>)['pollIntervalMinutes'];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  return raw;
}

/**
 * The runner needs `entity_slug` and `layer_id` on the EntityRef it
 * publishes — neither lives on `entity_external_links`. We join to the
 * per-kind table to fetch them. This means the runner only knows about
 * connectors whose entities live in a per-kind table that follows the
 * §4.0 contract (which is every kind by construction).
 */
function lookupTable(kind: string): string | null {
  for (const module of listEntityModules()) {
    if (module.kind === kind) return module.tableName;
  }
  return null;
}

function listExternalLinksForKindAndConnector(
  db: Database,
  input: { readonly kind: string; readonly connectorId: string; readonly tableName: string },
): readonly StaleLinkRow[] {
  // We interpolate `tableName` directly — it comes from the registered
  // EntityModule, validated in the `EntityStore` factory against
  // `/^[a-z_][a-z0-9_]*$/`. No user input touches this string.
  const sql = `SELECT
      l.id,
      l.entity_id,
      l.entity_kind,
      l.connector,
      l.external_id,
      l.sync_state,
      l.synced_at,
      t.layer_id   AS layer_id,
      t.slug       AS entity_slug
    FROM entity_external_links l
    JOIN ${input.tableName} t ON t.id = l.entity_id
    WHERE l.entity_kind = ? AND l.connector = ?
      AND t.deleted_at IS NULL`;
  return db.query<StaleLinkRow, [string, string]>(sql).all(input.kind, input.connectorId);
}
