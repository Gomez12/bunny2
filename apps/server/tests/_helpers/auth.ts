import type { Database } from 'bun:sqlite';
import { createSessionsRepo, type Session } from '../../src/repos/sessions-repo';
import { createUsersRepo, type User as StoredUser } from '../../src/repos/users-repo';
import { createSessionService } from '../../src/auth/sessions';

/**
 * Test helper — seeds a user and a live session against an open
 * database. Returns the plaintext token so callers can attach it to a
 * request via `Authorization: Bearer <token>` or the
 * `bunny2_session=<token>` cookie. Mirrors what the 2.3 login route
 * will eventually produce.
 *
 * Defaults pick generous windows (1-year TTL, 1-year idle) so tests
 * that only care about the auth gate don't accidentally trip the idle
 * timeout while doing other work.
 */
export interface SeededAuth {
  readonly user: StoredUser;
  readonly session: Session;
  readonly token: string;
}

export interface SeedUserAndSessionOptions {
  readonly username?: string;
  readonly displayName?: string;
  readonly ttlMinutes?: number;
  readonly idleMinutes?: number;
  readonly now?: Date;
}

export function seedUserAndSession(db: Database, opts: SeedUserAndSessionOptions = {}): SeededAuth {
  const usersRepo = createUsersRepo(db);
  const sessionsRepo = createSessionsRepo(db);
  const service = createSessionService({ sessions: sessionsRepo, users: usersRepo });
  const now = opts.now ?? new Date();
  const user = usersRepo.createUser({
    id: crypto.randomUUID(),
    username: opts.username ?? `test-${crypto.randomUUID().slice(0, 8)}`,
    displayName: opts.displayName ?? 'Test User',
    passwordHash: 'dummy-hash-not-used-in-tests',
    mustChangePassword: false,
    now: now.toISOString(),
  });
  const created = service.createSession({
    userId: user.id,
    ttlMinutes: opts.ttlMinutes ?? 60 * 24 * 365,
    idleMinutes: opts.idleMinutes ?? 60 * 24 * 365,
    now,
  });
  return { user, session: created.session, token: created.token };
}
