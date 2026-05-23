import type { MiddlewareHandler } from 'hono';
import type { LayerResolver } from '../../layers/resolver';
import type { HonoVariables } from '../types';

/**
 * Phase 3.3 — layer-aware HTTP middleware.
 *
 * Two pieces live here so they share the same `c.var` typing surface and
 * stay symmetric with the existing `auth.ts` / `password-gate.ts` /
 * `admin.ts` middleware files:
 *
 *  1. `withEffectiveLayers({ resolver })` — chained after `requireAuth`
 *     and after `requirePasswordCurrent`. Calls
 *     `resolver.effectiveLayers(user.id)` exactly once per request and
 *     attaches the frozen result as `c.var.effectiveLayers`. Public
 *     routes (status, /auth/login, /auth/logout, OPTIONS) skip the
 *     middleware because `c.var.user` is `undefined` there — handlers on
 *     public routes must NOT read `c.var.effectiveLayers`.
 *
 *  2. `createRequireLayer()` — per-route middleware. Reads the hardcoded
 *     `:slug` URL param, looks it up in `c.var.effectiveLayers`, and
 *     either attaches `c.var.layer` for the handler OR returns
 *     `404 { error: 'errors.layer.notVisible' }` for any miss. We use
 *     404 (not 403) so a non-member cannot probe slug existence — see
 *     `docs/dev/plans/done/phase-03-layers.md` §10 Risks "Slug in URL leaks
 *     layer existence" and ADR `0009` (phase 3.6).
 *
 * Design decision (phase 3.2 open question §4.1): `requireLayer`
 * REUSES `c.var.effectiveLayers` rather than calling the resolver
 * itself. One resolver call per request, computed once by
 * `withEffectiveLayers` and read by zero-to-N layer-scoped routes.
 */

const NOT_VISIBLE_BODY = { error: 'errors.layer.notVisible' } as const;
const SERVER_UNAVAILABLE_BODY = { error: 'errors.server.unavailable' } as const;
const SLUG_REQUIRED_BODY = { error: 'errors.layer.slugRequired' } as const;

export interface WithEffectiveLayersOptions {
  readonly resolver: LayerResolver;
  /**
   * Sink for resolver failures. Production wires `console.error` so an
   * operator sees the underlying SQL / cache error; tests can swap in a
   * capturing array. The HTTP response is always
   * `500 errors.server.unavailable` — internals never reach the client.
   */
  readonly onResolverError?: (err: unknown) => void;
}

export function withEffectiveLayers(
  opts: WithEffectiveLayersOptions,
): MiddlewareHandler<{ Variables: HonoVariables }> {
  const onError = opts.onResolverError ?? defaultResolverErrorSink;
  return async (c, next) => {
    // Mirror `requirePasswordCurrent`: defensively check that the auth
    // middleware ran ahead of us. Public routes leave `user` undefined,
    // in which case there is no per-user layer set to compute.
    const user = c.get('user');
    if (user === undefined) {
      await next();
      return;
    }
    try {
      const layers = await opts.resolver.effectiveLayers(user.id);
      c.set('effectiveLayers', layers);
    } catch (err) {
      onError(err);
      return c.json(SERVER_UNAVAILABLE_BODY, 500);
    }
    await next();
    return;
  };
}

/**
 * Per-route middleware that reads `:slug` from the URL, validates it
 * against `c.var.effectiveLayers`, and attaches `c.var.layer` for the
 * downstream handler. Always pulls from `c.var.effectiveLayers` (set by
 * `withEffectiveLayers`) — never calls the resolver itself, so the
 * "one resolver call per request" contract is preserved.
 *
 * Per the §10 Risks row, a miss returns `404 errors.layer.notVisible`,
 * NOT 403 — a non-member must not be able to probe whether a slug
 * exists. Edit-rights enforcement is `canEditLayer`, shipped in 3.4.
 */
export function createRequireLayer(): MiddlewareHandler<{ Variables: HonoVariables }> {
  return async (c, next) => {
    const slug = c.req.param('slug');
    if (slug === undefined || slug === '') {
      // Hono normally 404s on a missing param entirely, but a route
      // mounted at `/layers/:slug` can still receive an empty segment
      // (e.g. `/layers/`). Reject with 400 so the contract is explicit
      // rather than relying on Hono's default trailing-slash behaviour.
      return c.json(SLUG_REQUIRED_BODY, 400);
    }
    const layers = c.get('effectiveLayers');
    if (layers === undefined) {
      // Defence in depth: every layer-scoped route must inherit
      // `withEffectiveLayers`. A misconfigured router that mounts
      // `requireLayer` without the upstream enrichment falls through to
      // the same 404 a missing slug would produce — we do NOT leak
      // "you forgot a middleware" to the client.
      return c.json(NOT_VISIBLE_BODY, 404);
    }
    const match = layers.find((l) => l.slug === slug);
    if (match === undefined) {
      return c.json(NOT_VISIBLE_BODY, 404);
    }
    c.set('layer', match);
    await next();
    return;
  };
}

function defaultResolverErrorSink(err: unknown): void {
  console.error('[layer-middleware] effectiveLayers failed:', err);
}
