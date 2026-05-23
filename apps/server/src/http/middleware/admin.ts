import type { Database } from 'bun:sqlite';
import type { MiddlewareHandler } from 'hono';
import type { GroupResolver } from '../../auth/group-resolver';
import { ADMIN_GROUP_ID_KEY } from '../../auth/seed';
import { getMeta } from '../../storage/kv-meta';
import type { HonoVariables } from '../types';

/**
 * `requireAdmin` — third-tier gate that runs AFTER `requireAuth` and
 * AFTER `requirePasswordCurrent`. Mounted ONLY on `/admin/*` routes; do
 * not register globally.
 *
 * Looks up `admin_group_id` from `kv_meta` exactly once at factory
 * construction. If the seed has not run the lookup returns `null`, the
 * factory logs once, and every subsequent request to an admin route
 * returns 503 with `errors.admin.notSeeded`. Production wires the seed
 * before `Bun.serve` starts so the 503 branch is reachable only in
 * tests that exercise the unseeded path on purpose.
 *
 * On the happy path the middleware calls
 * `resolver.isUserInGroup(user.id, adminGroupId)`. A `true` answer →
 * `next()`; `false` → `403 { error: 'errors.admin.forbidden' }`.
 */

const FORBIDDEN_BODY = { error: 'errors.admin.forbidden' } as const;
const NOT_SEEDED_BODY = { error: 'errors.admin.notSeeded' } as const;

export interface CreateRequireAdminOptions {
  readonly db: Database;
  readonly resolver: GroupResolver;
  /** Sink for the one-time "seed not run" warning. Default: `console.warn`. */
  readonly logger?: (line: string) => void;
}

export function createRequireAdmin(
  opts: CreateRequireAdminOptions,
): MiddlewareHandler<{ Variables: HonoVariables }> {
  const log = opts.logger ?? ((line: string) => console.warn(line));
  const adminGroupId = getMeta(opts.db, ADMIN_GROUP_ID_KEY);

  let warned = false;
  return async (c, next) => {
    if (adminGroupId === null || adminGroupId === '') {
      if (!warned) {
        warned = true;
        log(
          '[require-admin] admin_group_id missing from kv_meta — admin routes are 503ing until the seed runs',
        );
      }
      return c.json(NOT_SEEDED_BODY, 503);
    }
    const user = c.get('user');
    if (user === undefined) {
      // Auth middleware should already have produced a 401. Defence in
      // depth — never expose admin routes to an unauthenticated caller.
      return c.json(FORBIDDEN_BODY, 403);
    }
    if (!opts.resolver.isUserInGroup(user.id, adminGroupId)) {
      return c.json(FORBIDDEN_BODY, 403);
    }
    await next();
    return;
  };
}
