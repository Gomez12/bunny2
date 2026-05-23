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
// Phase 4.0 — universal entity contract. The factory is imported here so
// the symbol is reachable from `apps/server/src/http/router.ts` and
// future per-kind sub-phases (4a..4d) can wire their concrete modules
// without touching the import graph again. Intentionally NOT called in
// 4.0 — no entity kind is registered yet.
import { mountEntityRoutes as _mountEntityRoutes } from '../entities';
void _mountEntityRoutes;

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

  return app;
}

export type { AppDeps, StatusBody, HonoVariables } from './types';
