import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

/**
 * Session-cookie helpers.
 *
 * The cookie carries the same plaintext opaque token that
 * `Authorization: Bearer` carries for non-browser clients (ADR
 * `0008-session-strategy.md`). It is HttpOnly so a renderer XSS cannot
 * read it, and SameSite=Lax so a third-party site cannot forge a
 * cross-site request that lands authenticated.
 *
 * Cookie name is stable across phases:
 *
 *   bunny2_session=<base64url-token>
 *
 * If you ever rename it, treat that as a session-invalidation event —
 * every running client will be signed out.
 */

export const SESSION_COOKIE_NAME = 'bunny2_session';

export interface SetSessionCookieOptions {
  /** Absolute lifetime, mirrors the session row's `expires_at`. */
  readonly ttlMinutes: number;
  /**
   * `Secure` flag. Pass `false` in dev (Electron renderer + Vite both
   * hit `http://`); `true` in production. Callers in the server wire
   * this from `Bun.env.BUNNY2_DEV !== '1'` — see `cookieSecureDefault`.
   */
  readonly secure: boolean;
}

/**
 * Sets the session cookie. HttpOnly + SameSite=Lax + Path=/ +
 * Max-Age=ttlMinutes*60. The `Secure` flag follows the caller.
 */
export function setSessionCookie(c: Context, token: string, opts: SetSessionCookieOptions): void {
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: opts.ttlMinutes * 60,
    secure: opts.secure,
  });
}

/**
 * Clears the session cookie. Sets an empty value with Max-Age=0 so the
 * browser drops the cookie immediately.
 */
export function clearSessionCookie(c: Context): void {
  // `deleteCookie` from Hono emits an expired cookie that matches the
  // path/sameSite we used on set; we mirror those attributes explicitly
  // because the browser drops only when path + sameSite match.
  deleteCookie(c, SESSION_COOKIE_NAME, {
    path: '/',
    sameSite: 'Lax',
  });
}

/**
 * Reads the raw session token from the cookie, or `null` if absent.
 * Does NOT validate the token — that is the session service's job.
 */
export function readSessionCookie(c: Context): string | null {
  const value = getCookie(c, SESSION_COOKIE_NAME);
  return value === undefined || value === '' ? null : value;
}

/**
 * Default for the `Secure` cookie flag. We turn it off when running in
 * dev mode (`BUNNY2_DEV=1`) because Vite + the Electron renderer both
 * talk over plain `http://` to `127.0.0.1`; in production builds the
 * flag is on so the cookie never leaks across HTTP.
 */
export function cookieSecureDefault(): boolean {
  return Bun.env['BUNNY2_DEV'] !== '1';
}
