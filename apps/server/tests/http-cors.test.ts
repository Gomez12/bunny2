import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { createDevCors } from '../src/http/cors';

/**
 * Regression test for the dev CORS middleware.
 *
 * Phase 2.6 introduced cookie-based auth (`bunny2_session`, `SameSite=Lax`)
 * and the web client calls every endpoint with `credentials: 'include'`.
 * The CORS middleware must emit `Access-Control-Allow-Credentials: true`
 * for allowed non-null origins, otherwise the browser drops the response
 * and the renderer surfaces `errors.network` ("Could not reach the
 * server"). See ADR 0006 and the troubleshooting note in
 * `docs/dev/troubleshooting/login-could-not-reach-server.md`.
 */
function buildApp(): Hono {
  const app = new Hono();
  app.use('*', createDevCors());
  app.get('/ping', (c) => c.json({ ok: true }));
  app.post('/echo', async (c) => c.json(await c.req.json()));
  return app;
}

describe('http cors middleware', () => {
  it('reflects an allowed Origin and enables credentials on GET', async () => {
    const app = buildApp();
    const res = await app.fetch(
      new Request('http://server/ping', {
        headers: { origin: 'http://localhost:5173' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('vary')).toBe('Origin');
  });

  it('answers OPTIONS preflight with 204 and credentials for an allowed origin', async () => {
    const app = buildApp();
    const res = await app.fetch(
      new Request('http://server/echo', {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toContain('Content-Type');
  });

  it('allows the 127.0.0.1 origin (Vite-by-IP) with credentials', async () => {
    const app = buildApp();
    const res = await app.fetch(
      new Request('http://server/ping', {
        headers: { origin: 'http://127.0.0.1:5173' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5173');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('allows Origin: null (Electron file://) but does NOT enable credentials', async () => {
    // Per Fetch spec + Chromium policy, `Allow-Origin: null` with
    // `Allow-Credentials: true` is rejected. Packaged Electron must use
    // a different auth transport — tracked in
    // `docs/dev/follow-ups/packaged-electron-cookie-transport.md`.
    const app = buildApp();
    const res = await app.fetch(
      new Request('http://server/ping', {
        headers: { origin: 'null' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('null');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('rejects a disallowed origin on preflight with 403 and no CORS headers', async () => {
    const app = buildApp();
    const res = await app.fetch(
      new Request('http://server/echo', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://evil.example',
          'access-control-request-method': 'POST',
        },
      }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('omits all CORS headers for same-origin / non-browser callers (no Origin header)', async () => {
    const app = buildApp();
    const res = await app.fetch(new Request('http://server/ping'));
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });
});
