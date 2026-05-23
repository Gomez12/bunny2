import type { Context, Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import type { User as SafeUser } from '@bunny2/shared';
import { ChangePasswordRequestSchema, LoginRequestSchema } from '@bunny2/shared';
import { createUsersRepo, type User as StoredUser } from '../../repos/users-repo';
import { createSessionsRepo } from '../../repos/sessions-repo';
import type { GroupResolver } from '../../auth/group-resolver';
import { dummyVerify, hashPassword, verifyPassword } from '../../auth/password';
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

/**
 * Password-policy floor for end-user-chosen passwords. Plan §4.1 sub-
 * phase 2.3: min 12 chars and at least one non-letter. Documented in
 * the architecture doc — keep these two locations in sync.
 */
const MIN_PASSWORD_LENGTH = 12;
const NON_LETTER = /[^A-Za-z]/;

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

    // Policy floor: ≥ 12 chars AND ≥ 1 non-letter. See architecture doc.
    if (newPassword.length < MIN_PASSWORD_LENGTH || !NON_LETTER.test(newPassword)) {
      return c.json(WEAK_PASSWORD, 400);
    }

    const newHash = await hashPassword(newPassword);
    const nowDate = clock();
    const nowIso = nowDate.toISOString();

    usersRepo.updateUser(stored.id, { passwordHash: newHash, mustChangePassword: false }, nowIso);

    // Revoke ALL OTHER sessions for this user — defensive against a
    // compromised cookie reaching a second device. Keep the current
    // session live so the user does not have to re-login right after
    // rotating. We achieve this by revoking everything, then re-touching
    // the current session is not needed (we revoked siblings, not it).
    revokeAllOtherSessions(deps, user.id, session.id, nowDate);

    await deps.bus.publish({
      type: 'user.password_changed',
      payload: { userId: stored.id },
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
 * Revokes every active session for `userId` EXCEPT `keepSessionId`. The
 * repo only exposes `revokeAllForUser`, so we re-create the keep-alive
 * by reading then revoking. A small race is possible if a brand-new
 * session lands between read and revoke — that session will survive,
 * which is the safe failure mode (it carries the freshly-rotated
 * password's session, so it cannot be the attacker's).
 */
function revokeAllOtherSessions(
  deps: AuthRouteDeps,
  userId: string,
  keepSessionId: string,
  now: Date,
): void {
  // We only need the session list to skip the current one; the repo
  // doesn't expose `listForUser`, so we query directly. Filter on
  // not-revoked + not-expired so we don't pointlessly touch dead rows.
  interface SessionRow {
    id: string;
  }
  const rows = deps.db
    .query<
      SessionRow,
      [string, string]
    >(`SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`)
    .all(userId, now.toISOString());
  for (const { id } of rows) {
    if (id === keepSessionId) continue;
    deps.sessions.revokeSession(id, now);
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
