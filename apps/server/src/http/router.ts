import { Hono } from 'hono';
import type { AppDeps, HonoVariables } from './types';
import { createDevCors } from './cors';
import { createAuthMiddleware, DEFAULT_PUBLIC_PATHS } from './middleware/auth';
import { createSessionService } from '../auth/sessions';
import { createSessionsRepo } from '../repos/sessions-repo';
import { createUsersRepo } from '../repos/users-repo';
import { mountStatusRoute } from './routes/status';
import { mountChatRoute } from './routes/chat';

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
  const sessionService = createSessionService({ sessions: sessionsRepo, users: usersRepo });

  app.use('*', createDevCors());
  app.use(
    '*',
    createAuthMiddleware({
      sessions: sessionService,
      idleMinutes: deps.auth.sessionIdleMinutes,
      publicPaths: DEFAULT_PUBLIC_PATHS,
    }),
  );

  mountStatusRoute(app, deps);
  mountChatRoute(app, deps);
  return app;
}

export type { AppDeps, StatusBody, HonoVariables } from './types';
