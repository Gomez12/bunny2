/**
 * Phase 3.4 — `GET /system/locales`.
 *
 * Asserts the route returns the configured locale list and is auth-gated.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { makeTestApp, type TestApp } from './_helpers/app';
import { seedUserAndSession } from './_helpers/auth';

let fx: TestApp | null = null;
afterEach(() => {
  if (fx !== null) {
    fx.cleanup();
    fx = null;
  }
});

describe('GET /system/locales', () => {
  it('returns the configured set of supported locales and default for any signed-in user', async () => {
    fx = makeTestApp('bunny2-syslocales-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    const res = await fx.app.fetch(
      new Request('http://localhost/system/locales', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { locales: string[]; default: string };
    expect(body.locales).toEqual(['en', 'nl']);
    expect(body.default).toBe('en');
  });

  it('returns 401 when called without a session token', async () => {
    fx = makeTestApp('bunny2-syslocales-noauth-');
    const res = await fx.app.fetch(new Request('http://localhost/system/locales'));
    expect(res.status).toBe(401);
  });
});
