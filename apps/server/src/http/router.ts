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
import { registerLayersRoutes } from './routes/layers';
import { registerSystemLocalesRoute } from './routes/system-locales';
// Phase 4a.1 — first concrete entity kind. Each per-kind sub-phase
// (4a..4d) registers its module and mounts its routes via a small
// helper exported from `apps/server/src/entities/<kind>/index.ts`.
import { mountCompanyRoutes, registerCompanyModule } from '../entities/companies';
import { mountContactRoutes, registerContactModule } from '../entities/contacts';
import { mountCalendarEventRoutes, registerCalendarEventModule } from '../entities/calendar';

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
  // registry; see `apps/server/src/entities/calendar/index.ts`. No
  // connector / enrichment / stats provider in 4c.1 — those land in
  // 4c.2 / 4c.3 / 4c.4 respectively.
  registerCalendarEventModule();
  mountCalendarEventRoutes(app, {
    db: deps.db,
    bus: deps.bus,
    llm: deps.llmClient,
  });

  return app;
}

export type { AppDeps, StatusBody, HonoVariables } from './types';
