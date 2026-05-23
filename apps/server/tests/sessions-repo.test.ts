import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase } from '../src/storage/sqlite';
import { createSessionsRepo } from '../src/repos/sessions-repo';
import { createUsersRepo } from '../src/repos/users-repo';

function mkRepos() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-sessions-'));
  const db = openDatabase(dir);
  const users = createUsersRepo(db);
  const sessions = createSessionsRepo(db);
  const userId = crypto.randomUUID();
  users.createUser({
    id: userId,
    username: 'alice',
    displayName: 'Alice',
    passwordHash: 'h',
    mustChangePassword: false,
    now: new Date().toISOString(),
  });
  return { db, sessions, userId };
}

describe('sessions-repo', () => {
  it('creates a session and finds it by token hash', () => {
    const { db, sessions, userId } = mkRepos();
    try {
      const created = sessions.createSession({
        id: crypto.randomUUID(),
        userId,
        tokenHash: 'th-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      expect(created.userId).toBe(userId);
      const found = sessions.findSessionByTokenHash('th-1', '2026-01-02T00:00:00.000Z');
      expect(found?.id).toBe(created.id);
    } finally {
      db.close();
    }
  });

  it('returns null when the session has expired', () => {
    const { db, sessions, userId } = mkRepos();
    try {
      sessions.createSession({
        id: crypto.randomUUID(),
        userId,
        tokenHash: 'th-2',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-02T00:00:00.000Z',
      });
      expect(sessions.findSessionByTokenHash('th-2', '2026-01-03T00:00:00.000Z')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('touchSession updates last_seen_at', () => {
    const { db, sessions, userId } = mkRepos();
    try {
      const s = sessions.createSession({
        id: crypto.randomUUID(),
        userId,
        tokenHash: 'th-3',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      sessions.touchSession(s.id, '2026-02-01T00:00:00.000Z');
      const found = sessions.findSessionByTokenHash('th-3', '2026-02-02T00:00:00.000Z');
      expect(found?.lastSeenAt).toBe('2026-02-01T00:00:00.000Z');
    } finally {
      db.close();
    }
  });

  it('revokeSession makes find return null', () => {
    const { db, sessions, userId } = mkRepos();
    try {
      const s = sessions.createSession({
        id: crypto.randomUUID(),
        userId,
        tokenHash: 'th-4',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      sessions.revokeSession(s.id, '2026-01-02T00:00:00.000Z');
      expect(sessions.findSessionByTokenHash('th-4', '2026-01-03T00:00:00.000Z')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('revokeAllForUser revokes every session for that user', () => {
    const { db, sessions, userId } = mkRepos();
    try {
      sessions.createSession({
        id: crypto.randomUUID(),
        userId,
        tokenHash: 'th-5a',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      sessions.createSession({
        id: crypto.randomUUID(),
        userId,
        tokenHash: 'th-5b',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      sessions.revokeAllForUser(userId, '2026-01-02T00:00:00.000Z');
      const now = '2026-01-03T00:00:00.000Z';
      expect(sessions.findSessionByTokenHash('th-5a', now)).toBeNull();
      expect(sessions.findSessionByTokenHash('th-5b', now)).toBeNull();
      expect(sessions.countActiveSessions(now)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('pruneExpired removes only expired or week-old revoked rows', () => {
    const { db, sessions, userId } = mkRepos();
    try {
      // Live session — must survive.
      sessions.createSession({
        id: crypto.randomUUID(),
        userId,
        tokenHash: 'live',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      // Expired session — must be removed.
      sessions.createSession({
        id: crypto.randomUUID(),
        userId,
        tokenHash: 'expired',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-02T00:00:00.000Z',
      });
      // Recently-revoked session — must survive prune (revoked < 7 days ago).
      const recentRevoked = sessions.createSession({
        id: crypto.randomUUID(),
        userId,
        tokenHash: 'revoked-recent',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      sessions.revokeSession(recentRevoked.id, '2026-02-01T00:00:00.000Z');
      // Old revoked session — must be removed (revoked > 7 days before now).
      const oldRevoked = sessions.createSession({
        id: crypto.randomUUID(),
        userId,
        tokenHash: 'revoked-old',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      sessions.revokeSession(oldRevoked.id, '2026-01-10T00:00:00.000Z');

      const removed = sessions.pruneExpired('2026-02-01T00:00:00.000Z');
      // The expired one + the old-revoked one.
      expect(removed).toBe(2);
      // Live one and recent-revoked one survive.
      const now = '2026-02-01T00:00:00.000Z';
      expect(sessions.findSessionByTokenHash('live', now)?.tokenHash).toBe('live');
      expect(sessions.findSessionByTokenHash('expired', now)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('countActiveSessions excludes revoked and expired', () => {
    const { db, sessions, userId } = mkRepos();
    try {
      const live = sessions.createSession({
        id: crypto.randomUUID(),
        userId,
        tokenHash: 'a',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      sessions.createSession({
        id: crypto.randomUUID(),
        userId,
        tokenHash: 'b',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-02T00:00:00.000Z',
      });
      const r = sessions.createSession({
        id: crypto.randomUUID(),
        userId,
        tokenHash: 'c',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      sessions.revokeSession(r.id, '2026-01-02T00:00:00.000Z');
      void live;
      expect(sessions.countActiveSessions('2026-01-03T00:00:00.000Z')).toBe(1);
    } finally {
      db.close();
    }
  });
});
