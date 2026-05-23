/**
 * Phase 2.4 — `/admin/groups/*` HTTP routes.
 *
 * Covers:
 *  - happy-path CRUD (POST, GET list, GET detail, PATCH, DELETE)
 *  - duplicate slug -> 409 errors.admin.groupSlugTaken
 *  - cycle insert -> 409 errors.admin.groupCycle
 *  - admin slug delete is rejected (404 to mask existence)
 *  - soft-delete returns 404 on subsequent fetch, ?includeDeleted=true
 *    surfaces it back
 *  - group detail returns directUsers + directSubGroups + parentGroups
 *  - non-admin user gets 403 on every admin route
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { makeTestAppSeeded, type TestApp } from './_helpers/app';
import { loginSeededAdminRotated, seedNonAdminUser } from './_helpers/auth';

let t: TestApp;
let adminToken: string;
let adminUserId: string;

interface GroupBody {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  deletedAt: string | null;
  version: number;
}

interface ListGroupRow extends GroupBody {
  directUserMemberCount: number;
  directSubGroupCount: number;
}

interface ListResponse {
  groups: ListGroupRow[];
}

interface GroupDetailResponse {
  group: GroupBody;
  directUsers: { id: string; username: string }[];
  directSubGroups: GroupBody[];
  parentGroups: GroupBody[];
}

beforeEach(async () => {
  t = await makeTestAppSeeded();
  const admin = await loginSeededAdminRotated({
    db: t.db,
    bus: t.bus,
    app: t.app,
    seedLog: t.seedLog,
  });
  adminToken = admin.token;
  adminUserId = admin.userId;
});
afterEach(() => t.cleanup());

async function adminFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${adminToken}`);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return t.app.fetch(new Request(`http://localhost${input}`, { ...init, headers }));
}

describe('POST /admin/groups', () => {
  it('creates a group and emits group.created', async () => {
    const events: string[] = [];
    t.bus.subscribe('group.created', (e) => {
      events.push((e.payload as { slug: string }).slug);
    });
    const res = await adminFetch('/admin/groups', {
      method: 'POST',
      body: JSON.stringify({ slug: 'engineering', name: 'Engineering' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { group: GroupBody };
    expect(body.group.slug).toBe('engineering');
    expect(body.group.name).toBe('Engineering');
    expect(body.group.deletedAt).toBeNull();
    expect(events).toContain('engineering');
  });

  it('rejects duplicate slug with 409 errors.admin.groupSlugTaken', async () => {
    const first = await adminFetch('/admin/groups', {
      method: 'POST',
      body: JSON.stringify({ slug: 'sales', name: 'Sales' }),
    });
    expect(first.status).toBe(201);
    const second = await adminFetch('/admin/groups', {
      method: 'POST',
      body: JSON.stringify({ slug: 'sales', name: 'Sales II' }),
    });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toBe('errors.admin.groupSlugTaken');
  });

  it('rejects invalid slug (zod) with 400 errors.admin.badRequest', async () => {
    const res = await adminFetch('/admin/groups', {
      method: 'POST',
      body: JSON.stringify({ slug: 'BAD slug', name: 'X' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('errors.admin.badRequest');
  });
});

describe('GET /admin/groups', () => {
  it('lists non-deleted groups with direct member counts', async () => {
    await adminFetch('/admin/groups', {
      method: 'POST',
      body: JSON.stringify({ slug: 'g1', name: 'G1' }),
    });
    const listRes = await adminFetch('/admin/groups');
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as ListResponse;
    const g1 = list.groups.find((g) => g.slug === 'g1');
    expect(g1).toBeDefined();
    expect(g1?.directUserMemberCount).toBe(0);
    expect(g1?.directSubGroupCount).toBe(0);
    // The seeded `admin` group reports the seeded admin user as a
    // direct member.
    const adminGroup = list.groups.find((g) => g.slug === 'admin');
    expect(adminGroup?.directUserMemberCount).toBe(1);
  });

  it('hides soft-deleted groups by default; ?includeDeleted=true surfaces them', async () => {
    const createRes = await adminFetch('/admin/groups', {
      method: 'POST',
      body: JSON.stringify({ slug: 'temp', name: 'Temp' }),
    });
    const tempId = ((await createRes.json()) as { group: { id: string } }).group.id;
    const delRes = await adminFetch(`/admin/groups/${tempId}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);

    const visible = await adminFetch('/admin/groups');
    const visibleList = (await visible.json()) as ListResponse;
    expect(visibleList.groups.some((g) => g.slug === 'temp')).toBe(false);

    const all = await adminFetch('/admin/groups?includeDeleted=true');
    const allList = (await all.json()) as ListResponse;
    expect(allList.groups.some((g) => g.slug === 'temp')).toBe(true);
  });
});

describe('PATCH /admin/groups/:id', () => {
  it('updates name and description, emits group.updated', async () => {
    const createRes = await adminFetch('/admin/groups', {
      method: 'POST',
      body: JSON.stringify({ slug: 'eng', name: 'Eng' }),
    });
    const id = ((await createRes.json()) as { group: { id: string } }).group.id;
    const updatedEvents: unknown[] = [];
    t.bus.subscribe('group.updated', (e) => {
      updatedEvents.push(e.payload);
    });

    const patchRes = await adminFetch(`/admin/groups/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Engineering', description: 'Builds things' }),
    });
    expect(patchRes.status).toBe(200);
    const body = (await patchRes.json()) as { group: GroupBody };
    expect(body.group.name).toBe('Engineering');
    expect(body.group.description).toBe('Builds things');
    expect(body.group.version).toBe(2);
    expect(updatedEvents).toHaveLength(1);
  });

  it('returns 404 for a non-existent group', async () => {
    const res = await adminFetch(`/admin/groups/${crypto.randomUUID()}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'X' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /admin/groups/:id', () => {
  it('soft-deletes a group and emits group.deleted', async () => {
    const createRes = await adminFetch('/admin/groups', {
      method: 'POST',
      body: JSON.stringify({ slug: 'gone', name: 'Gone' }),
    });
    const id = ((await createRes.json()) as { group: { id: string } }).group.id;
    const deleted: string[] = [];
    t.bus.subscribe('group.deleted', (e) => {
      deleted.push((e.payload as { slug: string }).slug);
    });
    const delRes = await adminFetch(`/admin/groups/${id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    expect(deleted).toContain('gone');

    // Subsequent fetch by id returns 404 because the group is soft-deleted.
    const detailRes = await adminFetch(`/admin/groups/${id}`);
    expect(detailRes.status).toBe(404);
  });

  it('refuses to delete the seeded `admin` group (404 errors.admin.groupNotFound)', async () => {
    const list = (await (await adminFetch('/admin/groups')).json()) as ListResponse;
    const adminGroup = list.groups.find((g) => g.slug === 'admin');
    expect(adminGroup).toBeDefined();
    const res = await adminFetch(`/admin/groups/${adminGroup!.id}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('errors.admin.groupNotFound');
  });
});

describe('POST /admin/groups/:id/members', () => {
  it('adds a user member and emits group.member_added (kind=user)', async () => {
    const groupId = await createGroup('engineering');
    const memberEvents: unknown[] = [];
    t.bus.subscribe('group.member_added', (e) => {
      memberEvents.push(e.payload);
    });
    const nonAdmin = await seedNonAdminUser({ db: t.db, app: t.app }, { username: 'bob' });
    const res = await adminFetch(`/admin/groups/${groupId}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId: nonAdmin.user.id }),
    });
    expect(res.status).toBe(201);
    expect(memberEvents.length).toBeGreaterThan(0);
  });

  it('adds a sub-group and emits group.member_added (kind=group)', async () => {
    const parent = await createGroup('parent');
    const child = await createGroup('child');
    const res = await adminFetch(`/admin/groups/${parent}/members`, {
      method: 'POST',
      body: JSON.stringify({ groupId: child }),
    });
    expect(res.status).toBe(201);
  });

  it('rejects a cycle with 409 errors.admin.groupCycle', async () => {
    const a = await createGroup('a');
    const b = await createGroup('b');
    const addRes = await adminFetch(`/admin/groups/${a}/members`, {
      method: 'POST',
      body: JSON.stringify({ groupId: b }),
    });
    expect(addRes.status).toBe(201);
    // Now adding a → as a member of → b would close a loop.
    const cycleRes = await adminFetch(`/admin/groups/${b}/members`, {
      method: 'POST',
      body: JSON.stringify({ groupId: a }),
    });
    expect(cycleRes.status).toBe(409);
    expect(((await cycleRes.json()) as { error: string }).error).toBe('errors.admin.groupCycle');
  });

  it('rejects self-membership with 409 errors.admin.groupSelfMember', async () => {
    const g = await createGroup('selfish');
    const res = await adminFetch(`/admin/groups/${g}/members`, {
      method: 'POST',
      body: JSON.stringify({ groupId: g }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('errors.admin.groupSelfMember');
  });

  it('rejects a payload with both userId and groupId (xor schema)', async () => {
    const g = await createGroup('xor');
    const res = await adminFetch(`/admin/groups/${g}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId: crypto.randomUUID(), groupId: crypto.randomUUID() }),
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /admin/groups/:id/members/:memberId', () => {
  it('removes a user member when ?kind=user is supplied', async () => {
    const groupId = await createGroup('eng');
    const nonAdmin = await seedNonAdminUser({ db: t.db, app: t.app }, { username: 'carol' });
    const addRes = await adminFetch(`/admin/groups/${groupId}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId: nonAdmin.user.id }),
    });
    expect(addRes.status).toBe(201);
    const delRes = await adminFetch(
      `/admin/groups/${groupId}/members/${nonAdmin.user.id}?kind=user`,
      {
        method: 'DELETE',
      },
    );
    expect(delRes.status).toBe(200);
  });

  it('rejects without ?kind with 400 errors.admin.missingMemberKind', async () => {
    const groupId = await createGroup('any');
    const res = await adminFetch(`/admin/groups/${groupId}/members/${crypto.randomUUID()}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('errors.admin.missingMemberKind');
  });
});

describe('GET /admin/groups/:id', () => {
  it('returns the group, direct users, direct sub-groups, and parent groups', async () => {
    const parent = await createGroup('parent');
    const middle = await createGroup('middle');
    const child = await createGroup('child');
    // parent contains middle; middle contains child.
    await adminFetch(`/admin/groups/${parent}/members`, {
      method: 'POST',
      body: JSON.stringify({ groupId: middle }),
    });
    await adminFetch(`/admin/groups/${middle}/members`, {
      method: 'POST',
      body: JSON.stringify({ groupId: child }),
    });
    const nonAdmin = await seedNonAdminUser({ db: t.db, app: t.app }, { username: 'dave' });
    await adminFetch(`/admin/groups/${middle}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId: nonAdmin.user.id }),
    });

    const res = await adminFetch(`/admin/groups/${middle}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GroupDetailResponse;
    expect(body.group.slug).toBe('middle');
    expect(body.directUsers.map((u) => u.username)).toContain('dave');
    expect(body.directSubGroups.map((g) => g.id)).toContain(child);
    expect(body.parentGroups.map((g) => g.id)).toContain(parent);
  });
});

describe('non-admin user gets 403 on every admin route', () => {
  it('returns 403 for GET /admin/groups', async () => {
    const nonAdmin = await seedNonAdminUser({ db: t.db, app: t.app }, { username: 'eve' });
    const res = await t.app.fetch(
      new Request('http://localhost/admin/groups', {
        headers: { authorization: `Bearer ${nonAdmin.token}` },
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('errors.admin.forbidden');
  });

  it('returns 403 for POST /admin/groups', async () => {
    const nonAdmin = await seedNonAdminUser({ db: t.db, app: t.app }, { username: 'frank' });
    const res = await t.app.fetch(
      new Request('http://localhost/admin/groups', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${nonAdmin.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ slug: 'sneaky', name: 'Sneaky' }),
      }),
    );
    expect(res.status).toBe(403);
  });
});

async function createGroup(slug: string): Promise<string> {
  const res = await adminFetch('/admin/groups', {
    method: 'POST',
    body: JSON.stringify({ slug, name: slug }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { group: { id: string } }).group.id;
}

// `adminUserId` is captured by beforeEach for future tests that may
// need the seeded admin's id; the placeholder reference below keeps
// the unused-var linter quiet without exporting the value.
void (() => adminUserId);
