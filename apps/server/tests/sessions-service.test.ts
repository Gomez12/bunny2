import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type BusEvent } from '@bunny2/bus';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import { openDatabase } from '../src/storage/sqlite';
import { createSessionsRepo } from '../src/repos/sessions-repo';
import { createUsersRepo } from '../src/repos/users-repo';
import { createSessionService } from '../src/auth/sessions';

interface Fixture {
  readonly db: ReturnType<typeof openDatabase>;
  readonly service: ReturnType<typeof createSessionService>;
  readonly userId: string;
}

function mkFixture(opts: { mustChangePassword?: boolean } = {}): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-sessions-service-'));
  const db = openDatabase(dir);
  const users = createUsersRepo(db);
  const sessions = createSessionsRepo(db);
  const service = createSessionService({ sessions, users });
  const userId = crypto.randomUUID();
  users.createUser({
    id: userId,
    username: 'alice',
    displayName: 'Alice',
    passwordHash: 'h',
    mustChangePassword: opts.mustChangePassword === true,
    now: new Date().toISOString(),
  });
  return { db, service, userId };
}

describe('session service', () => {
  it('createSession returns a plaintext token plus a persisted session row', () => {
    const { db, service, userId } = mkFixture();
    try {
      const result = service.createSession({
        userId,
        ttlMinutes: 60,
        idleMinutes: 30,
        now: new Date('2026-05-23T10:00:00.000Z'),
      });
      expect(result.token).toBeTruthy();
      expect(result.token.length).toBeGreaterThan(20);
      expect(result.session.userId).toBe(userId);
      expect(result.session.expiresAt).toBe('2026-05-23T11:00:00.000Z');
    } finally {
      db.close();
    }
  });

  it('resolveSession returns the safe user shape (no passwordHash) when the token is valid', () => {
    const { db, service, userId } = mkFixture();
    try {
      const { token } = service.createSession({
        userId,
        ttlMinutes: 60,
        idleMinutes: 30,
        now: new Date('2026-05-23T10:00:00.000Z'),
      });
      const resolved = service.resolveSession({
        token,
        now: new Date('2026-05-23T10:05:00.000Z'),
        idleMinutes: 30,
      });
      expect(resolved).not.toBeNull();
      expect(resolved?.user.id).toBe(userId);
      // The shared User type does not expose passwordHash; the runtime
      // shape must match. We explicitly assert the field is absent so
      // a future refactor cannot leak the hash through this seam.
      expect((resolved?.user as { passwordHash?: unknown }).passwordHash).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('resolveSession rejects after the absolute TTL elapses', () => {
    const { db, service, userId } = mkFixture();
    try {
      const { token } = service.createSession({
        userId,
        ttlMinutes: 10,
        idleMinutes: 60,
        now: new Date('2026-05-23T10:00:00.000Z'),
      });
      const resolved = service.resolveSession({
        token,
        // 11 minutes later → past expiresAt
        now: new Date('2026-05-23T10:11:00.000Z'),
        idleMinutes: 60,
      });
      expect(resolved).toBeNull();
    } finally {
      db.close();
    }
  });

  it('resolveSession rejects after the idle window without touching the session', () => {
    const { db, service, userId } = mkFixture();
    try {
      const { token, session } = service.createSession({
        userId,
        ttlMinutes: 60 * 24,
        idleMinutes: 30,
        now: new Date('2026-05-23T10:00:00.000Z'),
      });
      const before = session.lastSeenAt;
      const resolved = service.resolveSession({
        token,
        // 31 minutes after last_seen_at → idle expired
        now: new Date('2026-05-23T10:31:00.000Z'),
        idleMinutes: 30,
      });
      expect(resolved).toBeNull();
      // Soft expiry must NOT touch the row.
      const stillThereRow = db
        .query<{ last_seen_at: string }, [string]>('SELECT last_seen_at FROM sessions WHERE id = ?')
        .get(session.id);
      expect(stillThereRow?.last_seen_at).toBe(before);
    } finally {
      db.close();
    }
  });

  it('resolveSession rejects when the owning user has been soft-deleted', () => {
    const { db, service, userId } = mkFixture();
    try {
      const usersRepo = createUsersRepo(db);
      const { token } = service.createSession({
        userId,
        ttlMinutes: 60,
        idleMinutes: 30,
        now: new Date('2026-05-23T10:00:00.000Z'),
      });
      usersRepo.softDeleteUser(userId, '2026-05-23T10:01:00.000Z');
      const resolved = service.resolveSession({
        token,
        now: new Date('2026-05-23T10:02:00.000Z'),
        idleMinutes: 30,
      });
      expect(resolved).toBeNull();
    } finally {
      db.close();
    }
  });

  it('resolveSession returns null after revokeSession', () => {
    const { db, service, userId } = mkFixture();
    try {
      const { token, session } = service.createSession({
        userId,
        ttlMinutes: 60,
        idleMinutes: 30,
        now: new Date('2026-05-23T10:00:00.000Z'),
      });
      service.revokeSession(session.id, new Date('2026-05-23T10:01:00.000Z'));
      const resolved = service.resolveSession({
        token,
        now: new Date('2026-05-23T10:02:00.000Z'),
        idleMinutes: 30,
      });
      expect(resolved).toBeNull();
    } finally {
      db.close();
    }
  });

  it('revokeAllForUser kills every live session for the user', async () => {
    const { db, service, userId } = mkFixture();
    try {
      const a = service.createSession({
        userId,
        ttlMinutes: 60,
        idleMinutes: 30,
        now: new Date('2026-05-23T10:00:00.000Z'),
      });
      const b = service.createSession({
        userId,
        ttlMinutes: 60,
        idleMinutes: 30,
        now: new Date('2026-05-23T10:00:00.000Z'),
      });
      await service.revokeAllForUser(userId, new Date('2026-05-23T10:01:00.000Z'));
      const now = new Date('2026-05-23T10:02:00.000Z');
      expect(service.resolveSession({ token: a.token, now, idleMinutes: 30 })).toBeNull();
      expect(service.resolveSession({ token: b.token, now, idleMinutes: 30 })).toBeNull();
    } finally {
      db.close();
    }
  });

  it('revokeAllForUser publishes session.expired per revoked row with the supplied reason', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-sessions-bus-'));
    const db = openDatabase(dir);
    try {
      const users = createUsersRepo(db);
      const sessions = createSessionsRepo(db);
      const bus = new InMemoryMessageBus();
      const captured: BusEvent[] = [];
      bus.subscribe('session.expired', (e) => {
        captured.push(e);
      });
      const service = createSessionService({ sessions, users, bus });
      const userId = crypto.randomUUID();
      users.createUser({
        id: userId,
        username: 'alice',
        displayName: 'Alice',
        passwordHash: 'h',
        mustChangePassword: false,
        now: new Date().toISOString(),
      });
      service.createSession({
        userId,
        ttlMinutes: 60,
        idleMinutes: 30,
        now: new Date('2026-05-23T10:00:00.000Z'),
      });
      service.createSession({
        userId,
        ttlMinutes: 60,
        idleMinutes: 30,
        now: new Date('2026-05-23T10:00:00.000Z'),
      });
      const revoked = await service.revokeAllForUser(userId, new Date('2026-05-23T10:01:00.000Z'), {
        reason: 'admin_password_reset',
      });
      expect(revoked.length).toBe(2);
      expect(captured.length).toBe(2);
      for (const e of captured) {
        const payload = e.payload as { sessionId: string; userId: string; reason: string };
        expect(payload.userId).toBe(userId);
        expect(payload.reason).toBe('admin_password_reset');
      }
    } finally {
      db.close();
    }
  });

  it('touchSession updates last_seen_at so subsequent idle checks succeed', () => {
    const { db, service, userId } = mkFixture();
    try {
      const { token, session } = service.createSession({
        userId,
        ttlMinutes: 60 * 24,
        idleMinutes: 30,
        now: new Date('2026-05-23T10:00:00.000Z'),
      });
      // 20 minutes later — still inside the window. Resolve, then touch.
      const t1 = new Date('2026-05-23T10:20:00.000Z');
      expect(service.resolveSession({ token, now: t1, idleMinutes: 30 })).not.toBeNull();
      service.touchSession(session.id, t1);
      // 49 minutes after the original create, but only 29 after touch.
      const t2 = new Date('2026-05-23T10:49:00.000Z');
      expect(service.resolveSession({ token, now: t2, idleMinutes: 30 })).not.toBeNull();
    } finally {
      db.close();
    }
  });
});
