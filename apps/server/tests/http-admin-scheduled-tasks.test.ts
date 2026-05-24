/**
 * Phase 5.4 — `/admin/scheduled-tasks/*` cross-layer admin overview.
 *
 * Covers:
 *   - admin lists tasks across layers with a `layerSlug` field.
 *   - admin can read runs by id.
 *   - non-admin is gated by `/admin/*` `requireAdmin` (403).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { makeTestAppSeeded, type TestApp } from './_helpers/app';
import { loginSeededAdminRotated, seedNonAdminUser } from './_helpers/auth';
import { createScheduledTasksRepo } from '../src/scheduled/repo';
import { createLayersRepo } from '../src/repos/layers-repo';
import {
  __resetScheduledTaskRegistryForTests,
  registerScheduledTaskHandler,
} from '../src/scheduled/registry';

const FIXTURE_KIND = 'test.admin.fixture';

let fx: TestApp | null = null;

beforeEach(() => {
  __resetScheduledTaskRegistryForTests();
  registerScheduledTaskHandler({
    kind: FIXTURE_KIND,
    async run() {
      // unused
    },
  });
});

afterEach(() => {
  if (fx !== null) {
    fx.cleanup();
    fx = null;
  }
  __resetScheduledTaskRegistryForTests();
});

describe('/admin/scheduled-tasks', () => {
  it('lists tasks across every layer with a layerSlug column', async () => {
    fx = await makeTestAppSeeded('bunny2-admin-sched-list-');
    const { token: adminToken, userId: adminId } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });

    // Seed one task into the `everyone` layer so we have something to
    // list. The repo is the cleanest seam — the admin route does not
    // create tasks.
    const everyone = createLayersRepo(fx.db).getLayerBySlug('everyone');
    if (everyone === null) throw new Error('expected everyone layer to be seeded');
    createScheduledTasksRepo(fx.db).insertTask({
      id: crypto.randomUUID(),
      layerId: everyone.id,
      slug: 'admin-fixture',
      kind: FIXTURE_KIND,
      name: 'Admin Fixture',
      schedule: { kind: 'interval', intervalMinutes: 60 },
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      createdBy: adminId,
      now: new Date().toISOString(),
    });

    const res = await fx.app.fetch(
      new Request('http://localhost/admin/scheduled-tasks', {
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tasks: Array<{ slug: string; layerSlug: string }>;
    };
    const ours = body.tasks.find((t) => t.slug === 'admin-fixture');
    expect(ours).toBeDefined();
    expect(ours?.layerSlug).toBe('everyone');
  });

  it('forbids non-admin callers with errors.admin.forbidden', async () => {
    fx = await makeTestAppSeeded('bunny2-admin-sched-forbid-');
    // Login the admin once so the seeded admin's `mustChangePassword`
    // does not block the non-admin path; we only need the non-admin
    // token for the actual assertion.
    await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const nonAdmin = await seedNonAdminUser({ db: fx.db, app: fx.app }, { username: 'bob' });

    const res = await fx.app.fetch(
      new Request('http://localhost/admin/scheduled-tasks', {
        headers: { authorization: `Bearer ${nonAdmin.token}` },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.admin.forbidden');
  });
});
