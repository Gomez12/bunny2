import { Hono } from 'hono';
import type { AppDeps, HonoVariables } from './types';
import { createDevCors } from './cors';
import { createAuthMiddleware, DEFAULT_PUBLIC_PATHS } from './middleware/auth';
import { requirePasswordCurrent } from './middleware/password-gate';
import { createRequireAdmin } from './middleware/admin';
import { withEffectiveLayers } from './middleware/layer';
import { createSessionService } from '../auth/sessions';
import { createSessionsRepo } from '../repos/sessions-repo';
import { createUsersRepo } from '../repos/users-repo';
import { mountStatusRoute } from './routes/status';
import { mountChatRoute } from './routes/chat';
import { registerAuthRoutes } from './routes/auth';
import { registerAdminGroupsRoutes } from './routes/admin-groups';
import { registerAdminUsersRoutes } from './routes/admin-users';
import { registerMeLayersRoute } from './routes/me-layers';
import { registerMeVisibleRoutes } from './routes/me-visible';
import { registerLayersRoutes } from './routes/layers';
import { registerSystemLocalesRoute } from './routes/system-locales';
// Phase 4a.1 — first concrete entity kind. Each per-kind sub-phase
// (4a..4d) registers its module and mounts its routes via a small
// helper exported from `apps/server/src/entities/<kind>/index.ts`.
import { mountCompanyRoutes, registerCompanyModule } from '../entities/companies';
import { mountContactRoutes, registerContactModule } from '../entities/contacts';
import {
  mountCalendarEventRoutes,
  registerCalendarEventModule,
  buildProductionCalendarEventModule,
} from '../entities/calendar';
import {
  buildProductionTodoModule,
  mountTodoCalendarProjectionRoutes,
  mountTodoRoutes,
  registerTodoModule,
} from '../entities/todos';
import { createScheduledTasksRepo } from '../scheduled/repo';
import { registerScheduledTasksRoutes } from './routes/scheduled-tasks';
import { registerAdminScheduledTasksRoutes } from './routes/admin-scheduled-tasks';
import { registerAdminBusRoutes } from './routes/admin-bus';
import { registerLayerChatRoutes } from './routes/layer-chat';
import { registerLayerProposalsRoutes } from './routes/layer-proposals';
import { registerLayerCapabilitiesRoutes } from './routes/layer-capabilities';
import { registerLayerProposalSettingsRoutes } from './routes/layer-proposal-settings';
import { createSqliteLlmCallLog } from '../llm/call-log';
import {
  createEntityStore as createGenericEntityStore,
  getEntityModule,
  type EntityModule,
} from '../entities';
import type { EntityKind, EntityStoreForRetrieval } from '../chat/pipeline';

/**
 * Builds the HTTP app for `apps/server`.
 *
 * Returns a Hono instance so callers can either:
 *  - Pass `app.fetch` to `Bun.serve({ fetch })` (production).
 *  - Call `app.fetch(new Request(...))` in tests for in-process round-trips
 *    against a real bus, real event log, and a telemetry-wrapped client
 *    (see ADR 0006).
 *
 * Middleware order (outer → inner):
 *
 *   1. `createDevCors()` — answers CORS preflights and reflects
 *      `Origin` for the dev allowlist.
 *   2. `createAuthMiddleware(...)` — gates every route except the
 *      `DEFAULT_PUBLIC_PATHS` whitelist (`GET /status`,
 *      `POST /auth/login`, `POST /auth/logout`).
 *   3. Routes (`/status`, `/chat`, …).
 *
 * From phase 2.2 onward `/chat` and any future route requires a valid
 * session. Tests must seed a session via `seedUserAndSession` (see
 * `apps/server/tests/_helpers/auth.ts`) and pass either the cookie or
 * `Authorization: Bearer <token>`.
 */
export function createApp(deps: AppDeps): Hono<{ Variables: HonoVariables }> {
  const app = new Hono<{ Variables: HonoVariables }>();

  const usersRepo = createUsersRepo(deps.db);
  const sessionsRepo = createSessionsRepo(deps.db);
  const sessionService = createSessionService({
    sessions: sessionsRepo,
    users: usersRepo,
    bus: deps.bus,
  });

  app.use('*', createDevCors());
  app.use(
    '*',
    createAuthMiddleware({
      sessions: sessionService,
      idleMinutes: deps.auth.sessionIdleMinutes,
      publicPaths: DEFAULT_PUBLIC_PATHS,
    }),
  );
  // The password-rotation gate runs AFTER auth so it can read
  // `c.var.user.mustChangePassword`. It is a no-op for unauthenticated
  // (public) routes and for the exempt rotation/logout endpoints; every
  // other route returns 409 with `errors.auth.mustChangePassword` when
  // the active user still needs to rotate.
  app.use('*', requirePasswordCurrent());

  // Phase 3.3 — every authenticated request gets its effective layer
  // set computed exactly once and attached as `c.var.effectiveLayers`.
  // Public routes leave `c.var.user` undefined, so the middleware is a
  // no-op there. Layer-scoped routes (3.4) mount `createRequireLayer()`
  // which reads from `c.var.effectiveLayers` — no double resolver call.
  app.use(
    '*',
    withEffectiveLayers({
      resolver: deps.layerResolver,
    }),
  );

  // `requireAdmin` is mounted on the `/admin/*` prefix only. It runs
  // after `requireAuth` (which already attached `c.var.user`) and after
  // `requirePasswordCurrent`, so the seeded admin must rotate before any
  // admin route lets them through. The middleware factory caches the
  // `admin_group_id` once at construction time — if the seed has not run
  // yet, every admin route returns 503 with `errors.admin.notSeeded`.
  app.use(
    '/admin/*',
    createRequireAdmin({
      db: deps.db,
      resolver: deps.resolver,
    }),
  );

  mountStatusRoute(app, deps);
  mountChatRoute(app, deps);
  registerAuthRoutes(app, {
    bus: deps.bus,
    db: deps.db,
    auth: deps.auth,
    sessions: sessionService,
    resolver: deps.resolver,
  });
  registerAdminGroupsRoutes(app, {
    bus: deps.bus,
    db: deps.db,
    resolver: deps.resolver,
  });
  registerAdminUsersRoutes(app, {
    bus: deps.bus,
    db: deps.db,
    resolver: deps.resolver,
    sessions: sessionService,
  });

  // Phase 3.4 — layer-scoped HTTP surface. Per-route authz lives in
  // `canEditLayer`; there is no router-level admin gate on `/layers/*`.
  registerMeLayersRoute(app);
  registerMeVisibleRoutes(app, { db: deps.db, resolver: deps.resolver });
  registerLayersRoutes(app, {
    bus: deps.bus,
    db: deps.db,
    resolver: deps.resolver,
    layerResolver: deps.layerResolver,
    locales: deps.locales,
  });
  registerSystemLocalesRoute(app, { locales: deps.locales });

  // Phase 4a.1 — companies entity. `registerCompanyModule()` is
  // idempotent per process so `makeTestApp`-driven tests can rebuild
  // the app any number of times without resetting the registry; see
  // `apps/server/src/entities/companies/index.ts`.
  registerCompanyModule();
  mountCompanyRoutes(app, {
    db: deps.db,
    bus: deps.bus,
    llm: deps.llmClient,
  });

  // Phase 4b.1 — contacts entity. Same idempotent registration pattern
  // as companies so `makeTestApp`-driven tests can rebuild the app any
  // number of times without resetting the registry; see
  // `apps/server/src/entities/contacts/index.ts`.
  //
  // Phase 4b.2 — when the caller wires an `ingestDispatcher`, the
  // contacts router mounts `POST /l/:slug/contact/_ingest/:connectorId`
  // for the vCard upload. Tests that drive the contract suite skip the
  // dispatcher and the route is not mounted; production wiring always
  // hands the dispatcher in.
  registerContactModule();
  mountContactRoutes(app, {
    db: deps.db,
    bus: deps.bus,
    llm: deps.llmClient,
    ...(deps.ingestDispatcher === undefined ? {} : { ingestDispatcher: deps.ingestDispatcher }),
    ...(deps.ingestMaxBytes === undefined ? {} : { ingestMaxBytes: deps.ingestMaxBytes }),
    defaultLocale: deps.locales.default,
  });

  // Phase 4c.1 — calendar-event entity. Same idempotent registration
  // pattern as companies / contacts so `makeTestApp`-driven tests can
  // rebuild the app any number of times without resetting the
  // registry; see `apps/server/src/entities/calendar/index.ts`.
  //
  // Phase 4c.2 — production module includes the Google Calendar
  // connector (via `buildProductionCalendarEventModule`). The connector
  // needs a `SecretsService` which is constructed from
  // `BUNNY2_ENCRYPTION_KEY`; absent key → `hasKey === false` and any
  // attempt to encrypt/decrypt fails with `errors.secrets.keyMissing`.
  // Tests pre-register a fixture variant before calling `createApp` —
  // the idempotent `registerCalendarEventModule` short-circuits.
  // The factory build is cheap (no DB / fetch calls); the SecretsService
  // it constructs reads `BUNNY2_ENCRYPTION_KEY` lazily on first use.
  const productionCalendarModule = buildProductionCalendarEventModule();
  // `registerCalendarEventModule` returns whatever ends up registered:
  // the just-built production module the first time, or the
  // pre-registered fixture variant on subsequent calls (tests). The
  // mount path always uses the registered module so the connector
  // visible to the dispatcher matches the one the entity-store inserts
  // through.
  const registeredCalendarModule = registerCalendarEventModule(productionCalendarModule);
  mountCalendarEventRoutes(app, {
    db: deps.db,
    bus: deps.bus,
    llm: deps.llmClient,
    module: registeredCalendarModule,
    ...(deps.ingestDispatcher === undefined ? {} : { ingestDispatcher: deps.ingestDispatcher }),
    ...(deps.ingestMaxBytes === undefined ? {} : { ingestMaxBytes: deps.ingestMaxBytes }),
    defaultLocale: deps.locales.default,
  });

  // Phase 4d.1 — todos entity. Same idempotent registration pattern as
  // companies / contacts / calendar. Cross-kind link validation (a
  // `payload.linkedEntityRef` pointing at a contact or company in the
  // same layer) is enforced by a small per-kind middleware mounted in
  // `mountTodoRoutes` BEFORE `mountEntityRoutes` — keeps the §4.0
  // generic router unaware of cross-kind concerns. See
  // `apps/server/src/entities/todos/validate-link.ts`.
  //
  // Phase 4d.2 — `buildProductionTodoModule()` returns the production
  // module shape. In v1 it carries NO connectors (the
  // `CreateTodoModuleOptions.connectors?` slot exists so a future
  // Trello / Linear / Asana import lands additively). Mirrors the
  // calendar wiring: build → register (idempotent) → mount using the
  // module that ended up in the registry, so tests that pre-register
  // a fixture variant before `createApp` still drive the same module
  // the router mounts against.
  const productionTodoModule = buildProductionTodoModule();
  const registeredTodoModule = registerTodoModule(productionTodoModule);
  mountTodoRoutes(app, {
    db: deps.db,
    bus: deps.bus,
    llm: deps.llmClient,
    module: registeredTodoModule,
  });

  // Phase 5.4 — scheduled-tasks HTTP surface (per-layer CRUD + admin
  // cross-layer overview + admin DLQ). The repo is shared with the
  // in-process scheduler / run-subscriber so a manual run-now hits
  // the same row the tick path would have inserted; `createApp`
  // accepts the repo to support that sharing but builds one on the
  // fly when callers (tests) omit it.
  const scheduledRepo = deps.scheduledRepo ?? createScheduledTasksRepo(deps.db);
  registerScheduledTasksRoutes(app, {
    bus: deps.bus,
    db: deps.db,
    repo: scheduledRepo,
    resolver: deps.resolver,
  });
  registerAdminScheduledTasksRoutes(app, {
    db: deps.db,
    repo: scheduledRepo,
  });
  registerAdminBusRoutes(app, {
    bus: deps.bus,
    db: deps.db,
    ...(deps.replayDlq === undefined ? {} : { replayDlq: deps.replayDlq }),
  });

  // Phase 6.4 — per-layer chat HTTP routes (conversations CRUD +
  // SSE answerer + feedback). `getEntityStore` is built lazily per
  // kind on first call so a kind whose module was registered late
  // (or never) returns `null` cleanly — the retrieval step then
  // marks itself `skipped` for that kind without crashing.
  const llmCallLog = createSqliteLlmCallLog(deps.db);
  const entityStoreCache = new Map<EntityKind, EntityStoreForRetrieval | null>();
  const getEntityStoreForChat = (kind: EntityKind): EntityStoreForRetrieval | null => {
    const cached = entityStoreCache.get(kind);
    if (cached !== undefined) return cached;
    const module = getEntityModule(kind);
    if (module === null) {
      entityStoreCache.set(kind, null);
      return null;
    }
    const store = createGenericEntityStore({
      module: module as EntityModule<unknown>,
      db: deps.db,
      bus: deps.bus,
      llm: deps.llmClient,
    });
    // Adapt the production store to the orchestrator's narrow
    // interface; only `searchSummaries` is needed for retrieval.
    //
    // Phase 7.1 — the adapter consults the LanceDB vector path FIRST
    // (when `deps.vectorSearch` is wired and the helper does not
    // fall back). The vector hits are dehydrated back into entity
    // summaries via the underlying store's `getById`, so the
    // retrieval step sees the same row shape on both paths. On any
    // fallback signal (no embedder, mock embedder, cold corpus,
    // error, vector miss returns `null`) we drop straight to the
    // sync SQLite LIKE path — preserving the phase-6 behaviour
    // byte-for-byte.
    //
    // Auth boundary (`overall.md` §5 invariant 8 / ADR 0021 §1):
    // both paths filter by `layerIds` BEFORE candidate selection.
    // The vector hits carry `layer_id`; we still apply a defensive
    // re-check against `layerIds` so the orchestrator never trusts a
    // single layer of filtering blindly.
    const allowedKinds = new Set<string>([kind]);
    const adapter: EntityStoreForRetrieval = {
      async searchSummaries(layerIds, query, opts) {
        const limit = opts?.limit ?? 50;
        if (deps.vectorSearch !== undefined) {
          const hits = await deps.vectorSearch.searchByKind(kind, layerIds, query, limit);
          if (hits !== null) {
            const allowedLayers = new Set(layerIds);
            const out: Array<{
              readonly id: string;
              readonly kind: string;
              readonly layerId: string;
              readonly slug: string;
              readonly title: string;
              readonly searchableText: string;
            }> = [];
            for (const hit of hits) {
              if (!allowedLayers.has(hit.layer_id)) continue; // defensive
              if (!allowedKinds.has(hit.kind)) continue; // defensive
              const entity = store.getById(hit.id);
              if (entity === null) continue; // hard-deleted
              // `overall.md` §5 invariant 5 — soft-deleted rows must
              // stay invisible. The embedding subscriber removes the
              // LanceDB row on `entity.deleted` (phase-6 contract),
              // but the durable bus's at-least-once delivery leaves a
              // race window between the soft-delete commit and the
              // LanceDB write. The SQLite LIKE path filters
              // `deleted_at IS NULL`; mirror that here so the vector
              // path can never surface a tombstoned row that the LIKE
              // path would hide.
              if (entity.meta.deletedAt !== null) continue;
              out.push({
                id: entity.id,
                kind: entity.kind,
                layerId: entity.layerId,
                slug: entity.slug,
                title: entity.title,
                searchableText: entity.searchableText,
              });
            }
            return out;
          }
        }
        const rows = store.searchSummaries(layerIds, query, opts);
        return rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          layerId: r.layerId,
          slug: r.slug,
          title: r.title,
          searchableText: r.searchableText,
        }));
      },
    };
    entityStoreCache.set(kind, adapter);
    return adapter;
  };
  registerLayerChatRoutes(app, {
    bus: deps.bus,
    db: deps.db,
    llm: deps.llmClient,
    llmCallLog,
    locales: deps.locales,
    getEntityStore: getEntityStoreForChat,
    ...(deps.capabilityRegistry !== undefined
      ? { capabilityRegistry: deps.capabilityRegistry }
      : {}),
  });

  // Phase 7.6 — per-layer proposals + capabilities routes. Wired only
  // when the capability registry is present in deps; test fixtures
  // that don't exercise the proposals surface (most of the existing
  // 6.x tests) omit the registry and these routes silently no-op.
  if (deps.capabilityRegistry !== undefined) {
    registerLayerProposalsRoutes(app, {
      bus: deps.bus,
      db: deps.db,
      llm: deps.llmClient,
      resolver: deps.resolver,
      capabilityRegistry: deps.capabilityRegistry,
      getEntityStore: getEntityStoreForChat,
    });
    registerLayerCapabilitiesRoutes(app, {
      db: deps.db,
      resolver: deps.resolver,
      capabilityRegistry: deps.capabilityRegistry,
    });
    // Phase 8.4 — admin-tunable auto-activation knobs per layer. Wired
    // alongside the proposals + capabilities routes so the settings,
    // proposals, and capabilities surfaces all share the same dep set.
    registerLayerProposalSettingsRoutes(app, {
      bus: deps.bus,
      db: deps.db,
      resolver: deps.resolver,
    });
  }

  // Phase 4d.6 — todo → calendar projection bridge. The READ side is
  // a separate route under the `/calendar/` URL prefix so the
  // calendar UI can fetch projections alongside real events without
  // sniffing for kind discriminators on the entity list. The WRITE
  // side (the subscriber maintaining the `calendar_projection_todos`
  // table) is wired from `index.ts` so it lives for the lifetime of
  // the process — see the connector / enrichment runner precedent.
  // Tests instantiate `createTodoCalendarProjection(...)` directly
  // against their fixture bus + db; production wiring runs once per
  // process.
  mountTodoCalendarProjectionRoutes(app, { db: deps.db });

  return app;
}

export type { AppDeps, StatusBody, HonoVariables } from './types';
