/**
 * Phase 2.5 — end-to-end coverage for the `mustChangePassword` gate
 * after an admin-driven reset.
 *
 * Scenario:
 *   1. Admin creates a target user `target` with an explicit initial
 *      password.
 *   2. Target logs in, rotates the password → `mustChangePassword=false`.
 *   3. Admin resets the target's password → server emits
 *      `session.expired { reason: 'admin_password_reset' }` for the
 *      target's existing session, and the next login lands gated.
 *   4. Every protected route returns 409 EXCEPT `POST /auth/password`
 *      and `POST /auth/logout`.
 *   5. Target rotates → routes work again, `mustChangePassword=false`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { makeTestAppSeeded, type TestApp } from './_helpers/app';
import { loginSeededAdminRotated } from './_helpers/auth';

let t: TestApp;
let adminToken: string;

beforeEach(async () => {
  t = await makeTestAppSeeded();
  const admin = await loginSeededAdminRotated({
    db: t.db,
    bus: t.bus,
    app: t.app,
    seedLog: t.seedLog,
  });
  adminToken = admin.token;
});
afterEach(() => t.cleanup());

async function adminFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${adminToken}`);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return t.app.fetch(new Request(`http://localhost${input}`, { ...init, headers }));
}

async function login(
  username: string,
  password: string,
): Promise<{ token: string; mustChangePassword: boolean }> {
  const res = await t.app.fetch(
    new Request('http://localhost/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { mustChangePassword: boolean };
  const setCookie = res.headers.get('set-cookie') ?? '';
  const token = /bunny2_session=([^;]+)/.exec(setCookie)?.[1] ?? '';
  return { token, mustChangePassword: body.mustChangePassword };
}

describe('mustChangePassword gate after admin reset', () => {
  it('drives a full create → rotate → admin reset → re-rotate cycle through the gate', async () => {
    // 1. Create target.
    const create = await adminFetch('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'target',
        displayName: 'Target',
        initialPassword: 'initial-strong-pw-tg!',
      }),
    });
    expect(create.status).toBe(201);

    // 2. First login → mustChangePassword=true.
    const first = await login('target', 'initial-strong-pw-tg!');
    expect(first.mustChangePassword).toBe(true);

    // /auth/me is gated.
    const blockedMe = await t.app.fetch(
      new Request('http://localhost/auth/me', {
        headers: { authorization: `Bearer ${first.token}` },
      }),
    );
    expect(blockedMe.status).toBe(409);

    // 3. Rotate → routes work.
    const rotate = await t.app.fetch(
      new Request('http://localhost/auth/password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${first.token}`,
        },
        body: JSON.stringify({ newPassword: 'target-rotated-pw-1!' }),
      }),
    );
    expect(rotate.status).toBe(200);
    const meOk = await t.app.fetch(
      new Request('http://localhost/auth/me', {
        headers: { authorization: `Bearer ${first.token}` },
      }),
    );
    expect(meOk.status).toBe(200);

    // 4. Admin resets target.
    const list = (await (await adminFetch('/admin/users')).json()) as {
      users: { id: string; username: string }[];
    };
    const targetId = list.users.find((u) => u.username === 'target')!.id;
    const reset = await adminFetch(`/admin/users/${targetId}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(reset.status).toBe(200);
    const resetBody = (await reset.json()) as { generatedPassword: string };

    // Old session is dead.
    const dead = await t.app.fetch(
      new Request('http://localhost/auth/me', {
        headers: { authorization: `Bearer ${first.token}` },
      }),
    );
    expect(dead.status).toBe(401);

    // 5. Re-login with generated password → gated again.
    const second = await login('target', resetBody.generatedPassword);
    expect(second.mustChangePassword).toBe(true);

    // Protected routes return 409.
    const blocked2 = await t.app.fetch(
      new Request('http://localhost/auth/me', {
        headers: { authorization: `Bearer ${second.token}` },
      }),
    );
    expect(blocked2.status).toBe(409);
    const blockedChat = await t.app.fetch(
      new Request('http://localhost/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${second.token}`,
        },
        body: JSON.stringify({ message: 'hi' }),
      }),
    );
    expect(blockedChat.status).toBe(409);

    // Exit doors still work.
    const passwordOk = await t.app.fetch(
      new Request('http://localhost/auth/password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${second.token}`,
        },
        body: JSON.stringify({ newPassword: 'target-rotated-pw-2!' }),
      }),
    );
    expect(passwordOk.status).toBe(200);

    // After rotation, /auth/me works and reports mustChangePassword=false.
    const meAfter = await t.app.fetch(
      new Request('http://localhost/auth/me', {
        headers: { authorization: `Bearer ${second.token}` },
      }),
    );
    expect(meAfter.status).toBe(200);
    const meBody = (await meAfter.json()) as { mustChangePassword: boolean };
    expect(meBody.mustChangePassword).toBe(false);
  });
});
