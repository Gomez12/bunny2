import type { User as SafeUser } from '@bunny2/shared';
import type { Session, SessionsRepo } from '../repos/sessions-repo';
import type { UsersRepo, User as StoredUser } from '../repos/users-repo';
import { generateSessionToken, hashSessionToken } from './session-token';

/**
 * Session service — high-level wrapper over `sessions-repo` and the
 * token primitives. Pure logic, no Hono coupling. The HTTP layer
 * (cookie helpers + auth middleware in 2.2; login/logout in 2.3)
 * consumes this surface.
 *
 * ADR `0008-session-strategy.md` records why we use opaque tokens
 * (hashed at rest) instead of JWT.
 */

export interface CreateSessionInput {
  readonly userId: string;
  readonly ttlMinutes: number;
  readonly idleMinutes: number;
  /** Override the wall clock for tests. Defaults to `new Date()`. */
  readonly now?: Date;
}

export interface CreateSessionResult {
  readonly session: Session;
  /** Plaintext token. Goes into the cookie / Authorization header. NEVER log it. */
  readonly token: string;
}

export interface ResolveSessionInput {
  readonly token: string;
  readonly now: Date;
  readonly idleMinutes: number;
}

export interface ResolveSessionResult {
  readonly session: Session;
  readonly user: SafeUser;
}

export interface SessionService {
  createSession(input: CreateSessionInput): CreateSessionResult;
  /**
   * Resolves a plaintext token to a `{ session, user }` pair, or `null`
   * if the token is unknown, the session is expired/revoked, the idle
   * window has elapsed, or the owning user has been soft-deleted.
   *
   * The service is pure: it does NOT touch `last_seen_at`. The caller
   * (auth middleware) decides when to touch a freshly-resolved session.
   */
  resolveSession(input: ResolveSessionInput): ResolveSessionResult | null;
  touchSession(sessionId: string, now: Date): void;
  revokeSession(sessionId: string, now: Date): void;
  revokeAllForUser(userId: string, now: Date): void;
}

export interface CreateSessionServiceDeps {
  readonly sessions: SessionsRepo;
  readonly users: UsersRepo;
}

/**
 * Build a `SessionService` over the given repositories. Idempotent —
 * call once at server boot, share the result.
 */
export function createSessionService(deps: CreateSessionServiceDeps): SessionService {
  return {
    createSession({ userId, ttlMinutes, idleMinutes: _idleMinutes, now }) {
      const issuedAt = now ?? new Date();
      const token = generateSessionToken();
      const tokenHash = hashSessionToken(token);
      const expiresAt = new Date(issuedAt.getTime() + ttlMinutes * 60_000);
      const session = deps.sessions.createSession({
        id: crypto.randomUUID(),
        userId,
        tokenHash,
        createdAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
      return { session, token };
    },

    resolveSession({ token, now, idleMinutes }) {
      const tokenHash = hashSessionToken(token);
      const nowIso = now.toISOString();
      // The repo already filters revoked + absolute-expired rows.
      const session = deps.sessions.findSessionByTokenHash(tokenHash, nowIso);
      if (session === null) {
        return null;
      }

      // Soft idle expiry — bus separation: the service decides "yes/no"
      // and returns null; it does NOT touch the row. The middleware
      // calls `touchSession` only after a successful resolve.
      const lastSeenMs = new Date(session.lastSeenAt).getTime();
      const idleMs = idleMinutes * 60_000;
      if (now.getTime() - lastSeenMs > idleMs) {
        return null;
      }

      const stored: StoredUser | null = deps.users.findUserById(session.userId);
      if (stored === null) {
        return null;
      }
      // Phase-02 plan §11.5: soft-deleted users cannot authenticate;
      // their open sessions are dead on arrival.
      if (stored.deletedAt !== null) {
        return null;
      }

      const safe: SafeUser = toSafeUser(stored);
      return { session, user: safe };
    },

    touchSession(sessionId, now) {
      deps.sessions.touchSession(sessionId, now.toISOString());
    },

    revokeSession(sessionId, now) {
      deps.sessions.revokeSession(sessionId, now.toISOString());
    },

    revokeAllForUser(userId, now) {
      deps.sessions.revokeAllForUser(userId, now.toISOString());
    },
  };
}

/**
 * Project the server-internal `User` (which carries `passwordHash`) to
 * the cross-boundary shape declared in `@bunny2/shared`. Used by the
 * session service so no caller of `resolveSession` ever sees the hash.
 */
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
