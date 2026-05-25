/**
 * `GET /me/visible-users` + `GET /me/visible-groups`.
 *
 * Resolution of the layer-members-picker follow-up (see
 * `docs/dev/follow-ups/done/layer-members-picker.md`). The route is
 * the directory-disclosure boundary for non-admins: a caller sees
 * exactly the set of users / groups they share at least one
 * transitive group with. Self is excluded from the user list;
 * soft-deleted users + groups are excluded from both.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { seedUserAndSession } from './_helpers/auth';
import { makeTestApp, type TestApp } from './_helpers/app';
import { createGroupsRepo } from '../src/repos/groups-repo';
import { createUsersRepo } from '../src/repos/users-repo';

let fx: TestApp | null = null;
afterEach(() => {
  if (fx !== null) {
    fx.cleanup();
    fx = null;
  }
});

describe('GET /me/visible-users', () => {
  it('returns peers reachable via a shared transitive group, excluding self and soft-deleted users', async () => {
    fx = makeTestApp('bunny2-visible-users-');
    const groupsRepo = createGroupsRepo(fx.db);
    const usersRepo = createUsersRepo(fx.db);
    const nowIso = new Date().toISOString();

    // alice + bob + carol all in the same group; dave is in a
    // different group nobody else belongs to.
    const { user: alice, token: aliceToken } = seedUserAndSession(fx.db, { username: 'alice' });
    const { user: bob } = seedUserAndSession(fx.db, { username: 'bob' });
    const { user: carol } = seedUserAndSession(fx.db, { username: 'carol' });
    const { user: dave, token: daveToken } = seedUserAndSession(fx.db, { username: 'dave' });
    // Erin is in alice's group BUT is soft-deleted — must NOT appear.
    const { user: erin } = seedUserAndSession(fx.db, { username: 'erin' });

    const sharedGroup = groupsRepo.createGroup({
      id: crypto.randomUUID(),
      slug: 'team-shared',
      name: 'Team Shared',
      now: nowIso,
    });
    const isolatedGroup = groupsRepo.createGroup({
      id: crypto.randomUUID(),
      slug: 'team-isolated',
      name: 'Team Isolated',
      now: nowIso,
    });
    groupsRepo.addUserToGroup(alice.id, sharedGroup.id, nowIso);
    groupsRepo.addUserToGroup(bob.id, sharedGroup.id, nowIso);
    groupsRepo.addUserToGroup(carol.id, sharedGroup.id, nowIso);
    groupsRepo.addUserToGroup(dave.id, isolatedGroup.id, nowIso);
    groupsRepo.addUserToGroup(erin.id, sharedGroup.id, nowIso);
    usersRepo.softDeleteUser(erin.id, nowIso);

    fx.resolver.invalidateAll();

    const res = await fx.app.fetch(
      new Request('http://localhost/me/visible-users', {
        headers: { authorization: `Bearer ${aliceToken}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: { id: string; displayName: string }[] };
    const visibleIds = body.users.map((u) => u.id).sort();
    expect(visibleIds).toEqual([bob.id, carol.id].sort());
    // Self excluded.
    expect(visibleIds).not.toContain(alice.id);
    // Dave (no shared group) excluded.
    expect(visibleIds).not.toContain(dave.id);
    // Erin (soft-deleted) excluded.
    expect(visibleIds).not.toContain(erin.id);

    // Dave only sees nobody — no shared groups with anyone.
    const daveRes = await fx.app.fetch(
      new Request('http://localhost/me/visible-users', {
        headers: { authorization: `Bearer ${daveToken}` },
      }),
    );
    expect(daveRes.status).toBe(200);
    const daveBody = (await daveRes.json()) as { users: unknown[] };
    expect(daveBody.users).toEqual([]);
  });

  it('returns an empty list for a caller in no groups', async () => {
    fx = makeTestApp('bunny2-visible-users-lonely-');
    const { token } = seedUserAndSession(fx.db, { username: 'lonely' });
    const res = await fx.app.fetch(
      new Request('http://localhost/me/visible-users', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: unknown[] };
    expect(body.users).toEqual([]);
  });
});

describe('GET /me/visible-groups', () => {
  it('returns the caller’s transitive group set, sorted by name', async () => {
    fx = makeTestApp('bunny2-visible-groups-');
    const groupsRepo = createGroupsRepo(fx.db);
    const nowIso = new Date().toISOString();

    const { user: alice, token: aliceToken } = seedUserAndSession(fx.db, { username: 'alice' });
    const groupA = groupsRepo.createGroup({
      id: crypto.randomUUID(),
      slug: 'g-a',
      name: 'Aardig team',
      now: nowIso,
    });
    const groupB = groupsRepo.createGroup({
      id: crypto.randomUUID(),
      slug: 'g-b',
      name: 'Beleidsteam',
      now: nowIso,
    });
    const _other = groupsRepo.createGroup({
      id: crypto.randomUUID(),
      slug: 'g-other',
      name: 'Other (excluded)',
      now: nowIso,
    });
    groupsRepo.addUserToGroup(alice.id, groupA.id, nowIso);
    groupsRepo.addUserToGroup(alice.id, groupB.id, nowIso);
    fx.resolver.invalidateAll();

    const res = await fx.app.fetch(
      new Request('http://localhost/me/visible-groups', {
        headers: { authorization: `Bearer ${aliceToken}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      groups: { id: string; name: string; slug: string }[];
    };
    expect(body.groups.map((g) => g.id)).toEqual([groupA.id, groupB.id]);
    // The other group is filtered out.
    expect(body.groups.find((g) => g.id === _other.id)).toBeUndefined();
  });
});
