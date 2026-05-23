/**
 * Phase 3.4 — `/layers/:slug/members` add / remove.
 *
 * Covers:
 *   - add user member → second user's `/me/layers` includes the project
 *     (proves the visibility cascade through the resolver).
 *   - add group member → users in the group see the project.
 *   - non-project layer rejects the route.
 *   - delete user member.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { seedUserAndSession } from './_helpers/auth';
import { makeTestApp, type TestApp } from './_helpers/app';
import { seedLayersIfNeeded } from '../src/layers/seed';
import { createGroupsRepo } from '../src/repos/groups-repo';
import type { Layer } from '../src/repos/layers-repo';

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

describe('/layers/:slug/members', () => {
  it('adding a user member makes the project visible in /me/layers for them', async () => {
    fx = makeTestApp('bunny2-members-add-user-');
    const { token: ownerToken } = seedUserAndSession(fx.db, { username: 'alice' });
    const { token: addedToken, user: added } = seedUserAndSession(fx.db, {
      username: 'bob',
    });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    await postJson(fx, '/layers', ownerToken, {
      type: 'project',
      slug: 'shared',
      name: 'Shared',
    });

    // bob can not see the project yet.
    const before = await fx.app.fetch(
      new Request('http://localhost/me/layers', {
        headers: { authorization: `Bearer ${addedToken}` },
      }),
    );
    const beforeBody = (await before.json()) as { layers: Layer[] };
    expect(beforeBody.layers.some((l) => l.slug === 'shared')).toBe(false);

    // add bob as a member.
    const add = await postJson(fx, '/layers/shared/members', ownerToken, {
      userId: added.id,
    });
    expect(add.status).toBe(201);

    // bob now sees it.
    const after = await fx.app.fetch(
      new Request('http://localhost/me/layers', {
        headers: { authorization: `Bearer ${addedToken}` },
      }),
    );
    const afterBody = (await after.json()) as { layers: Layer[] };
    expect(afterBody.layers.some((l) => l.slug === 'shared')).toBe(true);
  });

  it('adding a group member makes the project visible to every user in the group', async () => {
    fx = makeTestApp('bunny2-members-add-group-');
    const { token: ownerToken } = seedUserAndSession(fx.db, { username: 'alice' });
    const { token: memberToken, user: member } = seedUserAndSession(fx.db, {
      username: 'charlie',
    });
    // Build a group, add charlie to it.
    const groups = createGroupsRepo(fx.db);
    const groupId = crypto.randomUUID();
    groups.createGroup({
      id: groupId,
      slug: 'eng',
      name: 'Engineering',
      now: new Date().toISOString(),
    });
    groups.addUserToGroup(member.id, groupId, new Date().toISOString());

    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    await postJson(fx, '/layers', ownerToken, {
      type: 'project',
      slug: 'team',
      name: 'Team',
    });

    // group-add: charlie should subsequently see the layer.
    const add = await postJson(fx, '/layers/team/members', ownerToken, {
      groupId,
    });
    expect(add.status).toBe(201);

    const me = await fx.app.fetch(
      new Request('http://localhost/me/layers', {
        headers: { authorization: `Bearer ${memberToken}` },
      }),
    );
    const meBody = (await me.json()) as { layers: Layer[] };
    expect(meBody.layers.some((l) => l.slug === 'team')).toBe(true);
  });

  it('rejects add-member on a non-project layer with errors.layer.membersOnProject', async () => {
    fx = makeTestApp('bunny2-members-non-project-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    const res = await postJson(fx, '/layers/everyone/members', token, {
      userId: crypto.randomUUID(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.layer.membersOnProject');
  });

  it('DELETE removes a member', async () => {
    fx = makeTestApp('bunny2-members-delete-');
    const { token: ownerToken } = seedUserAndSession(fx.db, { username: 'alice' });
    const { token: memberToken, user: member } = seedUserAndSession(fx.db, {
      username: 'bob',
    });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    await postJson(fx, '/layers', ownerToken, {
      type: 'project',
      slug: 'gone',
      name: 'Gone',
    });
    await postJson(fx, '/layers/gone/members', ownerToken, { userId: member.id });

    const del = await postJson(
      fx,
      `/layers/gone/members/${member.id}`,
      ownerToken,
      undefined,
      'DELETE',
    );
    expect(del.status).toBe(200);

    const me = await fx.app.fetch(
      new Request('http://localhost/me/layers', {
        headers: { authorization: `Bearer ${memberToken}` },
      }),
    );
    const meBody = (await me.json()) as { layers: Layer[] };
    expect(meBody.layers.some((l) => l.slug === 'gone')).toBe(false);
  });
});
