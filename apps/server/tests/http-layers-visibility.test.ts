/**
 * Phase 3.4 — `/layers/:slug/visibility` add / remove.
 *
 * Covers:
 *   - bottom_up happy path.
 *   - top_down / both rejected with errors.layer.visibilityDirectionNotSupported.
 *   - cycle rejected with errors.layer.visibilityCycle.
 *   - non-visible parent rejected.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { seedUserAndSession } from './_helpers/auth';
import { makeTestApp, type TestApp } from './_helpers/app';
import { seedLayersIfNeeded } from '../src/layers/seed';

let fx: TestApp | null = null;
afterEach(() => {
  if (fx !== null) {
    fx.cleanup();
    fx = null;
  }
});

async function postJson(
  app: TestApp,
  url: string,
  token: string,
  body: unknown,
  method: 'POST' | 'PATCH' | 'DELETE' = 'POST',
): Promise<Response> {
  return app.app.fetch(
    new Request(`http://localhost${url}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

describe('/layers/:slug/visibility', () => {
  it('adds a bottom_up edge to a visible parent', async () => {
    fx = makeTestApp('bunny2-vis-bottom-up-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    await postJson(fx, '/layers', token, {
      type: 'project',
      slug: 'child',
      name: 'Child',
    });
    await postJson(fx, '/layers', token, {
      type: 'project',
      slug: 'parent',
      name: 'Parent',
    });

    const res = await postJson(fx, '/layers/child/visibility', token, {
      parentSlug: 'parent',
      direction: 'bottom_up',
    });
    expect(res.status).toBe(201);
  });

  it('rejects top_down with errors.layer.visibilityDirectionNotSupported', async () => {
    fx = makeTestApp('bunny2-vis-top-down-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    await postJson(fx, '/layers', token, {
      type: 'project',
      slug: 'a',
      name: 'A',
    });
    await postJson(fx, '/layers', token, {
      type: 'project',
      slug: 'b',
      name: 'B',
    });
    const res = await postJson(fx, '/layers/a/visibility', token, {
      parentSlug: 'b',
      direction: 'top_down',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.layer.visibilityDirectionNotSupported');
  });

  it('rejects both with errors.layer.visibilityDirectionNotSupported', async () => {
    fx = makeTestApp('bunny2-vis-both-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    await postJson(fx, '/layers', token, {
      type: 'project',
      slug: 'a',
      name: 'A',
    });
    await postJson(fx, '/layers', token, {
      type: 'project',
      slug: 'b',
      name: 'B',
    });
    const res = await postJson(fx, '/layers/a/visibility', token, {
      parentSlug: 'b',
      direction: 'both',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.layer.visibilityDirectionNotSupported');
  });

  it('rejects a cycle: a → b, then b → a closes a loop', async () => {
    fx = makeTestApp('bunny2-vis-cycle-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    await postJson(fx, '/layers', token, { type: 'project', slug: 'a', name: 'A' });
    await postJson(fx, '/layers', token, { type: 'project', slug: 'b', name: 'B' });

    // a's parent = b (bottom_up).
    const r1 = await postJson(fx, '/layers/a/visibility', token, {
      parentSlug: 'b',
      direction: 'bottom_up',
    });
    expect(r1.status).toBe(201);

    // b's parent = a would close a cycle.
    const r2 = await postJson(fx, '/layers/b/visibility', token, {
      parentSlug: 'a',
      direction: 'bottom_up',
    });
    expect(r2.status).toBe(400);
    const body = (await r2.json()) as { error: string };
    expect(body.error).toBe('errors.layer.visibilityCycle');
  });

  it('returns the same 404 for an unknown parent slug and a not-visible parent (no slug-existence leak)', async () => {
    // Phase 3.6 — closed the slug-existence probe channel. Previously
    // "parent doesn't exist" returned 400 errors.layer.visibilityParentNotFound
    // while "parent exists but I can't see it" returned 400
    // errors.layer.visibilityParentNotVisible, letting a caller
    // distinguish the two by comparing error codes at the same status.
    // The two branches now return byte-identical 404 responses. See
    // ADR 0010 and the phase-3 close-out §14.
    fx = makeTestApp('bunny2-vis-parent-private-');
    const { token: aToken } = seedUserAndSession(fx.db, { username: 'alice' });
    const { token: bToken } = seedUserAndSession(fx.db, { username: 'bob' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    // alice owns 'private'.
    await postJson(fx, '/layers', aToken, {
      type: 'project',
      slug: 'private',
      name: 'Private',
    });
    // bob owns 'mine'.
    await postJson(fx, '/layers', bToken, {
      type: 'project',
      slug: 'mine',
      name: 'Mine',
    });

    // 1. bob tries to attach 'mine' to 'private' (exists, but bob
    //    can't see it).
    const hiddenRes = await postJson(fx, '/layers/mine/visibility', bToken, {
      parentSlug: 'private',
      direction: 'bottom_up',
    });
    expect(hiddenRes.status).toBe(404);
    const hiddenBody = (await hiddenRes.json()) as { error: string };
    expect(hiddenBody.error).toBe('errors.layer.visibilityParentNotFound');

    // 2. bob tries to attach 'mine' to 'does-not-exist'. Identical
    //    shape — bob cannot distinguish the two cases.
    const missingRes = await postJson(fx, '/layers/mine/visibility', bToken, {
      parentSlug: 'does-not-exist',
      direction: 'bottom_up',
    });
    expect(missingRes.status).toBe(404);
    const missingBody = (await missingRes.json()) as { error: string };
    expect(missingBody.error).toBe('errors.layer.visibilityParentNotFound');
  });
});
