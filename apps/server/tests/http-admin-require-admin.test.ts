/**
 * Phase 2.4 — `requireAdmin` middleware.
 *
 * Three branches:
 *  - non-admin user → 403 errors.admin.forbidden
 *  - seeded admin → 200 on the same route
 *  - admin seed has NOT run → 503 errors.admin.notSeeded
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { makeTestApp, makeTestAppSeeded, type TestApp } from './_helpers/app';
import { loginSeededAdminRotated, seedNonAdminUser } from './_helpers/auth';

describe('requireAdmin middleware', () => {
  let t: TestApp;
  afterEach(() => t?.cleanup());

  describe('on a seeded data-dir', () => {
    beforeEach(async () => {
      t = await makeTestAppSeeded('bunny2-require-admin-seeded-');
    });

    it('returns 200 for the seeded admin user', async () => {
      const admin = await loginSeededAdminRotated({
        db: t.db,
        bus: t.bus,
        app: t.app,
        seedLog: t.seedLog,
      });
      const res = await t.app.fetch(
        new Request('http://localhost/admin/groups', {
          headers: { authorization: `Bearer ${admin.token}` },
        }),
      );
      expect(res.status).toBe(200);
    });

    it('returns 403 errors.admin.forbidden for a freshly created non-admin user', async () => {
      const user = await seedNonAdminUser({ db: t.db, app: t.app }, { username: 'noadmin' });
      const res = await t.app.fetch(
        new Request('http://localhost/admin/groups', {
          headers: { authorization: `Bearer ${user.token}` },
        }),
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('errors.admin.forbidden');
    });
  });

  describe('on an UNSEEDED data-dir', () => {
    beforeEach(() => {
      // Default `makeTestApp` does NOT run the admin seed. The
      // `requireAdmin` factory reads `admin_group_id` at construction
      // and finds it null — every admin route must 503.
      t = makeTestApp('bunny2-require-admin-unseeded-');
    });

    it('returns 503 errors.admin.notSeeded even with a valid session', async () => {
      // We still need a valid session to reach `requireAdmin` (since
      // `requireAuth` would otherwise 401 first). Stamp one in via the
      // shared session helper.
      const user = await seedNonAdminUser({ db: t.db, app: t.app }, { username: 'orphan' });
      const res = await t.app.fetch(
        new Request('http://localhost/admin/groups', {
          headers: { authorization: `Bearer ${user.token}` },
        }),
      );
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe('errors.admin.notSeeded');
    });
  });
});
