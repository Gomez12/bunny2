/**
 * Phase 2.3 — `requirePasswordCurrent` gate.
 *
 * When `c.var.user.mustChangePassword === true`, every protected route
 * EXCEPT `POST /auth/password` and `POST /auth/logout` returns 409 with
 * `errors.auth.mustChangePassword`. Public routes (`/status`) and the
 * two exempt endpoints continue to work.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { hashPassword } from '../src/auth/password';
import { createUsersRepo } from '../src/repos/users-repo';
import { createSessionsRepo } from '../src/repos/sessions-repo';
import { createSessionService } from '../src/auth/sessions';
import { makeTestApp, type TestApp } from './_helpers/app';

let t: TestApp;
beforeEach(() => {
  t = makeTestApp('bunny2-pw-gate-');
});
afterEach(() => t.cleanup());

async function seedMustChangeSession(): Promise<{ token: string }> {
  const usersRepo = createUsersRepo(t.db);
  const sessionsRepo = createSessionsRepo(t.db);
  const service = createSessionService({ sessions: sessionsRepo, users: usersRepo });
  const passwordHash = await hashPassword('original-strong-pw-2026');
  const user = usersRepo.createUser({
    id: crypto.randomUUID(),
    username: 'gated',
    displayName: 'Gated',
    passwordHash,
    mustChangePassword: true,
    now: new Date().toISOString(),
  });
  const { token } = service.createSession({
    userId: user.id,
    ttlMinutes: 60,
    idleMinutes: 60,
    now: new Date(),
  });
  return { token };
}

describe('mustChangePassword gate', () => {
  it('returns 409 with errors.auth.mustChangePassword on a protected route', async () => {
    const { token } = await seedMustChangeSession();
    const res = await t.app.fetch(
      new Request('http://localhost/auth/me', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'errors.auth.mustChangePassword',
    });
  });

  it('lets POST /auth/password through so the user can rotate', async () => {
    const { token } = await seedMustChangeSession();
    const res = await t.app.fetch(
      new Request('http://localhost/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ newPassword: 'rotated-strong-pw-2026!' }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it('lets POST /auth/logout through so the user can bail out', async () => {
    const { token } = await seedMustChangeSession();
    const res = await t.app.fetch(
      new Request('http://localhost/auth/logout', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('lets GET /status through (public route, gate not reached)', async () => {
    const { token } = await seedMustChangeSession();
    const res = await t.app.fetch(
      new Request('http://localhost/status', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
  });
});
