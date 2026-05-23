import type { Context, MiddlewareHandler } from 'hono';
import type { User as SafeUser } from '@bunny2/shared';
import type { Session } from '../../repos/sessions-repo';
import type { SessionService } from '../../auth/sessions';
import { readSessionCookie } from '../../auth/cookie';

/**
 * Shape attached to `c.var` by `createAuthMiddleware` after a
 * successful resolve. The router types this via `Hono<{ Variables }>`
 * (see `http/types.ts`) so route handlers can read it without casts.
 */
export interface AuthContext {
  readonly session: Session;
  readonly user: SafeUser;
}

export interface CreateAuthMiddlewareOptions {
  readonly sessions: SessionService;
  readonly idleMinutes: number;
  /**
   * Allowlist of public route tuples in the form `"METHOD path"`
   * (e.g. `"GET /status"`). 2.3 will add the auth endpoints; the set
   * is exported so callers can extend it without modifying this file.
   */
  readonly publicPaths: ReadonlySet<string>;
  /**
   * Override for tests that need a deterministic clock. Production
   * leaves this undefined so each request uses `new Date()`.
   */
  readonly clock?: () => Date;
  /**
   * Sink for background `touchSession` failures. Production wires
   * `console.error`; tests can swap a no-op or a capturing array.
   */
  readonly onBackgroundError?: (err: unknown) => void;
}

/**
 * Public route set used by the server. Exported so 2.3 (auth routes)
 * can extend it from the route module without editing this file.
 *
 * The tuple `"OPTIONS *"` is special-cased by the middleware so any
 * CORS preflight short-circuits before auth runs. `cors.ts` also
 * handles OPTIONS, but defence in depth keeps the order observable.
 */
export const DEFAULT_PUBLIC_PATHS: ReadonlySet<string> = new Set<string>([
  'GET /status',
  // 2.3 wires the actual login/logout handlers; the middleware is
  // already aware of the paths so cross-file ordering does not bite us.
  'POST /auth/login',
  'POST /auth/logout',
]);

const UNAUTHORIZED_BODY = { error: 'errors.auth.unauthorized' } as const;

/**
 * Builds the auth middleware.
 *
 * On every request:
 *
 *  1. Short-circuit `OPTIONS` (CORS preflight) — CORS middleware has
 *     already answered; auth must not 401 a browser preflight.
 *  2. Short-circuit public routes via the `"METHOD path"` set.
 *  3. Extract a token from `Authorization: Bearer` (preferred) or the
 *     `bunny2_session` cookie.
 *  4. Resolve via `SessionService.resolveSession`. On failure → 401
 *     with the i18n key `errors.auth.unauthorized`.
 *  5. On success: stash `{ session, user }` on the context, schedule a
 *     non-blocking `touchSession`, and call `next()`.
 *
 * Background-touch policy: we schedule the touch via
 * `c.executionCtx?.waitUntil` when available (workers, some runtimes),
 * and fall back to a fire-and-forget `Promise` whose rejection is
 * routed through `onBackgroundError`. Bun's plain `Bun.serve({ fetch })`
 * does not expose `executionCtx`, so the fallback is what runs in
 * production today. The touch is intentionally not awaited — the
 * resolve already accepted the session, and the next request will
 * read the fresh `last_seen_at`.
 */
export function createAuthMiddleware(opts: CreateAuthMiddlewareOptions): MiddlewareHandler {
  const onError = opts.onBackgroundError ?? defaultBackgroundErrorSink;
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') {
      // CORS middleware (registered first) has already produced 204;
      // we still tolerate OPTIONS reaching us by skipping auth.
      await next();
      return;
    }
    if (opts.publicPaths.has(`${c.req.method} ${c.req.path}`)) {
      await next();
      return;
    }

    const token = extractToken(c);
    if (token === null) {
      return c.json(UNAUTHORIZED_BODY, 401);
    }

    const now = (opts.clock ?? (() => new Date()))();
    const resolved = opts.sessions.resolveSession({
      token,
      now,
      idleMinutes: opts.idleMinutes,
    });
    if (resolved === null) {
      return c.json(UNAUTHORIZED_BODY, 401);
    }

    c.set('session', resolved.session);
    c.set('user', resolved.user);

    scheduleTouch(c, opts.sessions, resolved.session.id, now, onError);
    await next();
    return;
  };
}

function extractToken(c: Context): string | null {
  const header = c.req.header('authorization');
  if (header !== undefined) {
    // RFC 6750: scheme is case-insensitive. We accept `Bearer` plus
    // anything that case-folds to it, then take the rest verbatim.
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match !== null && match[1] !== undefined && match[1].length > 0) {
      return match[1];
    }
    // An `Authorization` header was present but not a usable Bearer:
    // fall through to the cookie so a misconfigured proxy header
    // doesn't lock out browser clients.
  }
  return readSessionCookie(c);
}

function scheduleTouch(
  c: Context,
  sessions: SessionService,
  sessionId: string,
  now: Date,
  onError: (err: unknown) => void,
): void {
  // `executionCtx` is present on edge/worker runtimes; Hono throws on
  // access when it is absent (e.g. plain `Bun.serve({ fetch })` and
  // in-process `app.fetch(...)` in tests). Detect via try/catch — there
  // is no public boolean to ask "do you have one?".
  const touch = (): Promise<void> =>
    Promise.resolve().then(() => sessions.touchSession(sessionId, now));
  try {
    const ctx = (
      c as Context & {
        executionCtx?: { waitUntil?: (p: Promise<unknown>) => void };
      }
    ).executionCtx;
    if (ctx !== undefined && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(touch().catch(onError));
      return;
    }
  } catch {
    // No executionCtx in this runtime — fall through to fire-and-forget.
  }
  // Fire-and-forget — never awaited. We catch so an unhandled
  // rejection cannot crash the process.
  void touch().catch(onError);
}

function defaultBackgroundErrorSink(err: unknown): void {
  console.error('[auth-middleware] background touchSession failed:', err);
}
