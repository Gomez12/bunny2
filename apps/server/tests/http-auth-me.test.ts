/**
 * Phase 2.3 — `GET /auth/me`.
 *
 * Returns the safe user, `mustChangePassword`, `isAdmin` (direct admin
 * membership in 2.3; transitive in 2.4), and `sessionExpiresAt`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { seedAdminIfNeeded } from '../src/auth/seed';
import { hashPassword } from '../src/auth/password';
import { createUsersRepo } from '../src/repos/users-repo';
import { createSessionsRepo } from '../src/repos/sessions-repo';
import { createSessionService } from '../src/auth/sessions';
import { makeTestApp, type TestApp } from './_helpers/app';
import { seedUserAndSession } from './_helpers/auth';

let t: TestApp;
beforeEach(() => {
  t = makeTestApp('bunny2-auth-me-');
});
afterEach(() => t.cleanup());

async function loginAdmin(): Promise<{ token: string; userId: string }> {
  const captured: string[] = [];
  await seedAdminIfNeeded({ db: t.db, bus: t.bus, log: (l) => captured.push(l) });
  const password =
    captured
      .find((l) => l.includes('password:'))
      ?.split('password:')[1]
      ?.trim() ?? '';
  const res = await t.app.fetch(
    new Request('http://localhost/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password }),
    }),
  );
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const token = /bunny2_session=([^;]+)/.exec(setCookie)?.[1] ?? '';
  const body = (await res.json()) as { user: { id: string } };
  return { token, userId: body.user.id };
}

describe('GET /auth/me', () => {
  it('returns 401 without auth', async () => {
    const res = await t.app.fetch(new Request('http://localhost/auth/me'));
    expect(res.status).toBe(401);
  });

  it('returns isAdmin=true for the seeded admin after they rotate their password', async () => {
    const { token } = await loginAdmin();

    // Must rotate first — the password gate blocks /auth/me otherwise.
    const rotate = await t.app.fetch(
      new Request('http://localhost/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ newPassword: 'fresh-strong-pw-2026!' }),
      }),
    );
    expect(rotate.status).toBe(200);

    const res = await t.app.fetch(
      new Request('http://localhost/auth/me', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { username: string };
      isAdmin: boolean;
      mustChangePassword: boolean;
      sessionExpiresAt: string;
    };
    expect(body.user.username).toBe('admin');
    expect(body.isAdmin).toBe(true);
    expect(body.mustChangePassword).toBe(false);
    expect(body.sessionExpiresAt).toBeTruthy();
  });

  it('returns isAdmin=false for a non-admin user', async () => {
    // Seed admin first so the kv_meta admin-group id is populated; if
    // we skipped this step `isAdmin` would also be false but for the
    // wrong reason (no admin group exists at all).
    await seedAdminIfNeeded({ db: t.db, bus: t.bus, log: () => undefined });

    const usersRepo = createUsersRepo(t.db);
    const sessionsRepo = createSessionsRepo(t.db);
    const service = createSessionService({ sessions: sessionsRepo, users: usersRepo });
    const passwordHash = await hashPassword('non-admin-pw-2026');
    const user = usersRepo.createUser({
      id: crypto.randomUUID(),
      username: 'bob',
      displayName: 'Bob',
      passwordHash,
      mustChangePassword: false,
      now: new Date().toISOString(),
    });
    const { token } = service.createSession({
      userId: user.id,
      ttlMinutes: 60,
      idleMinutes: 60,
      now: new Date(),
    });

    const res = await t.app.fetch(
      new Request('http://localhost/auth/me', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { isAdmin: boolean; user: { username: string } };
    expect(body.user.username).toBe('bob');
    expect(body.isAdmin).toBe(false);
  });

  it('returns isAdmin=false when the admin seed has not run yet', async () => {
    const { token } = seedUserAndSession(t.db, { username: 'eve' });
    const res = await t.app.fetch(
      new Request('http://localhost/auth/me', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { isAdmin: boolean };
    expect(body.isAdmin).toBe(false);
  });
});
