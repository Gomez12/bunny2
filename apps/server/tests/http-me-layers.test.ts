/**
 * Phase 3.4 — `GET /me/layers` + `GET /layers` (filters, includeDeleted).
 *
 * - happy path: a user with no project memberships sees the
 *   `everyone` layer plus their personal layer plus their group layers.
 * - filter: `?type=` narrows the set.
 * - admin includeDeleted: a soft-deleted layer is hidden by default;
 *   the seeded admin sees it when `?includeDeleted=true`.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { loginSeededAdminRotated, seedNonAdminUser, seedUserAndSession } from './_helpers/auth';
import { makeTestApp, makeTestAppSeeded, type TestApp } from './_helpers/app';
import { createLayersRepo } from '../src/repos/layers-repo';
import { seedLayersIfNeeded } from '../src/layers/seed';
import type { Layer } from '../src/repos/layers-repo';

let fx: TestApp | null = null;
afterEach(() => {
  if (fx !== null) {
    fx.cleanup();
    fx = null;
  }
});

describe('GET /me/layers + GET /layers', () => {
  it('returns the caller’s effective layers (everyone + personal) for a plain user', async () => {
    fx = makeTestApp('bunny2-me-layers-');
    // Seed a user + session, then run the layer seed against the same
    // db. The user has a personal layer after seeding; everyone exists
    // unconditionally.
    const { user, token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    void user;

    const res = await fx.app.fetch(
      new Request('http://localhost/me/layers', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { layers: Layer[] };
    const slugs = body.layers.map((l) => l.slug).sort();
    expect(slugs).toContain('everyone');
    expect(slugs).toContain('personal-alice');
  });

  it('applies the type filter on GET /layers', async () => {
    fx = makeTestApp('bunny2-layers-filter-');
    const { token } = seedUserAndSession(fx.db, { username: 'bob' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    const res = await fx.app.fetch(
      new Request('http://localhost/layers?type=everyone', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { layers: Layer[] };
    expect(body.layers).toHaveLength(1);
    expect(body.layers[0]?.slug).toBe('everyone');
  });

  it('site-admin can see soft-deleted layers via ?includeDeleted=true', async () => {
    const seeded = await makeTestAppSeeded('bunny2-layers-deleted-');
    fx = seeded;
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });

    // Create a throwaway project layer through the API, then soft-
    // delete it via direct repo write (the admin owns nothing yet).
    const repo = createLayersRepo(fx.db);
    const created = repo.insertLayer({
      id: crypto.randomUUID(),
      type: 'project',
      slug: 'throwaway',
      name: 'Throwaway',
      now: new Date().toISOString(),
    });
    repo.softDeleteLayer(created.id, new Date().toISOString());

    // Without the toggle the soft-deleted layer is hidden.
    const without = await fx.app.fetch(
      new Request('http://localhost/layers', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    const withoutBody = (await without.json()) as { layers: Layer[] };
    expect(withoutBody.layers.some((l) => l.slug === 'throwaway')).toBe(false);

    // With the toggle the site-admin sees it (and the deleted_at is
    // non-null, proving the source is the include-deleted listing).
    const withDeleted = await fx.app.fetch(
      new Request('http://localhost/layers?includeDeleted=true', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    const withBody = (await withDeleted.json()) as { layers: Layer[] };
    const tw = withBody.layers.find((l) => l.slug === 'throwaway');
    expect(tw).toBeDefined();
    expect(tw?.deletedAt).not.toBeNull();
  });

  it('non-admin ignored when includeDeleted=true (silently same as false)', async () => {
    fx = makeTestApp('bunny2-layers-deleted-na-');
    const { token } = seedUserAndSession(fx.db, { username: 'charlie' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    // Soft-delete the everyone layer for the test (yes, weird — we
    // need at least one deleted row to assert the toggle is a no-op).
    const repo = createLayersRepo(fx.db);
    const everyone = repo.getLayerBySlug('everyone');
    if (everyone === null) throw new Error('test setup: everyone missing');
    repo.softDeleteLayer(everyone.id, new Date().toISOString());

    const res = await fx.app.fetch(
      new Request('http://localhost/layers?includeDeleted=true', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    const body = (await res.json()) as { layers: Layer[] };
    expect(body.layers.some((l) => l.slug === 'everyone')).toBe(false);

    // Also verify the helper imports are alive.
    void seedNonAdminUser;
  });
});
