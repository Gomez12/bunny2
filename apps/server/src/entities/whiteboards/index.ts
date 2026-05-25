import type { Database } from 'bun:sqlite';
import type { Hono } from 'hono';
import type { MessageBus } from '@bunny2/bus';
import type { WhiteboardPayload } from '@bunny2/shared';
import type { HonoVariables } from '../../http/types';
import type { LlmClient } from '../../llm';
import { createEntityStore } from '../store';
import { mountEntityRoutes } from '../router';
import { getEntityModule, registerEntityModule } from '../registry';
import type { EntityModule } from '../module';
import { whiteboardModule, createWhiteboardModule } from './module';
import { whiteboardEnrichmentJobs } from './enrichment';

export {
  whiteboardModule,
  createWhiteboardModule,
  WHITEBOARD_KIND,
  WHITEBOARD_TABLE,
  type CreateWhiteboardModuleOptions,
} from './module';

export {
  whiteboardEnrichmentJobs,
  whiteboardSceneSummaryJob,
  whiteboardMentionResolverJob,
  WHITEBOARD_SCENE_SUMMARY_JOB_ID,
  WHITEBOARD_MENTION_RESOLVER_JOB_ID,
  WHITEBOARD_MENTION_CONNECTOR_ID,
  extractMentionTokens,
  extractSceneTexts,
} from './enrichment';

export {
  WHITEBOARDS_ENRICH_KIND,
  whiteboardsEnrichHandler,
  registerWhiteboardsScheduledTaskHandlers,
  runWhiteboardsEnrichSweep,
  listStaleWhiteboards,
  readWhiteboardSummary,
  type WhiteboardsEnrichConfig,
  type WhiteboardsEnrichSweepResult,
} from './scheduled';

export { whiteboardStatsProvider, type WhiteboardStats } from './stats';

export { type WhiteboardThumbnail } from './thumbnail';

export {
  mountWhiteboardRecentRoute,
  type MountWhiteboardRecentRouteDeps,
  type RecentWhiteboardItem,
} from './recent';

export {
  whiteboardPlaceholderConnector,
  WHITEBOARD_PLACEHOLDER_CONNECTOR_ID,
  WHITEBOARD_PLACEHOLDER_NOT_CONFIGURED_KEY,
} from './connectors/placeholder';

/**
 * Phase 11.1 — wire-up helper for the whiteboards module.
 *
 * Registers `whiteboardModule` in the process-local entity registry
 * (so phase-5 schedulers and phase-6 chat can enumerate kinds) and
 * mounts the generic per-kind HTTP surface at `/l/:slug/whiteboard/*`.
 * The generic store writes `scene_byte_size` to the per-kind
 * `whiteboards` table via `whiteboardModule.indexedColumns` — no
 * whiteboard-specific SQL lives outside the migration. The other
 * whiteboard-specific columns (`last_checkpoint_at`, `thumbnail_blob`,
 * `thumbnail_etag`) are server-managed; the 11.5 PATCH/checkpoint
 * flow owns them.
 *
 * The wiring is exposed as a function (instead of a top-level side
 * effect on import) so tests can drive the store / module directly
 * without booting the HTTP layer and without colliding on the
 * registry — mirrors the companies / contacts / calendar / todos
 * precedent.
 */
export interface MountWhiteboardRoutesDeps {
  readonly db: Database;
  readonly bus: MessageBus;
  readonly llm: LlmClient;
  /**
   * Optional module override for tests that need a per-fixture
   * variant. Mirrors the calendar / todos wiring.
   */
  readonly module?: EntityModule<WhiteboardPayload>;
}

/**
 * Idempotent: safe to call multiple times per process. Mirrors
 * `registerTodoModule` / `registerCalendarEventModule` —
 * short-circuits when ANY whiteboard module is already registered, so
 * tests that pre-register a fixture variant BEFORE `createApp(...)`
 * runs do not collide with the production default that `createApp`
 * registers a moment later. Production has a single caller, so the
 * short-circuit never fires there.
 *
 * Pass `module` to register a per-test variant. Defaults to the
 * production `whiteboardModule`.
 */
export function registerWhiteboardModule(
  module: EntityModule<WhiteboardPayload> = whiteboardModule,
): EntityModule<WhiteboardPayload> {
  const existing = getEntityModule(module.kind);
  if (existing !== null) return existing as EntityModule<WhiteboardPayload>;
  registerEntityModule(module);
  return module;
}

/**
 * Phase 11.1 — build the whiteboard module for production. Mirrors
 * `buildProductionTodoModule()` so the wiring site in
 * `apps/server/src/http/router.ts` (lands later in phase 11) can call
 * a uniform `build…` helper per kind. In v1 the body intentionally
 * leaves the `connectors` slot empty: the §11.2 placeholder
 * (`whiteboardPlaceholderConnector`) exists in the module's
 * `connectors/` folder for future Miro / tldraw / `.excalidraw` import
 * connectors to land additively, but it is NOT wired into production —
 * a placeholder whose `verify(...)` always refuses with
 * `errors.connectors.notConfigured` would surface a permanent failing
 * attachment row on the connectors admin page. NO enrichment jobs
 * shipped in 11.1 either (11.3 lands the scene summariser + mention
 * resolver).
 *
 * Returns a module whose `connectors` field is `undefined` (not
 * `[]`) so the registry's `rebuildConnectorIndex` correctly leaves
 * the `whiteboard` bucket absent — matching
 * `listConnectorsForKind('whiteboard') === []`. Tests that want to
 * exercise the slot inject the placeholder explicitly via
 * `createWhiteboardModule({ connectors: [whiteboardPlaceholderConnector] })`.
 */
export function buildProductionWhiteboardModule(): EntityModule<WhiteboardPayload> {
  return createWhiteboardModule({ enrichmentJobs: whiteboardEnrichmentJobs });
}

/**
 * Mount the whiteboard routes. No cross-kind link middleware in 11.1
 * — whiteboards do not link to other entity kinds at the payload
 * layer. Mentions live in text element content and are resolved by
 * the enrichment job (11.3), not by a write-time validator.
 */
export function mountWhiteboardRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: MountWhiteboardRoutesDeps,
): void {
  const module = deps.module ?? whiteboardModule;
  const store = createEntityStore<WhiteboardPayload>({
    module,
    db: deps.db,
    bus: deps.bus,
    llm: deps.llm,
  });

  mountEntityRoutes(app, {
    module,
    store,
    bus: deps.bus,
    db: deps.db,
  });
}
