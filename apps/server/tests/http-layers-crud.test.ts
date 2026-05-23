/**
 * Phase 3.4 — `/layers/*` CRUD.
 *
 * Covers:
 *   - POST /layers as a plain user; caller becomes owner.
 *   - POST /layers rejects non-project types.
 *   - PATCH /layers/:slug owner-only with the 404 (non-visible) vs
 *     403 (visible but not editable) asymmetry.
 *   - DELETE rejects personal / group / everyone layers.
 *   - DELETE soft-deletes a project layer end-to-end.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { seedUserAndSession } from './_helpers/auth';
import { makeTestApp, type TestApp } from './_helpers/app';
import { seedLayersIfNeeded } from '../src/layers/seed';
import { createLayersRepo, type Layer } from '../src/repos/layers-repo';
import { createLayerMembersRepo } from '../src/repos/layer-members-repo';

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

describe('/layers CRUD', () => {
  it('lets any authenticated user create a project layer and records them as owner', async () => {
    fx = makeTestApp('bunny2-crud-create-');
    const { token, user } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });

    const res = await postJson(fx, '/layers', token, {
      type: 'project',
      slug: 'bunny2',
      name: 'Bunny2',
      description: 'An app',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { layer: Layer };
    expect(body.layer.slug).toBe('bunny2');
    expect(body.layer.type).toBe('project');

    const members = createLayerMembersRepo(fx.db).listUserMembers(body.layer.id);
    expect(members).toHaveLength(1);
    expect(members[0]?.userId).toBe(user.id);
    expect(members[0]?.role).toBe('owner');
  });

  it('rejects POST /layers when type is not project', async () => {
    fx = makeTestApp('bunny2-crud-notype-');
    const { token } = seedUserAndSession(fx.db, { username: 'bob' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    const res = await postJson(fx, '/layers', token, {
      type: 'personal',
      slug: 'should-fail',
      name: 'Nope',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.layer.typeNotCreatable');
  });

  it('PATCH /layers/:slug is owner-only — 403 for a non-owner visible member', async () => {
    fx = makeTestApp('bunny2-crud-patch-');
    const { token: ownerToken, user: owner } = seedUserAndSession(fx.db, {
      username: 'alice',
    });
    const { token: memberToken, user: member } = seedUserAndSession(fx.db, {
      username: 'bob',
    });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });

    // owner creates the layer
    const createRes = await postJson(fx, '/layers', ownerToken, {
      type: 'project',
      slug: 'p1',
      name: 'P1',
    });
    expect(createRes.status).toBe(201);

    // owner adds member as a plain `member` role
    const addRes = await postJson(fx, '/layers/p1/members', ownerToken, {
      userId: member.id,
      role: 'member',
    });
    expect(addRes.status).toBe(201);

    // member can PATCH? No — visible (member can see it) but not editable.
    const patchAsMember = await postJson(
      fx,
      '/layers/p1',
      memberToken,
      { name: 'P1 renamed' },
      'PATCH',
    );
    expect(patchAsMember.status).toBe(403);
    const memberBody = (await patchAsMember.json()) as { error: string };
    expect(memberBody.error).toBe('errors.layer.forbidden');

    // owner can PATCH
    const patchAsOwner = await postJson(fx, '/layers/p1', ownerToken, { name: 'P1 v2' }, 'PATCH');
    expect(patchAsOwner.status).toBe(200);
    const ownerBody = (await patchAsOwner.json()) as { layer: Layer };
    expect(ownerBody.layer.name).toBe('P1 v2');
    expect(ownerBody.layer.version).toBe(2);
    void owner;
  });

  it('PATCH /layers/:slug returns 404 (not 403) for a non-visible slug', async () => {
    fx = makeTestApp('bunny2-crud-patch-notvisible-');
    const { token: ownerToken } = seedUserAndSession(fx.db, { username: 'alice' });
    const { token: outsiderToken } = seedUserAndSession(fx.db, { username: 'charlie' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    await postJson(fx, '/layers', ownerToken, {
      type: 'project',
      slug: 'private',
      name: 'Private',
    });
    const res = await postJson(fx, '/layers/private', outsiderToken, { name: 'tried' }, 'PATCH');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.layer.notVisible');
  });

  it('DELETE rejects personal layers with errors.layer.notDeletable', async () => {
    fx = makeTestApp('bunny2-crud-delete-personal-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    const res = await postJson(fx, '/layers/personal-alice', token, undefined, 'DELETE');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.layer.notDeletable');
  });

  it('DELETE rejects everyone layer', async () => {
    fx = makeTestApp('bunny2-crud-delete-everyone-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    // The plain user is not site-admin, so they will hit FORBIDDEN
    // before NOT_DELETABLE — same protective effect: cannot delete.
    const res = await postJson(fx, '/layers/everyone', token, undefined, 'DELETE');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.layer.forbidden');
  });

  it('DELETE on a project layer soft-deletes and disappears from /me/layers for the owner', async () => {
    fx = makeTestApp('bunny2-crud-delete-project-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    await postJson(fx, '/layers', token, {
      type: 'project',
      slug: 'gone',
      name: 'Gone',
    });

    const del = await postJson(fx, '/layers/gone', token, undefined, 'DELETE');
    expect(del.status).toBe(200);

    // The resolver subscriber to `layer.deleted` invalidated the cache,
    // and the row is soft-deleted, so the next /me/layers excludes it.
    const me = await fx.app.fetch(
      new Request('http://localhost/me/layers', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    const meBody = (await me.json()) as { layers: Layer[] };
    expect(meBody.layers.some((l) => l.slug === 'gone')).toBe(false);

    // The row still exists in SQL as soft-deleted.
    const row = createLayersRepo(fx.db).getLayerBySlug('gone');
    expect(row?.deletedAt).not.toBeNull();
  });
});
