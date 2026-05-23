import type { Database } from 'bun:sqlite';
import type { BusEvent, MessageBus, Unsubscribe } from '@bunny2/bus';
import { ENTITY_EVENT_TYPES, type EntityConnectorSyncRequestedPayload } from './events';
import {
  markFailed,
  markSucceeded,
  setSyncingState,
  type EntityConnector,
} from './connectors/base';
import { getConnector } from './registry';
import { createLayerAttachmentsRepo } from '../repos/layer-attachments-repo';
import type { LayerAttachmentKind } from '@bunny2/shared';

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
      await connector.pull(
        {
          db: deps.db,
          bus: deps.bus,
          now: clock,
          config,
          ...(correlationId === undefined ? {} : { correlationId }),
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
  };
}
