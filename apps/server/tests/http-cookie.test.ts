import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  cookieSecureDefault,
  readSessionCookie,
  setSessionCookie,
} from '../src/auth/cookie';

interface ParsedCookie {
  readonly value: string;
  readonly attrs: Map<string, string>;
}

function parseSetCookie(header: string): ParsedCookie {
  const [first, ...rest] = header.split(';');
  if (first === undefined) {
    throw new Error('empty Set-Cookie header');
  }
  const eq = first.indexOf('=');
  const value = eq === -1 ? '' : first.slice(eq + 1).trim();
  const attrs = new Map<string, string>();
  for (const part of rest) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) {
      attrs.set(trimmed.toLowerCase(), '');
    } else {
      attrs.set(trimmed.slice(0, eqIdx).toLowerCase(), trimmed.slice(eqIdx + 1));
    }
  }
  return { value, attrs };
}

describe('session cookie helpers', () => {
  it('setSessionCookie writes HttpOnly + SameSite=Lax + Path=/ + Max-Age + Secure', async () => {
    const app = new Hono();
    app.get('/set', (c) => {
      setSessionCookie(c, 'tok-abc', { ttlMinutes: 60, secure: true });
      return c.text('ok');
    });
    const res = await app.fetch(new Request('http://localhost/set'));
    const header = res.headers.get('set-cookie');
    expect(header).toBeTruthy();
    const parsed = parseSetCookie(header as string);
    expect(parsed.value).toBe('tok-abc');
    expect(parsed.attrs.has('httponly')).toBe(true);
    expect(parsed.attrs.has('secure')).toBe(true);
    expect(parsed.attrs.get('samesite')?.toLowerCase()).toBe('lax');
    expect(parsed.attrs.get('path')).toBe('/');
    // 60 minutes → 3600 seconds.
    expect(parsed.attrs.get('max-age')).toBe('3600');
  });

  it('setSessionCookie omits Secure when called with secure=false (dev mode)', async () => {
    const app = new Hono();
    app.get('/set', (c) => {
      setSessionCookie(c, 'tok-dev', { ttlMinutes: 1, secure: false });
      return c.text('ok');
    });
    const res = await app.fetch(new Request('http://localhost/set'));
    const parsed = parseSetCookie(res.headers.get('set-cookie') as string);
    expect(parsed.attrs.has('secure')).toBe(false);
  });

  it('clearSessionCookie emits Max-Age=0 (or an expired Expires) so the browser drops it', async () => {
    const app = new Hono();
    app.get('/clear', (c) => {
      clearSessionCookie(c);
      return c.text('ok');
    });
    const res = await app.fetch(new Request('http://localhost/clear'));
    const header = res.headers.get('set-cookie');
    expect(header).toBeTruthy();
    const parsed = parseSetCookie(header as string);
    // Hono's `deleteCookie` zeroes the value and sets Max-Age=0; some
    // versions emit an `Expires` in the past instead. Accept either.
    const maxAge = parsed.attrs.get('max-age');
    const expires = parsed.attrs.get('expires');
    const dropped =
      maxAge === '0' || (expires !== undefined && new Date(expires).getTime() < Date.now());
    expect(dropped).toBe(true);
  });

  it('readSessionCookie returns the token when the cookie is set, null when missing', async () => {
    const app = new Hono();
    app.get('/read', (c) => {
      const value = readSessionCookie(c);
      return c.json({ value });
    });
    const set = await app.fetch(
      new Request('http://localhost/read', {
        headers: { cookie: `${SESSION_COOKIE_NAME}=hello-token` },
      }),
    );
    expect(((await set.json()) as { value: string | null }).value).toBe('hello-token');

    const absent = await app.fetch(new Request('http://localhost/read'));
    expect(((await absent.json()) as { value: string | null }).value).toBeNull();
  });
});

describe('cookieSecureDefault', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = Bun.env['BUNNY2_DEV'];
  });

  afterEach(() => {
    if (saved === undefined) {
      delete Bun.env['BUNNY2_DEV'];
    } else {
      Bun.env['BUNNY2_DEV'] = saved;
    }
  });

  it('returns false when BUNNY2_DEV=1 (dev: HTTP localhost is OK)', () => {
    Bun.env['BUNNY2_DEV'] = '1';
    expect(cookieSecureDefault()).toBe(false);
  });

  it('returns true when BUNNY2_DEV is unset (production: cookie must be HTTPS-only)', () => {
    delete Bun.env['BUNNY2_DEV'];
    expect(cookieSecureDefault()).toBe(true);
  });
});
