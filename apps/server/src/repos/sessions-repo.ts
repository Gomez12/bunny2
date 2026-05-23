import type { Database } from 'bun:sqlite';

/**
 * Persisted session row, mirroring `sessions` in 0002_users_groups.sql.
 *
 * Note: `tokenHash` is the SHA-256 (hex) of the plaintext token. The
 * plaintext only ever lives in the cookie / Authorization header. A leaked
 * database snapshot therefore cannot be used for replay.
 */
export interface Session {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface CreateSessionInput {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface SessionsRepo {
  createSession(input: CreateSessionInput): Session;
  /** Returns null if the session is revoked, expired, or absent. */
  findSessionByTokenHash(tokenHash: string, now: string): Session | null;
  touchSession(id: string, lastSeenAt: string): void;
  revokeSession(id: string, revokedAt: string): void;
  revokeAllForUser(userId: string, revokedAt: string): void;
  /**
   * Lists every still-active (non-revoked, non-expired) session id for
   * `userId`. Used by the session service to capture the set of sessions
   * BEFORE a bulk revoke, so it can publish `session.expired` rows with
   * the correct ids.
   */
  listActiveSessionIdsForUser(userId: string, now: string): string[];
  /**
   * Deletes rows where `expires_at < now` or where `revoked_at` is older
   * than 7 days. Returns the number of rows deleted.
   */
  pruneExpired(now: string): number;
  /** Count of non-revoked, non-expired sessions. */
  countActiveSessions(now: string): number;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function createSessionsRepo(db: Database): SessionsRepo {
  const insert = db.query<unknown, [string, string, string, string, string, string]>(
    `INSERT INTO sessions
       (id, user_id, token_hash, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const findById = db.query<SessionRow, [string]>(
    `SELECT id, user_id, token_hash, created_at, last_seen_at, expires_at, revoked_at
       FROM sessions WHERE id = ?`,
  );

  // Filter expired/revoked in SQL — the auth middleware in 2.2 must not see
  // dead sessions slip through.
  const findActive = db.query<SessionRow, [string, string]>(
    `SELECT id, user_id, token_hash, created_at, last_seen_at, expires_at, revoked_at
       FROM sessions
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
  );

  const touch = db.query<unknown, [string, string]>(
    `UPDATE sessions SET last_seen_at = ? WHERE id = ?`,
  );

  const revoke = db.query<unknown, [string, string]>(
    `UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
  );

  const revokeAll = db.query<unknown, [string, string]>(
    `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
  );

  const prune = db.query<unknown, [string, string]>(
    `DELETE FROM sessions
      WHERE expires_at < ?
         OR (revoked_at IS NOT NULL AND revoked_at < ?)`,
  );

  const countActive = db.query<{ n: number }, [string]>(
    `SELECT COUNT(*) AS n FROM sessions
      WHERE revoked_at IS NULL AND expires_at > ?`,
  );

  const countAll = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM sessions');

  const listActiveForUser = db.query<{ id: string }, [string, string]>(
    `SELECT id FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY created_at`,
  );

  return {
    createSession(input) {
      insert.run(
        input.id,
        input.userId,
        input.tokenHash,
        input.createdAt,
        input.createdAt,
        input.expiresAt,
      );
      const row = findById.get(input.id);
      if (row === null) {
        throw new Error(`sessions-repo: failed to read back session ${input.id} after insert`);
      }
      return rowToSession(row);
    },
    findSessionByTokenHash(tokenHash, now) {
      const row = findActive.get(tokenHash, now);
      return row === null ? null : rowToSession(row);
    },
    touchSession(id, lastSeenAt) {
      touch.run(lastSeenAt, id);
    },
    revokeSession(id, revokedAt) {
      revoke.run(revokedAt, id);
    },
    revokeAllForUser(userId, revokedAt) {
      revokeAll.run(revokedAt, userId);
    },
    listActiveSessionIdsForUser(userId, now) {
      return listActiveForUser.all(userId, now).map((r) => r.id);
    },
    pruneExpired(now) {
      const before = countAll.get()?.n ?? 0;
      const cutoff = new Date(new Date(now).getTime() - SEVEN_DAYS_MS).toISOString();
      prune.run(now, cutoff);
      const after = countAll.get()?.n ?? 0;
      return Math.max(0, before - after);
    },
    countActiveSessions(now) {
      return countActive.get(now)?.n ?? 0;
    },
  };
}
