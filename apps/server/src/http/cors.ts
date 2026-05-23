import type { MiddlewareHandler } from 'hono';

/**
 * Phase-1 CORS policy (see ADR 0006).
 *
 * Allows requests from:
 *  - `http(s)://localhost(:*)` — Vite dev server.
 *  - `http(s)://127.0.0.1(:*)` — same, by IP.
 *  - `Origin: null` — Electron renderer loading from `file://`.
 *
 * Reflects the request `Origin` back rather than `*` so credentials-style
 * requests work later without policy changes. Pre-flight (`OPTIONS`) is
 * answered with the same allowlist.
 */
export function createDevCors(): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin');
    const allowed = isAllowedOrigin(origin);

    // Only emit CORS headers when an `Origin` was actually sent. Same-origin
    // browser requests and non-browser callers (e.g. curl) do not need them
    // and setting `Access-Control-Allow-Origin: null` on those is wrong.
    if (allowed && origin !== undefined) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
      c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      c.header('Access-Control-Allow-Headers', 'Content-Type');
      c.header('Access-Control-Max-Age', '600');
    }

    if (c.req.method === 'OPTIONS') {
      if (!allowed) {
        return c.body(null, 403);
      }
      return c.body(null, 204);
    }

    await next();
  };
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true; // same-origin or non-browser caller
  if (origin === 'null') return true; // Electron file://
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}
