import type { Hono } from 'hono';
import type { AppDeps, HonoVariables } from '../types';

/**
 * Mounts `GET /status`. The body shape is owned by `deps.status()`; the
 * handler only adds the HTTP layer (200 + JSON).
 *
 * Public route — the auth middleware (registered in `router.ts`) lets
 * `GET /status` through without a session so the renderer + monitoring
 * can poll health on a cold boot.
 */
export function mountStatusRoute(app: Hono<{ Variables: HonoVariables }>, deps: AppDeps): void {
  app.get('/status', (c) => c.json(deps.status()));
}
