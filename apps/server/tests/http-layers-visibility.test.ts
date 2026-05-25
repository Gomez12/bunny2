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
import { createLayersRepo } from '../src/repos/layers-repo';
import { createLayerMembersRepo } from '../src/repos/layer-members-repo';
import { createLayerVisibilityRepo } from '../src/repos/layer-visibility-repo';

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

  // ----- GET /layers/:slug/visibility (follow-up layer-visibility-list) -----

  async function getJson(app: TestApp, url: string, token: string): Promise<Response> {
    return app.app.fetch(
      new Request(`http://localhost${url}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  }

  interface VisibilityListRow {
    relation: 'parent' | 'child';
    parentLayerId: string;
    parentSlug: string;
    parentName: string;
    direction: string;
    createdAt: string;
  }

  it('GET /layers/:slug/visibility returns both inbound and outbound edges with relation discriminator', async () => {
    fx = makeTestApp('bunny2-vis-list-hit-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    await postJson(fx, '/layers', token, { type: 'project', slug: 'p', name: 'P' });
    await postJson(fx, '/layers', token, { type: 'project', slug: 'c1', name: 'C1' });
    await postJson(fx, '/layers', token, { type: 'project', slug: 'c2', name: 'C2' });

    // c1 inherits FROM p; p is inherited BY c1 and c2.
    await postJson(fx, '/layers/c1/visibility', token, {
      parentSlug: 'p',
      direction: 'bottom_up',
    });
    await postJson(fx, '/layers/c2/visibility', token, {
      parentSlug: 'p',
      direction: 'bottom_up',
    });

    const res = await getJson(fx, '/layers/p/visibility', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { edges: readonly VisibilityListRow[] };
    // p has no parents (no `bottom_up` edge from a non-everyone layer
    // to p was created here, but the `everyone → p` edge from layer
    // creation IS present), so we expect at least one 'parent' row
    // pointing at 'everyone' AND two 'child' rows for c1 and c2.
    const children = body.edges.filter((e) => e.relation === 'child');
    expect(children.length).toBe(2);
    const childSlugs = children.map((e) => e.parentSlug).sort();
    expect(childSlugs).toEqual(['c1', 'c2']);

    const parents = body.edges.filter((e) => e.relation === 'parent');
    // The seed flow attaches every new project layer to 'everyone'
    // with a bottom_up edge, so 'p' has 'everyone' as its parent.
    expect(parents.some((e) => e.parentSlug === 'everyone')).toBe(true);
  });

  it('GET /layers/:slug/visibility 404s for a caller who cannot see the layer', async () => {
    fx = makeTestApp('bunny2-vis-list-miss-');
    const owner = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    await postJson(fx, '/layers', owner.token, {
      type: 'project',
      slug: 'private',
      name: 'P',
    });

    const stranger = seedUserAndSession(fx.db, { username: 'mallory' });
    const res = await getJson(fx, '/layers/private/visibility', stranger.token);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.layer.notVisible');
  });

  it('GET /layers/:slug/visibility omits edges whose other side is not visible to the caller (redaction)', async () => {
    fx = makeTestApp('bunny2-vis-list-redact-');
    const alice = seedUserAndSession(fx.db, { username: 'alice' });
    const bob = seedUserAndSession(fx.db, { username: 'bob' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });

    // alice owns both. p is private to alice; c is shared with bob.
    await postJson(fx, '/layers', alice.token, { type: 'project', slug: 'p', name: 'P' });
    await postJson(fx, '/layers', alice.token, { type: 'project', slug: 'c', name: 'C' });

    // Add bob as a member of c only (not p), via the repo so we don't
    // need a second HTTP round-trip and to avoid touching admin auth.
    const layersRepo = createLayersRepo(fx.db);
    const cLayer = layersRepo.getLayerBySlug('c');
    const pLayer = layersRepo.getLayerBySlug('p');
    if (cLayer === null || pLayer === null) throw new Error('test setup: layers missing');
    const bobUser = fx.db
      .query<{ id: string }, [string]>('SELECT id FROM users WHERE username = ?')
      .get('bob');
    if (bobUser === null) throw new Error('test setup: bob missing');
    createLayerMembersRepo(fx.db).addUserMember({
      layerId: cLayer.id,
      userId: bobUser.id,
      role: 'member',
      now: new Date().toISOString(),
    });

    // Insert a `top_down` edge from p (parent) → c (child) directly
    // via the repo. The route only accepts `bottom_up` in v1 (see
    // §11.6), but the visibility-resolver's `walkEdges` skips
    // top_down child→parent expansion, so bob — who is only a member
    // of c — does NOT gain visibility of p through this edge. That's
    // precisely the redaction scenario we need: an edge that touches
    // c on the server but whose "other side" is invisible to bob.
    const visibilityRepo = createLayerVisibilityRepo(fx.db);
    visibilityRepo.addEdge({
      parentLayerId: pLayer.id,
      childLayerId: cLayer.id,
      direction: 'top_down',
      now: new Date().toISOString(),
    });

    // Resolver caches effective sets per user — invalidate so bob's
    // next request reflects the new membership.
    fx.layerResolver.invalidate();

    const res = await getJson(fx, '/layers/c/visibility', bob.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { edges: readonly VisibilityListRow[] };
    // The p → c edge exists on the server, but p is not in bob's
    // effective set, so the row pointing at p must be omitted
    // entirely (no redacted placeholder). The 'everyone → c' edge
    // from layer creation IS visible to bob since everyone is in
    // every user's effective set, so it surfaces as one 'parent'
    // row. Net result: exactly one edge, and none of them point at
    // the hidden 'p' layer.
    expect(body.edges.some((e) => e.parentSlug === 'p')).toBe(false);
    expect(body.edges.some((e) => e.parentSlug === 'everyone')).toBe(true);
  });
});
