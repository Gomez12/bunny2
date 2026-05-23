/**
 * Phase 2.3 — `POST /auth/login`.
 *
 * Asserts:
 *  - happy path: 200 + user + cookie + bus events
 *  - wrong-password / unknown-user / soft-deleted all return the SAME
 *    401 + `errors.auth.invalidCredentials` to prevent enumeration
 *  - cookie carries HttpOnly + SameSite=Lax + Max-Age
 *  - timing: dummyVerify runs in the unknown-user branch (both calls
 *    spend argon2 cpu, so both > 5ms)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { hashPassword } from '../src/auth/password';
import { createUsersRepo } from '../src/repos/users-repo';
import { makeTestApp, type TestApp } from './_helpers/app';

let t: TestApp;

beforeEach(() => {
  t = makeTestApp('bunny2-auth-login-');
});
afterEach(() => t.cleanup());

async function seedNormalUser(opts: { mustChangePassword?: boolean; deletedAt?: string } = {}) {
  const usersRepo = createUsersRepo(t.db);
  const username = 'alice';
  const password = 'correct-horse-battery-staple-42';
  const passwordHash = await hashPassword(password);
  const user = usersRepo.createUser({
    id: crypto.randomUUID(),
    username,
    displayName: 'Alice',
    passwordHash,
    mustChangePassword: opts.mustChangePassword === true,
    now: new Date().toISOString(),
  });
  if (opts.deletedAt !== undefined) {
    usersRepo.softDeleteUser(user.id, opts.deletedAt);
  }
  return { user, username, password };
}

describe('POST /auth/login', () => {
  it('returns 200 with user + sets the session cookie on the happy path', async () => {
    const { user, username, password } = await seedNormalUser();
    const res = await t.app.fetch(
      new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { id: string; username: string };
      mustChangePassword: boolean;
      sessionExpiresAt: string;
    };
    expect(body.user.id).toBe(user.id);
    expect(body.user.username).toBe(username);
    expect(body.mustChangePassword).toBe(false);
    expect(body.sessionExpiresAt).toBeTruthy();

    // The JSON body must NOT carry the plaintext token — that lives in
    // the cookie only. (Anti-leak invariant; see architecture doc.)
    expect(JSON.stringify(body)).not.toContain('Bearer');

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('bunny2_session=');
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=');
  });

  it('publishes session.created and user.login.succeeded on success', async () => {
    const { username, password } = await seedNormalUser();
    const res = await t.app.fetch(
      new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      }),
    );
    expect(res.status).toBe(200);
    const types = t.db
      .query<{ type: string }, []>('SELECT type FROM events ORDER BY occurred_at ASC, id ASC')
      .all()
      .map((r) => r.type);
    expect(types).toContain('session.created');
    expect(types).toContain('user.login.succeeded');
  });

  it('returns 401 + errors.auth.invalidCredentials on wrong password and emits user.login.failed { reason: wrong_password }', async () => {
    const { username } = await seedNormalUser();
    const res = await t.app.fetch(
      new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: 'definitely-wrong' }),
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'errors.auth.invalidCredentials',
    });
    const payloads = t.db
      .query<
        { type: string; payload: string },
        []
      >("SELECT type, payload FROM events WHERE type = 'user.login.failed'")
      .all();
    expect(payloads).toHaveLength(1);
    const parsed = JSON.parse(payloads[0]!.payload) as { reason: string };
    expect(parsed.reason).toBe('wrong_password');
  });

  it('returns the same 401 for an unknown username (no enumeration)', async () => {
    const res = await t.app.fetch(
      new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'ghost', password: 'irrelevant' }),
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'errors.auth.invalidCredentials',
    });
    const payloads = t.db
      .query<{ payload: string }, []>("SELECT payload FROM events WHERE type = 'user.login.failed'")
      .all();
    expect(payloads).toHaveLength(1);
    const parsed = JSON.parse(payloads[0]!.payload) as { reason: string };
    expect(parsed.reason).toBe('unknown_user');
  });

  it('returns the same 401 for a soft-deleted user (no enumeration)', async () => {
    const { username, password } = await seedNormalUser({ deletedAt: new Date().toISOString() });
    const res = await t.app.fetch(
      new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'errors.auth.invalidCredentials',
    });
    const payloads = t.db
      .query<{ payload: string }, []>("SELECT payload FROM events WHERE type = 'user.login.failed'")
      .all();
    expect(payloads).toHaveLength(1);
    const parsed = JSON.parse(payloads[0]!.payload) as { reason: string };
    expect(parsed.reason).toBe('soft_deleted');
  });

  it('equalises timing — both wrong-password and unknown-user spend argon2 cpu (> 5ms)', async () => {
    const { username } = await seedNormalUser();

    // Warm the dummy hash so the first call doesn't pay the one-time
    // setup cost (which would dwarf the wrong-password number).
    await t.app.fetch(
      new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'warmup-ghost', password: 'x' }),
      }),
    );

    const before1 = performance.now();
    await t.app.fetch(
      new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: 'wrong' }),
      }),
    );
    const wrongPwMs = performance.now() - before1;

    const before2 = performance.now();
    await t.app.fetch(
      new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'no-such-user', password: 'x' }),
      }),
    );
    const unknownUserMs = performance.now() - before2;

    // Argon2 verify on the configured params runs comfortably above
    // 5ms. We don't assert tightness — slow CI varies — just that the
    // dummy verify actually ran for the unknown-user branch.
    expect(wrongPwMs).toBeGreaterThan(5);
    expect(unknownUserMs).toBeGreaterThan(5);
  });

  it('rejects a malformed body with 400 + errors.auth.badRequest', async () => {
    const res = await t.app.fetch(
      new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({ error: 'errors.auth.badRequest' });
  });
});
