/**
 * Phase 2.3 — `POST /auth/logout`.
 *
 * Public route. Revokes the session if a token is presented and emits
 * `session.expired { reason: 'logout' }`. Always clears the cookie and
 * returns `{ ok: true }`. Subsequent requests with the old token must
 * return 401.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SESSION_COOKIE_NAME } from '../src/auth/cookie';
import { seedUserAndSession } from './_helpers/auth';
import { makeTestApp, type TestApp } from './_helpers/app';

let t: TestApp;
beforeEach(() => {
  t = makeTestApp('bunny2-auth-logout-');
});
afterEach(() => t.cleanup());

describe('POST /auth/logout', () => {
  it('revokes the session and publishes session.expired { reason: logout }', async () => {
    const { token, session } = seedUserAndSession(t.db);
    const res = await t.app.fetch(
      new Request('http://localhost/auth/logout', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });

    // Cookie cleared (Max-Age=0).
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('bunny2_session=');
    expect(setCookie).toMatch(/Max-Age=0|Expires=/i);

    // Bus event emitted with the right reason.
    const rows = t.db
      .query<
        { type: string; payload: string },
        []
      >("SELECT type, payload FROM events WHERE type = 'session.expired'")
      .all();
    expect(rows).toHaveLength(1);
    const parsed = JSON.parse(rows[0]!.payload) as { reason: string; sessionId: string };
    expect(parsed.reason).toBe('logout');
    expect(parsed.sessionId).toBe(session.id);
  });

  it('returns 200 + clears the cookie even when no token is present (idempotent)', async () => {
    const res = await t.app.fetch(new Request('http://localhost/auth/logout', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });

    // No session.expired event emitted because there was nothing to revoke.
    const n =
      t.db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE type = 'session.expired'")
        .get()?.n ?? 0;
    expect(n).toBe(0);
  });

  it('after logout, the old token returns 401 on a protected route', async () => {
    const { token } = seedUserAndSession(t.db);
    await t.app.fetch(
      new Request('http://localhost/auth/logout', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    const res = await t.app.fetch(
      new Request('http://localhost/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: 'hi' }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('accepts the bunny2_session cookie as the token source', async () => {
    const { token, session } = seedUserAndSession(t.db);
    const res = await t.app.fetch(
      new Request('http://localhost/auth/logout', {
        method: 'POST',
        headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const rows = t.db
      .query<{ payload: string }, []>("SELECT payload FROM events WHERE type = 'session.expired'")
      .all();
    expect(rows).toHaveLength(1);
    expect((JSON.parse(rows[0]!.payload) as { sessionId: string }).sessionId).toBe(session.id);
  });
});
