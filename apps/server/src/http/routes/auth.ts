import type { Context, Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import type { User as SafeUser } from '@bunny2/shared';
import { ChangePasswordRequestSchema, LoginRequestSchema } from '@bunny2/shared';
import { createUsersRepo, type User as StoredUser } from '../../repos/users-repo';
import { createSessionsRepo } from '../../repos/sessions-repo';
import type { GroupResolver } from '../../auth/group-resolver';
import { dummyVerify, hashPassword, verifyPassword } from '../../auth/password';
import { validateNewPassword } from '../../auth/password-policy';
import { clearSessionCookie, cookieSecureDefault, setSessionCookie } from '../../auth/cookie';
import { readSessionCookie } from '../../auth/cookie';
import { hashSessionToken } from '../../auth/session-token';
import type { SessionService } from '../../auth/sessions';
import { ADMIN_GROUP_ID_KEY } from '../../auth/seed';
import { getMeta } from '../../storage/kv-meta';
import type { AuthConfig } from '../../config/schema';
import type { HonoVariables } from '../types';

/**
 * Wires `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`,
 * `POST /auth/password`.
 *
 * - `/login` and `/logout` are public (whitelisted in `DEFAULT_PUBLIC_PATHS`).
 * - `/me` and `/password` sit behind `requireAuth` (default).
 * - The `mustChangePassword` gate (registered globally in `router.ts`)
 *   intercepts protected routes EXCEPT `/auth/password` and
 *   `/auth/logout` when the user still needs to rotate. That gating
 *   lives in `http/middleware/password-gate.ts` — not here — so the
 *   business logic in this file is the same for both states.
 *
 * Telemetry: every handler mints a fresh `correlationId` (UUID v4) and
 * threads it through every `bus.publish` it performs, mirroring the
 * `/chat` route. The telemetry middleware persists each event to the
 * `events` table on the way in, so even if a publish handler throws,
 * the event is captured.
 *
 * Anti-enumeration: `/login` returns the same response shape (401 with
 * `errors.auth.invalidCredentials`) for unknown username, soft-deleted
 * user, and wrong password. The `dummyVerify` call equalises timing
 * across the three branches so an attacker cannot probe usernames by
 * watching response latency.
 *
 * Token transport: a successful login sets the session cookie. The
 * plaintext token is NOT echoed in the JSON body. Non-browser clients
 * (smoke tests, CLI tools) can read the cookie out of the `Set-Cookie`
 * response header and re-send it on subsequent requests, or use the
 * cookie value as a Bearer token — both paths are accepted by
 * `createAuthMiddleware`. Rationale: a JSON-bound token has surface
 * area in browser-extension exfiltration we do not need to take on
 * for the web UI, and we keep the cookie + Bearer contract symmetric
 * in `docs/dev/architecture/auth-and-sessions.md`.
 */

export interface AuthRouteDeps {
  readonly bus: MessageBus;
  readonly db: Database;
  readonly auth: AuthConfig;
  readonly sessions: SessionService;
  readonly resolver: GroupResolver;
  readonly cookieSecure?: boolean;
  readonly now?: () => Date;
}

const INVALID_CREDENTIALS = { error: 'errors.auth.invalidCredentials' } as const;
const WEAK_PASSWORD = { error: 'errors.auth.weakPassword' } as const;
const INVALID_CURRENT_PASSWORD = { error: 'errors.auth.invalidCurrentPassword' } as const;
const BAD_REQUEST = { error: 'errors.auth.badRequest' } as const;

export function registerAuthRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: AuthRouteDeps,
): void {
  const usersRepo = createUsersRepo(deps.db);
  const sessionsRepo = createSessionsRepo(deps.db);
  const cookieSecure = deps.cookieSecure ?? cookieSecureDefault();
  const clock = deps.now ?? (() => new Date());

  // ---------- POST /auth/login -------------------------------------------

  app.post('/auth/login', async (c) => {
    const correlationId = crypto.randomUUID();

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(BAD_REQUEST, 400);
    }
    const parsed = LoginRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(BAD_REQUEST, 400);
    }
    const { username, password } = parsed.data;

    const stored = usersRepo.findUserByUsername(username);

    // Branch 1 — unknown username. Burn argon2 CPU so the response time
    // matches the "real verify" path, then publish + 401.
    if (stored === null) {
      await dummyVerify();
      await deps.bus.publish({
        type: 'user.login.failed',
        // Forensic note: we log the attempted username, never the password.
        payload: { username, reason: 'unknown_user' },
        correlationId,
      });
      return c.json(INVALID_CREDENTIALS, 401);
    }

    // Branch 2 — user exists but is soft-deleted.
    if (stored.deletedAt !== null) {
      await dummyVerify();
      await deps.bus.publish({
        type: 'user.login.failed',
        payload: { userId: stored.id, reason: 'soft_deleted' },
        correlationId,
      });
      return c.json(INVALID_CREDENTIALS, 401);
    }

    // Branch 3 — wrong password.
    const ok = await verifyPassword(password, stored.passwordHash);
    if (!ok) {
      await deps.bus.publish({
        type: 'user.login.failed',
        payload: { userId: stored.id, reason: 'wrong_password' },
        correlationId,
      });
      return c.json(INVALID_CREDENTIALS, 401);
    }

    // Branch 4 — success.
    const now = clock();
    const { session, token } = deps.sessions.createSession({
      userId: stored.id,
      ttlMinutes: deps.auth.sessionTtlMinutes,
      idleMinutes: deps.auth.sessionIdleMinutes,
      now,
    });

    setSessionCookie(c, token, {
      ttlMinutes: deps.auth.sessionTtlMinutes,
      secure: cookieSecure,
    });

    await deps.bus.publish({
      type: 'session.created',
      payload: {
        sessionId: session.id,
        userId: stored.id,
        expiresAt: session.expiresAt,
      },
      correlationId,
    });
    await deps.bus.publish({
      type: 'user.login.succeeded',
      payload: {
        userId: stored.id,
        sessionId: session.id,
      },
      correlationId,
    });

    return c.json({
      user: toSafeUser(stored),
      mustChangePassword: stored.mustChangePassword,
      sessionExpiresAt: session.expiresAt,
    });
  });

  // ---------- POST /auth/logout ------------------------------------------

  app.post('/auth/logout', async (c) => {
    const correlationId = crypto.randomUUID();
    const token = extractToken(c);

    if (token !== null) {
      const tokenHash = hashSessionToken(token);
      // We resolve via the raw repo here (not the service) because we
      // need to look up by token hash regardless of `last_seen_at` idle
      // state — a still-active-but-stale session is exactly the case
      // logout exists for. The repo filter excludes only fully expired
      // or revoked rows; if the token is already dead, there is no
      // session-lifecycle event to emit and we still clear the cookie.
      const nowIso = clock().toISOString();
      const session = sessionsRepo.findSessionByTokenHash(tokenHash, nowIso);
      if (session !== null) {
        deps.sessions.revokeSession(session.id, clock());
        await deps.bus.publish({
          type: 'session.expired',
          payload: {
            sessionId: session.id,
            userId: session.userId,
            reason: 'logout',
          },
          correlationId,
        });
      }
    }

    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  // ---------- GET /auth/me -----------------------------------------------

  app.get('/auth/me', (c) => {
    const user = c.get('user');
    const session = c.get('session');
    if (user === undefined || session === undefined) {
      // requireAuth should have rejected this before we got here; if
      // it didn't, fall through with a 401 so we never leak `null`.
      return c.json(INVALID_CREDENTIALS, 401);
    }

    // Phase 2.4 isAdmin rule: transitive membership via the resolver.
    // The resolver walks `user_group_memberships` then
    // `group_group_memberships` upward, so a user inherited via a
    // sub-group (e.g. `engineering` is a child of `admin`) resolves as
    // admin. If the seed has not run, `adminGroupId` is null/empty and
    // the answer is unambiguously `false`.
    const adminGroupId = getMeta(deps.db, ADMIN_GROUP_ID_KEY);
    const isAdmin =
      adminGroupId !== null && adminGroupId !== ''
        ? deps.resolver.isUserInGroup(user.id, adminGroupId)
        : false;

    return c.json({
      user,
      mustChangePassword: user.mustChangePassword,
      isAdmin,
      sessionExpiresAt: session.expiresAt,
    });
  });

  // ---------- POST /auth/password ----------------------------------------

  app.post('/auth/password', async (c) => {
    const correlationId = crypto.randomUUID();

    const user = c.get('user');
    const session = c.get('session');
    if (user === undefined || session === undefined) {
      return c.json(INVALID_CREDENTIALS, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(BAD_REQUEST, 400);
    }
    const parsed = ChangePasswordRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(BAD_REQUEST, 400);
    }
    const { currentPassword, newPassword } = parsed.data;

    // Re-read the stored user to fetch the hash (we never put it on the
    // safe `c.var.user`). The repo lookup also catches a freshly-soft-
    // deleted user between resolveSession and this handler.
    const stored = usersRepo.findUserById(user.id);
    if (stored === null || stored.deletedAt !== null) {
      return c.json(INVALID_CREDENTIALS, 401);
    }

    // currentPassword is required UNLESS the user is in the must-change
    // state (in which case the valid session is the proof-of-presence).
    if (!stored.mustChangePassword) {
      if (currentPassword === undefined) {
        return c.json(INVALID_CURRENT_PASSWORD, 400);
      }
      const ok = await verifyPassword(currentPassword, stored.passwordHash);
      if (!ok) {
        return c.json(INVALID_CURRENT_PASSWORD, 400);
      }
    }

    // Policy floor — shared with the admin reset endpoint via
    // `validateNewPassword`. Rejection key is `errors.auth.weakPassword`.
    const policy = validateNewPassword(newPassword);
    if (!policy.ok) {
      return c.json(WEAK_PASSWORD, 400);
    }

    const newHash = await hashPassword(newPassword);
    const nowDate = clock();
    const nowIso = nowDate.toISOString();

    usersRepo.updateUser(stored.id, { passwordHash: newHash, mustChangePassword: false }, nowIso);

    // Revoke ALL OTHER sessions for this user — defensive against a
    // compromised cookie reaching a second device. We keep the current
    // session live by skipping it in the per-row revocation loop and
    // publish a `session.expired { reason: 'self_password_change' }`
    // event per revoked sibling. We do NOT call the bulk
    // `revokeAllForUser` helper here because the per-row "skip the
    // current session" rule is unique to self-rotation.
    await revokeOtherSessions(deps, user.id, session.id, nowDate, correlationId);

    await deps.bus.publish({
      type: 'user.password_changed',
      payload: { userId: stored.id, by: stored.id, forced: false },
      correlationId,
    });

    return c.json({ ok: true });
  });
}

/**
 * Same extraction logic as the auth middleware — duplicated tiny helper so
 * the logout handler can read the token on a public route (the middleware
 * is bypassed for `POST /auth/logout`).
 */
function extractToken(c: Context): string | null {
  const header = c.req.header('authorization');
  if (header !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match !== null && match[1] !== undefined && match[1].length > 0) {
      return match[1];
    }
  }
  return readSessionCookie(c);
}

/**
 * Revokes every active session for `userId` EXCEPT `keepSessionId` and
 * publishes a `session.expired { reason: 'self_password_change' }` event
 * per revoked row. The per-row variant exists because the bulk
 * `revokeAllForUser` helper has no "keep one alive" knob — self-rotation
 * is the only call site with that need.
 *
 * Race note: a brand-new session that lands between the read and the
 * revoke will survive. That is the safe failure mode — the new session
 * already carries the rotated password's authority, so it cannot be the
 * attacker's.
 */
async function revokeOtherSessions(
  deps: AuthRouteDeps,
  userId: string,
  keepSessionId: string,
  now: Date,
  correlationId: string,
): Promise<void> {
  const sessionsRepo = createSessionsRepo(deps.db);
  const ids = sessionsRepo.listActiveSessionIdsForUser(userId, now.toISOString());
  for (const id of ids) {
    if (id === keepSessionId) continue;
    deps.sessions.revokeSession(id, now);
    await deps.bus.publish({
      type: 'session.expired',
      payload: { sessionId: id, userId, reason: 'self_password_change' },
      correlationId,
    });
  }
}

function toSafeUser(stored: StoredUser): SafeUser {
  return {
    id: stored.id,
    username: stored.username,
    displayName: stored.displayName,
    mustChangePassword: stored.mustChangePassword,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    deletedAt: stored.deletedAt,
    version: stored.version,
  };
}
