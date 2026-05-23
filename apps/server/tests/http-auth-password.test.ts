/**
 * Phase 2.3 — `POST /auth/password`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { hashPassword, verifyPassword } from '../src/auth/password';
import { createUsersRepo } from '../src/repos/users-repo';
import { createSessionsRepo } from '../src/repos/sessions-repo';
import { createSessionService } from '../src/auth/sessions';
import { makeTestApp, type TestApp } from './_helpers/app';

let t: TestApp;
beforeEach(() => {
  t = makeTestApp('bunny2-auth-password-');
});
afterEach(() => t.cleanup());

async function seedActiveUserWithSession(
  opts: { mustChangePassword?: boolean; password?: string } = {},
) {
  const password = opts.password ?? 'original-strong-pw-2026';
  const usersRepo = createUsersRepo(t.db);
  const sessionsRepo = createSessionsRepo(t.db);
  const service = createSessionService({ sessions: sessionsRepo, users: usersRepo });
  const passwordHash = await hashPassword(password);
  const user = usersRepo.createUser({
    id: crypto.randomUUID(),
    username: `u-${crypto.randomUUID().slice(0, 8)}`,
    displayName: 'U',
    passwordHash,
    mustChangePassword: opts.mustChangePassword === true,
    now: new Date().toISOString(),
  });
  const created = service.createSession({
    userId: user.id,
    ttlMinutes: 60,
    idleMinutes: 60,
    now: new Date(),
  });
  return { user, password, token: created.token, sessionId: created.session.id, service };
}

describe('POST /auth/password', () => {
  it('changes the password on the happy path (requires current password)', async () => {
    const { user, password, token } = await seedActiveUserWithSession();
    const res = await t.app.fetch(
      new Request('http://localhost/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword: password, newPassword: 'brand-new-pw-2026!' }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });

    const stored = createUsersRepo(t.db).findUserById(user.id);
    expect(stored).not.toBeNull();
    expect(await verifyPassword('brand-new-pw-2026!', stored!.passwordHash)).toBe(true);
    expect(stored!.mustChangePassword).toBe(false);

    const types = t.db
      .query<{ type: string }, []>('SELECT type FROM events')
      .all()
      .map((r) => r.type);
    expect(types).toContain('user.password_changed');
  });

  it('rejects a weak new password with errors.auth.weakPassword (too short)', async () => {
    const { password, token } = await seedActiveUserWithSession();
    const res = await t.app.fetch(
      new Request('http://localhost/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword: password, newPassword: 'shorter-12!' }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({ error: 'errors.auth.weakPassword' });
  });

  it('rejects a weak new password with errors.auth.weakPassword (no non-letter)', async () => {
    const { password, token } = await seedActiveUserWithSession();
    const res = await t.app.fetch(
      new Request('http://localhost/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          currentPassword: password,
          newPassword: 'AllLettersNoDigits',
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({ error: 'errors.auth.weakPassword' });
  });

  it('requires currentPassword when mustChangePassword is false', async () => {
    const { token } = await seedActiveUserWithSession();
    const res = await t.app.fetch(
      new Request('http://localhost/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ newPassword: 'fresh-strong-pw-2026!' }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'errors.auth.invalidCurrentPassword',
    });
  });

  it('rejects a wrong current password with errors.auth.invalidCurrentPassword', async () => {
    const { token } = await seedActiveUserWithSession();
    const res = await t.app.fetch(
      new Request('http://localhost/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          currentPassword: 'not-the-actual-one',
          newPassword: 'fresh-strong-pw-2026!',
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'errors.auth.invalidCurrentPassword',
    });
  });

  it('succeeds without currentPassword when mustChangePassword is true', async () => {
    const { token } = await seedActiveUserWithSession({ mustChangePassword: true });
    const res = await t.app.fetch(
      new Request('http://localhost/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ newPassword: 'first-rotation-pw-2026!' }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it('revokes other sessions for the same user but keeps the current one alive', async () => {
    const { user, password, token, service, sessionId } = await seedActiveUserWithSession();

    // Spin up a second session for the same user.
    const other = service.createSession({
      userId: user.id,
      ttlMinutes: 60,
      idleMinutes: 60,
      now: new Date(),
    });
    expect(other.session.id).not.toBe(sessionId);

    // Change the password from the first session.
    const change = await t.app.fetch(
      new Request('http://localhost/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword: password, newPassword: 'rotated-strong-pw-2026!' }),
      }),
    );
    expect(change.status).toBe(200);

    // First session — still works.
    const stillOk = await t.app.fetch(
      new Request('http://localhost/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: 'hi' }),
      }),
    );
    expect(stillOk.status).toBe(200);

    // Other session — revoked, must return 401.
    const blocked = await t.app.fetch(
      new Request('http://localhost/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${other.token}`,
        },
        body: JSON.stringify({ message: 'hi' }),
      }),
    );
    expect(blocked.status).toBe(401);
  });
});
