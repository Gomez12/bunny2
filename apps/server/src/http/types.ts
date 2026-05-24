import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import type { User as SafeUser } from '@bunny2/shared';
import type { LlmClient } from '../llm';
import type { AuthConfig, LocalesConfig } from '../config/schema';
import type { Session } from '../repos/sessions-repo';
import type { GroupResolver } from '../auth/group-resolver';
import type { Layer } from '../repos/layers-repo';
import type { LayerResolver } from '../layers/resolver';
import type { ProcessRole } from '../role';

/**
 * Snapshot returned by `GET /status`. Built by `index.ts` and passed as a
 * closure so route handlers do not have to know about the storage or LLM
 * call-log internals.
 */
export interface StatusBody {
  readonly app: string;
  readonly version: string;
  readonly phase: string;
  readonly ok: boolean;
  readonly dataDir: string;
  readonly configFile: string | null;
  /**
   * Phase 5.2 — which role this process booted in (`web` / `worker` /
   * `all`). Surfaced so an operator hitting `/status` on a deployment
   * can confirm the process-split topology without grepping the boot
   * log.
   */
  readonly role: ProcessRole;
  readonly sqlite: { readonly schemaVersion: string | null };
  readonly lancedb: { readonly ready: boolean; readonly tables: readonly string[] };
  readonly bus: { readonly adapter: string; readonly events: number };
  readonly llm: {
    readonly endpoint: string;
    readonly defaultModel: string;
    readonly calls: number;
  };
  readonly auth: {
    readonly sessions: number;
    readonly users: number;
    readonly groups: number;
    /**
     * `true` once the one-shot admin seed has run on this data-dir
     * (`kv_meta.admin_seed_done === 'true'`). Read by the renderer to
     * decide whether to surface a "first run" banner; never gates any
     * server-side behaviour itself.
     */
    readonly adminSeeded: boolean;
    /**
     * `true` if `kv_meta.admin_group_id` is currently populated. The
     * `requireAdmin` middleware reads the same key ONCE at factory
     * construction; a freshly-booted server therefore stays in the
     * "503 admin not seeded" state for the lifetime of the process if
     * the seed lands AFTER `createApp` (which only happens in
     * unusual test wiring — production seeds before `Bun.serve`).
     * Status is a per-request live read, so the two values can briefly
     * disagree across that race; use `adminSeeded` for the strict
     * "seed has run on this data-dir" answer.
     */
    readonly adminGroupResolved: boolean;
  };
  /**
   * Phase 3.2 — layer-domain status. Optional so any caller that builds
   * a `StatusBody` for tests in phases 1/2 keeps compiling; production
   * always populates this block from `index.ts` after the layer seed.
   */
  readonly layers?: {
    readonly total: number;
    readonly byType: {
      readonly personal: number;
      readonly project: number;
      readonly group: number;
      readonly everyone: number;
    };
    readonly withDeleted: number;
  };
}

/**
 * Dependencies injected into `createApp`. Tests construct these with real
 * implementations (real bus, real sqlite-backed event log, real telemetry
 * wrapper around a mock provider) so HTTP integration tests exercise the
 * full pipeline.
 *
 * `db` and `auth` are required from phase 2.2 onward: the auth middleware
 * needs the session-backing repositories and the TTL/idle config knobs.
 */
export interface AppDeps {
  readonly bus: MessageBus;
  readonly llmClient: LlmClient;
  readonly status: () => StatusBody;
  readonly db: Database;
  readonly auth: AuthConfig;
  /**
   * Transitive group resolver — phase 2.4. Built in `index.ts` against
   * the shared bus so the resolver's cache invalidation subscribers see
   * the same publishes the rest of the system emits. Tests build it via
   * `_helpers/app.ts`.
   */
  readonly resolver: GroupResolver;
  /**
   * Phase 3.3 — effective-layer-set resolver. Consumed by the
   * `withEffectiveLayers` middleware (chained after `requireAuth`) to
   * attach `c.var.effectiveLayers` to every authenticated request, and
   * indirectly by the per-route `requireLayer` helper that reads from
   * `c.var.effectiveLayers`. Built once in `index.ts` against the same
   * bus that emits `layer.*` invalidation events; tests construct a
   * minimal fixture (or an injectable fake) via `_helpers/app.ts`.
   */
  readonly layerResolver: LayerResolver;
  /**
   * Phase 3.4 — system-configured locale list, served by
   * `GET /system/locales` and consulted by `POST /layers/:slug/locales`
   * to validate each requested locale against the deployment-allowed
   * set. Defaults match the web bundle (`en`, `nl` with `en` default).
   */
  readonly locales: LocalesConfig;
  /**
   * Phase 4b.2 — process-wide connector dispatcher used by the ingest
   * route (`POST /l/:slug/contact/_ingest/:connectorId`). Optional so
   * `_helpers/app.ts` (which does NOT wire a dispatcher) keeps working
   * for tests that don't exercise the ingest path. Production wiring in
   * `apps/server/src/index.ts` constructs the dispatcher exactly once
   * (same instance subscribed to `sync.requested`) and passes it here.
   */
  readonly ingestDispatcher?: import('../entities').ConnectorDispatcher;
  /**
   * Phase 4b.2 — byte cap for ingest uploads. Production wiring sources
   * this from `config.connectors.ingestMaxBytes`; tests can pass a tiny
   * value to exercise the oversize path.
   */
  readonly ingestMaxBytes?: number;
}

/**
 * Hono `c.var` shape attached by the auth middleware. Route handlers
 * authored after 2.2 may read `c.var.session` / `c.var.user` without
 * casts because the router types the Hono instance via
 * `new Hono<{ Variables: HonoVariables }>()`.
 *
 * Public routes (status, /auth/login, /auth/logout, OPTIONS) skip the
 * middleware entirely; their handlers must NOT read these variables.
 */
export interface HonoVariables {
  session: Session;
  user: SafeUser;
  /**
   * Phase 3.3 — frozen, sorted, deduped set of layers visible to the
   * authenticated caller. Attached by `withEffectiveLayers` AFTER
   * `requireAuth` populates `c.var.user`. Public routes (status, login,
   * logout, OPTIONS) skip the middleware so this is `undefined` there;
   * handlers gated by `requireAuth` may read it without a defined check.
   * Typed as optional to match the runtime contract; handlers must not
   * read it from a public route.
   */
  effectiveLayers?: readonly Layer[];
  /**
   * Phase 3.3 — set by `requireLayer` after a successful per-route slug
   * lookup against `effectiveLayers`. Only present on routes mounted
   * with `requireLayer`; readers in other handlers must not assume it.
   */
  layer?: Layer;
}
