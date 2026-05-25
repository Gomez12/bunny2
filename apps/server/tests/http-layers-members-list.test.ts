/**
 * Phase 2 (UI exposure gaps) — `GET /layers/:slug/members`.
 *
 * Covers:
 *   - empty project layer returns the empty sections.
 *   - populated layer hydrates `users` + `groups` with display fields
 *     (mirror of `AdminGroupDetailResponse`).
 *   - non-member sees the same 404 the rest of `/layers/:slug` routes
 *     return (visibility-leak invariant).
 *   - non-project layer returns `errors.layer.membersOnProject` — derived
 *     membership has no rows to list.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { seedUserAndSession } from './_helpers/auth';
import { makeTestApp, type TestApp } from './_helpers/app';
import { seedLayersIfNeeded } from '../src/layers/seed';
import { createGroupsRepo } from '../src/repos/groups-repo';

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
): Promise<Response> {
  return app.app.fetch(
    new Request(`http://localhost${url}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function getJson(app: TestApp, url: string, token: string): Promise<Response> {
  return app.app.fetch(
    new Request(`http://localhost${url}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

interface HydratedUserRow {
  readonly userId: string;
  readonly role: string;
  readonly createdAt: string;
  readonly user: { id: string; username: string; displayName: string };
}

interface HydratedGroupRow {
  readonly groupId: string;
  readonly role: string;
  readonly createdAt: string;
  readonly group: { id: string; slug: string; name: string };
}

interface MembersBody {
  readonly users: readonly HydratedUserRow[];
  readonly groups: readonly HydratedGroupRow[];
}

describe('GET /layers/:slug/members', () => {
  it('empty layer — only the creator is listed', async () => {
    fx = makeTestApp('bunny2-members-list-empty-');
    const { token: ownerToken, user: owner } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    await postJson(fx, '/layers', ownerToken, { type: 'project', slug: 'empty', name: 'Empty' });

    const res = await getJson(fx, '/layers/empty/members', ownerToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MembersBody;
    expect(body.users.length).toBe(1);
    expect(body.users[0]?.userId).toBe(owner.id);
    expect(body.users[0]?.role).toBe('owner');
    expect(body.users[0]?.user.username).toBe('alice');
    expect(body.groups.length).toBe(0);
  });

  it('populated layer — hydrates users + groups with display fields', async () => {
    fx = makeTestApp('bunny2-members-list-populated-');
    const { token: ownerToken } = seedUserAndSession(fx.db, { username: 'alice' });
    const { user: bob } = seedUserAndSession(fx.db, { username: 'bob', displayName: 'Bob B' });
    const groupsRepo = createGroupsRepo(fx.db);
    const groupId = crypto.randomUUID();
    groupsRepo.createGroup({
      id: groupId,
      slug: 'eng',
      name: 'Engineering',
      now: new Date().toISOString(),
    });

    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    await postJson(fx, '/layers', ownerToken, { type: 'project', slug: 'team', name: 'Team' });
    await postJson(fx, '/layers/team/members', ownerToken, { userId: bob.id });
    await postJson(fx, '/layers/team/members', ownerToken, { groupId });

    const res = await getJson(fx, '/layers/team/members', ownerToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MembersBody;
    expect(body.users.length).toBe(2);
    const bobRow = body.users.find((u) => u.userId === bob.id);
    expect(bobRow).toBeDefined();
    expect(bobRow?.user.displayName).toBe('Bob B');
    expect(bobRow?.role).toBe('member');

    expect(body.groups.length).toBe(1);
    expect(body.groups[0]?.groupId).toBe(groupId);
    expect(body.groups[0]?.group.slug).toBe('eng');
    expect(body.groups[0]?.group.name).toBe('Engineering');
  });

  it('non-member sees 404 (same leak shape as other /layers/:slug routes)', async () => {
    fx = makeTestApp('bunny2-members-list-authz-404-');
    const { token: ownerToken } = seedUserAndSession(fx.db, { username: 'alice' });
    const { token: outsiderToken } = seedUserAndSession(fx.db, { username: 'mallory' });
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

    const res = await getJson(fx, '/layers/private/members', outsiderToken);
    expect(res.status).toBe(404);
  });

  it('rejects on non-project layer with errors.layer.membersOnProject', async () => {
    fx = makeTestApp('bunny2-members-list-non-project-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    const res = await getJson(fx, '/layers/everyone/members', token);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.layer.membersOnProject');
  });
});
