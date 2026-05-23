import type { Hono } from 'hono';
import type { AppDeps } from '../types';

/**
 * Mounts `GET /status`. The body shape is owned by `deps.status()`; the
 * handler only adds the HTTP layer (200 + JSON).
 */
export function mountStatusRoute(app: Hono, deps: AppDeps): void {
  app.get('/status', (c) => c.json(deps.status()));
}
