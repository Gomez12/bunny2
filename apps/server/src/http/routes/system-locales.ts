import type { Hono } from 'hono';
import type { LocalesConfig } from '../../config/schema';
import type { HonoVariables } from '../types';

/**
 * Phase 3.4 — `GET /system/locales`.
 *
 * Exposes the system-configured locale list and its default. Behind
 * `requireAuth` (every route in `router.ts` is, except the
 * `DEFAULT_PUBLIC_PATHS` whitelist) — there's no admin gate; any signed-
 * in user needs the list so the `POST /layers/:slug/locales` UI can
 * validate before hitting the server.
 *
 * The response body shape mirrors `LocalesConfig` 1:1 so a future
 * locale-management UI can `JSON.parse` it without translation.
 *
 * v1 returns the in-process snapshot — the list doesn't change at
 * runtime (it lives in the config file). Phase 3.5+ may add an
 * If-None-Match handler if the list ever grows large.
 */

export interface SystemLocalesDeps {
  readonly locales: LocalesConfig;
}

export function registerSystemLocalesRoute(
  app: Hono<{ Variables: HonoVariables }>,
  deps: SystemLocalesDeps,
): void {
  // Pre-compute the body once. The config is captured at boot and never
  // mutated; subsequent requests reuse the same object.
  const body = {
    locales: [...deps.locales.supported],
    default: deps.locales.default,
  } as const;

  app.get('/system/locales', (c) => {
    return c.json(body);
  });
}
