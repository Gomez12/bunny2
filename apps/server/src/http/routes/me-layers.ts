import type { Hono } from 'hono';
import type { HonoVariables } from '../types';

/**
 * Phase 3.4 — `GET /me/layers`.
 *
 * Convenience alias for the layer switcher. Returns the caller's
 * `effectiveLayers` set, already computed by `withEffectiveLayers`
 * upstream. No filtering, no params — the dedicated `/layers` route
 * carries the filter knobs.
 *
 * The resolver returns a frozen, sorted, deduped `Layer[]`; we surface
 * the same ordering to the client so the switcher renders predictably.
 * Soft-deleted layers are already filtered by the resolver.
 */
export function registerMeLayersRoute(app: Hono<{ Variables: HonoVariables }>): void {
  app.get('/me/layers', (c) => {
    const layers = c.get('effectiveLayers') ?? [];
    return c.json({ layers });
  });
}
