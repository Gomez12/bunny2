import type { MiddlewareHandler } from 'hono';
import type { HonoVariables } from '../types';

/**
 * `requirePasswordCurrent` — secondary gate that sits AFTER `requireAuth`.
 *
 * Phase-02 plan §4.1 (sub-phase 2.5) declares: when the signed-in user
 * carries `mustChangePassword === true`, every route except the two
 * password-rotation/exit doors must return 409 with the i18n key
 * `errors.auth.mustChangePassword`.
 *
 * The two exits:
 *
 *   - `POST /auth/password`  → the rotation endpoint itself.
 *   - `POST /auth/logout`    → bail out without rotating.
 *
 * Both are encoded as exempt paths so the gate is a pure positive list.
 * Public routes (login, status) never reach this middleware — they short-
 * circuit in `requireAuth` first — so we do not need to re-enumerate
 * them here.
 */

const EXEMPT_PATHS: ReadonlySet<string> = new Set<string>([
  'POST /auth/password',
  'POST /auth/logout',
]);

const MUST_CHANGE_BODY = { error: 'errors.auth.mustChangePassword' } as const;

export function requirePasswordCurrent(): MiddlewareHandler<{ Variables: HonoVariables }> {
  return async (c, next) => {
    // `requireAuth` runs first; if it let the request through then a
    // user is attached. We still defensively check rather than relying
    // on a non-null assertion, in case someone wires this gate without
    // the auth middleware in front.
    const user = c.get('user');
    if (user === undefined) {
      await next();
      return;
    }
    if (!user.mustChangePassword) {
      await next();
      return;
    }
    if (EXEMPT_PATHS.has(`${c.req.method} ${c.req.path}`)) {
      await next();
      return;
    }
    return c.json(MUST_CHANGE_BODY, 409);
  };
}
