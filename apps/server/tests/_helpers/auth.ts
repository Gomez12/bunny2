import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import { createSessionsRepo, type Session } from '../../src/repos/sessions-repo';
import { createUsersRepo, type User as StoredUser } from '../../src/repos/users-repo';
import { createSessionService } from '../../src/auth/sessions';
import { seedAdminIfNeeded } from '../../src/auth/seed';

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
  /** Default `false`. Set to `true` to exercise the password-rotation gate. */
  readonly mustChangePassword?: boolean;
  /**
   * Optional override for the stored password hash. Tests that need to
   * exercise `verifyPassword` (login flow) pass a real argon2 hash; tests
   * that only need a valid session keep the default dummy string.
   */
  readonly passwordHash?: string;
}

/**
 * Captures the password printed by `seedAdminIfNeeded` to its `log` sink,
 * then drives a `/auth/login` round-trip against an already-built `app`
 * to produce a usable bearer token. The first login forces
 * `mustChangePassword`, so the caller typically follows up with a call
 * to `/auth/password` before exercising other routes. Mirrors the
 * "first run" experience documented in `docs/dev/setup/running.md`.
 */
export interface SeedAdminAndLoginResult {
  readonly username: string;
  readonly initialPassword: string;
  readonly token: string;
  readonly sessionExpiresAt: string;
  readonly mustChangePassword: boolean;
  readonly userId: string;
}

export interface SeedAdminAndLoginDeps {
  readonly db: Database;
  readonly bus: MessageBus;
  /**
   * Anything with a `fetch(req)` that returns a `Response`-or-`Promise<Response>`.
   * Hono returns the union by default — we accept either and `await` the
   * result, mirroring how production callers use the app.
   */
  readonly app: { fetch: (req: Request) => Response | Promise<Response> };
}

export async function seedAdminAndLogin(
  deps: SeedAdminAndLoginDeps,
): Promise<SeedAdminAndLoginResult> {
  const captured: string[] = [];
  await seedAdminIfNeeded({ db: deps.db, bus: deps.bus, log: (l) => captured.push(l) });
  const passwordLine = captured.find((l) => l.includes('password:'));
  if (passwordLine === undefined) {
    throw new Error('seedAdminAndLogin: no password line captured from seed output');
  }
  const initialPassword = passwordLine.split('password:')[1]?.trim() ?? '';
  if (initialPassword === '') {
    throw new Error('seedAdminAndLogin: failed to parse password from seed output');
  }

  const loginRes = await deps.app.fetch(
    new Request('http://localhost/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: initialPassword }),
    }),
  );
  if (loginRes.status !== 200) {
    throw new Error(`seedAdminAndLogin: login failed with status ${loginRes.status}`);
  }
  const setCookie = loginRes.headers.get('set-cookie') ?? '';
  const cookieMatch = /bunny2_session=([^;]+)/.exec(setCookie);
  if (cookieMatch === null || cookieMatch[1] === undefined) {
    throw new Error('seedAdminAndLogin: no session cookie in login response');
  }
  const body = (await loginRes.json()) as {
    user: { id: string };
    mustChangePassword: boolean;
    sessionExpiresAt: string;
  };

  return {
    username: 'admin',
    initialPassword,
    token: cookieMatch[1],
    sessionExpiresAt: body.sessionExpiresAt,
    mustChangePassword: body.mustChangePassword,
    userId: body.user.id,
  };
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
    passwordHash: opts.passwordHash ?? 'dummy-hash-not-used-in-tests',
    mustChangePassword: opts.mustChangePassword ?? false,
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
