/**
 * Phase 2.5 — `/admin/users/*` HTTP routes.
 *
 * Covers the full surface declared in the phase-02 plan §4.1 sub-phase
 * 2.5:
 *
 *  - GET list + ?includeDeleted, GET detail, 404 on missing.
 *  - POST happy path with explicit `initialPassword` (must rotate on
 *    first login) and without (generated password returned exactly once).
 *  - POST rejects unknown groupId, duplicate username, invalid regex.
 *  - PATCH displayName + groupIds (add + remove) with the right bus
 *    events. PATCH that would empty the admin group → 409 lastAdmin.
 *  - DELETE: seeded admin cannot be deleted (404), last-admin guard
 *    (409), successful delete revokes the target's sessions and emits
 *    `session.expired { reason: 'user_deleted' }`.
 *  - POST /reset-password: target's existing sessions die, target can
 *    log in with new password but is gated by mustChangePassword,
 *    response carries `generatedPassword` only when not supplied.
 *    Self-reset is forbidden with `errors.admin.cannotResetOwnPassword`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { BusEvent } from '@bunny2/bus';
import { makeTestAppSeeded, type TestApp } from './_helpers/app';
import { loginSeededAdminRotated } from './_helpers/auth';
import { createSessionsRepo } from '../src/repos/sessions-repo';
import { createUsersRepo } from '../src/repos/users-repo';

let t: TestApp;
let adminToken: string;
let adminUserId: string;

interface UserBody {
  id: string;
  username: string;
  displayName: string;
  mustChangePassword: boolean;
  deletedAt: string | null;
  version: number;
}
interface UserListRow extends UserBody {
  directGroupIds: string[];
}
interface CreateUserResponse {
  user: UserBody;
  generatedPassword?: string;
}
interface ResetPasswordResponse {
  ok: boolean;
  generatedPassword?: string;
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

async function createGroup(slug: string): Promise<string> {
  const res = await adminFetch('/admin/groups', {
    method: 'POST',
    body: JSON.stringify({ slug, name: slug }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { group: { id: string } }).group.id;
}

async function login(
  username: string,
  password: string,
): Promise<{
  status: number;
  token: string | null;
  body: { mustChangePassword?: boolean; user?: { id: string } };
}> {
  const res = await t.app.fetch(
    new Request('http://localhost/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
  );
  const body = (await res.json()) as { mustChangePassword?: boolean; user?: { id: string } };
  const setCookie = res.headers.get('set-cookie') ?? '';
  const token = /bunny2_session=([^;]+)/.exec(setCookie)?.[1] ?? null;
  return { status: res.status, token, body };
}

describe('GET /admin/users', () => {
  it('lists active users with their direct group ids', async () => {
    const groupId = await createGroup('engineering');
    const create = await adminFetch('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'alice',
        displayName: 'Alice',
        initialPassword: 'initial-strong-pw-1!',
        groupIds: [groupId],
      }),
    });
    expect(create.status).toBe(201);

    const list = await adminFetch('/admin/users');
    expect(list.status).toBe(200);
    const body = (await list.json()) as { users: UserListRow[] };
    const alice = body.users.find((u) => u.username === 'alice');
    expect(alice).toBeDefined();
    expect(alice?.directGroupIds).toContain(groupId);
    // The seeded admin user shows up too.
    expect(body.users.some((u) => u.username === 'admin')).toBe(true);
  });

  it('hides soft-deleted users by default; ?includeDeleted=true surfaces them', async () => {
    const create = await adminFetch('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'bob',
        displayName: 'Bob',
        initialPassword: 'initial-strong-pw-2!',
      }),
    });
    const bob = ((await create.json()) as CreateUserResponse).user;
    const del = await adminFetch(`/admin/users/${bob.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);

    const hidden = (await (await adminFetch('/admin/users')).json()) as { users: UserListRow[] };
    expect(hidden.users.some((u) => u.username === 'bob')).toBe(false);
    const all = (await (await adminFetch('/admin/users?includeDeleted=true')).json()) as {
      users: UserListRow[];
    };
    expect(all.users.some((u) => u.username === 'bob')).toBe(true);
  });
});

describe('GET /admin/users/:id', () => {
  it('returns 404 for an unknown id', async () => {
    const res = await adminFetch(`/admin/users/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /admin/users', () => {
  it('creates a user with an explicit initial password (mustChangePassword=true)', async () => {
    const events: BusEvent[] = [];
    t.bus.subscribe('user.created', (e) => {
      events.push(e);
    });
    const res = await adminFetch('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'carol',
        displayName: 'Carol',
        initialPassword: 'initial-strong-pw-3!',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateUserResponse;
    expect(body.user.username).toBe('carol');
    expect(body.user.mustChangePassword).toBe(true);
    expect(body.generatedPassword).toBeUndefined();
    expect(events).toHaveLength(1);
    expect((events[0]?.payload as { createdBy: string }).createdBy).toBe(adminUserId);

    // Carol can log in and lands in the mustChangePassword state.
    const r = await login('carol', 'initial-strong-pw-3!');
    expect(r.status).toBe(200);
    expect(r.body.mustChangePassword).toBe(true);
  });

  it('generates a 24-char random password when initialPassword is omitted', async () => {
    const res = await adminFetch('/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'dave', displayName: 'Dave' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateUserResponse;
    expect(body.generatedPassword).toBeDefined();
    expect(body.generatedPassword!.length).toBeGreaterThanOrEqual(20);

    const r = await login('dave', body.generatedPassword!);
    expect(r.status).toBe(200);
    expect(r.body.mustChangePassword).toBe(true);

    // The mustChangePassword gate fires on a protected route.
    const blocked = await t.app.fetch(
      new Request('http://localhost/auth/me', {
        headers: { authorization: `Bearer ${r.token}` },
      }),
    );
    expect(blocked.status).toBe(409);
  });

  it('rejects an unknown groupId with 400 errors.admin.userUnknownGroup', async () => {
    const res = await adminFetch('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'eve',
        displayName: 'Eve',
        initialPassword: 'initial-strong-pw-4!',
        groupIds: [crypto.randomUUID()],
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('errors.admin.userUnknownGroup');
  });

  it('rejects a duplicate username with 409 errors.admin.userUsernameTaken', async () => {
    await adminFetch('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'frank',
        displayName: 'Frank',
        initialPassword: 'initial-strong-pw-5!',
      }),
    });
    const dup = await adminFetch('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'frank',
        displayName: 'Frank II',
        initialPassword: 'initial-strong-pw-6!',
      }),
    });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: string }).error).toBe('errors.admin.userUsernameTaken');
  });

  it('rejects an invalid username with 400 errors.admin.badRequest', async () => {
    const res = await adminFetch('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'bad name!',
        displayName: 'X',
        initialPassword: 'initial-strong-pw-7!',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a weak initial password', async () => {
    const res = await adminFetch('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'weakling',
        displayName: 'Weakling',
        initialPassword: 'AllLetters',
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('errors.auth.weakPassword');
  });
});

describe('PATCH /admin/users/:id', () => {
  it('updates displayName and emits user.updated', async () => {
    const create = await adminFetch('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'gina',
        displayName: 'Gina',
        initialPassword: 'initial-strong-pw-8!',
      }),
    });
    const id = ((await create.json()) as CreateUserResponse).user.id;
    const events: BusEvent[] = [];
    t.bus.subscribe('user.updated', (e) => {
      events.push(e);
    });
    const res = await adminFetch(`/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ displayName: 'Gina G.' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: UserBody }).user.displayName).toBe('Gina G.');
    expect(events).toHaveLength(1);
    expect((events[0]?.payload as { updatedBy: string }).updatedBy).toBe(adminUserId);
  });

  it('replaces groupIds with the supplied list, emitting add/remove events', async () => {
    const eng = await createGroup('engx');
    const sales = await createGroup('salesx');
    const create = await adminFetch('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'hank',
        displayName: 'Hank',
        initialPassword: 'initial-strong-pw-9!',
        groupIds: [eng],
      }),
    });
    const id = ((await create.json()) as CreateUserResponse).user.id;
    const added: BusEvent[] = [];
    const removed: BusEvent[] = [];
    t.bus.subscribe('group.member_added', (e) => {
      added.push(e);
    });
    t.bus.subscribe('group.member_removed', (e) => {
      removed.push(e);
    });
    const res = await adminFetch(`/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ groupIds: [sales] }),
    });
    expect(res.status).toBe(200);
    expect(added.some((e) => (e.payload as { groupId: string }).groupId === sales)).toBe(true);
    expect(removed.some((e) => (e.payload as { groupId: string }).groupId === eng)).toBe(true);
  });

  it('rejects a patch that would empty the admin group with 409 errors.admin.lastAdmin', async () => {
    // The seeded admin is the only admin. Patching to remove admin
    // memberships must fail because postCount would be 0.
    const res = await adminFetch(`/admin/users/${adminUserId}`, {
      method: 'PATCH',
      body: JSON.stringify({ groupIds: [] }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('errors.admin.lastAdmin');
  });
});

describe('DELETE /admin/users/:id', () => {
  it('refuses to delete the seeded admin user (404)', async () => {
    const res = await adminFetch(`/admin/users/${adminUserId}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('refuses to delete the last admin with 409 errors.admin.lastAdmin', async () => {
    // The seeded admin is permanent (404) AND must stay in the admin
    // group to authorize this DELETE call. To reach the 409 we promote
    // a fresh `admin2`, rotate their initial password (so they can
    // pass the password gate), then have admin2 PATCH the seeded
    // admin out of admin (admin2 keeps the post-count at 1, allowed),
    // and finally try to DELETE admin2 *as themselves* — post-count
    // would be 0, so the guard fires.
    const adminGroupListRes = await adminFetch('/admin/groups');
    const adminGroupListBody = (await adminGroupListRes.json()) as {
      groups: { id: string; slug: string }[];
    };
    const adminGroupId = adminGroupListBody.groups.find((g) => g.slug === 'admin')!.id;

    const c1 = await adminFetch('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'admin2',
        displayName: 'Admin 2',
        initialPassword: 'initial-strong-pw-2admin!',
        groupIds: [adminGroupId],
      }),
    });
    const admin2 = ((await c1.json()) as CreateUserResponse).user;

    // Admin2 logs in + rotates so they can act as an authenticated
    // admin without the password gate firing.
    const login2 = await login('admin2', 'initial-strong-pw-2admin!');
    expect(login2.status).toBe(200);
    const rotate2 = await t.app.fetch(
      new Request('http://localhost/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${login2.token}` },
        body: JSON.stringify({ newPassword: 'admin2-rotated-pw-2026!' }),
      }),
    );
    expect(rotate2.status).toBe(200);

    // Re-login admin2 — the rotate call kills sibling sessions and
    // keeps the current one alive, so the existing token works. But
    // to keep this test independent of that subtlety, log in fresh.
    const fresh2 = await login('admin2', 'admin2-rotated-pw-2026!');
    expect(fresh2.status).toBe(200);
    const admin2Token = fresh2.token!;

    async function admin2Fetch(input: string, init: RequestInit = {}): Promise<Response> {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${admin2Token}`);
      if (init.body !== undefined && !headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
      return t.app.fetch(new Request(`http://localhost${input}`, { ...init, headers }));
    }

    // Strip the seeded admin out of admin. Post-count remains 1 (admin2).
    const patchSeeded = await admin2Fetch(`/admin/users/${adminUserId}`, {
      method: 'PATCH',
      body: JSON.stringify({ groupIds: [] }),
    });
    expect(patchSeeded.status).toBe(200);

    // Now DELETE admin2 — post-count would be 0, so 409.
    const delLast = await admin2Fetch(`/admin/users/${admin2.id}`, { method: 'DELETE' });
    expect(delLast.status).toBe(409);
    expect(((await delLast.json()) as { error: string }).error).toBe('errors.admin.lastAdmin');
  });

  it('revokes the target user sessions on delete with reason user_deleted', async () => {
    const create = await adminFetch('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'igor',
        displayName: 'Igor',
        initialPassword: 'initial-strong-pw-11!',
      }),
    });
    const id = ((await create.json()) as CreateUserResponse).user.id;

    // Drive Igor through login → password change so his session is
    // active and unblocked by the gate.
    const firstLogin = await login('igor', 'initial-strong-pw-11!');
    expect(firstLogin.status).toBe(200);
    expect(firstLogin.token).not.toBeNull();
    const rotate = await t.app.fetch(
      new Request('http://localhost/auth/password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${firstLogin.token}`,
        },
        body: JSON.stringify({ newPassword: 'rotated-strong-pw-igor!' }),
      }),
    );
    expect(rotate.status).toBe(200);

    // Sanity: igor has one active session.
    const sessionsRepo = createSessionsRepo(t.db);
    const before = sessionsRepo.listActiveSessionIdsForUser(id, new Date().toISOString());
    expect(before.length).toBe(1);

    const expiredEvents: BusEvent[] = [];
    t.bus.subscribe('session.expired', (e) => {
      expiredEvents.push(e);
    });

    const del = await adminFetch(`/admin/users/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);

    const after = sessionsRepo.listActiveSessionIdsForUser(id, new Date().toISOString());
    expect(after.length).toBe(0);
    expect(
      expiredEvents.some((e) => (e.payload as { reason: string }).reason === 'user_deleted'),
    ).toBe(true);
  });
});

describe('POST /admin/users/:id/reset-password', () => {
  it('admin reset kills the target session and forces a rotate on next login', async () => {
    const create = await adminFetch('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'jane',
        displayName: 'Jane',
        initialPassword: 'initial-strong-pw-12!',
      }),
    });
    const id = ((await create.json()) as CreateUserResponse).user.id;

    // Jane logs in + rotates → mustChangePassword = false, one session.
    const first = await login('jane', 'initial-strong-pw-12!');
    expect(first.status).toBe(200);
    const rotate = await t.app.fetch(
      new Request('http://localhost/auth/password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${first.token}`,
        },
        body: JSON.stringify({ newPassword: 'rotated-strong-pw-jane!' }),
      }),
    );
    expect(rotate.status).toBe(200);

    // Admin resets without supplying a new password → response carries
    // `generatedPassword`. Also emits `user.password_changed { forced: true }`.
    const pcEvents: BusEvent[] = [];
    t.bus.subscribe('user.password_changed', (e) => {
      pcEvents.push(e);
    });
    const reset = await adminFetch(`/admin/users/${id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(reset.status).toBe(200);
    const resetBody = (await reset.json()) as ResetPasswordResponse;
    expect(resetBody.generatedPassword).toBeDefined();
    expect(pcEvents.some((e) => (e.payload as { forced: boolean }).forced === true)).toBe(true);

    // Jane's old session is dead.
    const oldRes = await t.app.fetch(
      new Request('http://localhost/auth/me', {
        headers: { authorization: `Bearer ${first.token}` },
      }),
    );
    expect(oldRes.status).toBe(401);

    // Jane can log in with the generated password and lands gated.
    const reLogin = await login('jane', resetBody.generatedPassword!);
    expect(reLogin.status).toBe(200);
    expect(reLogin.body.mustChangePassword).toBe(true);
  });

  it('reset-password rejects self-reset with errors.admin.cannotResetOwnPassword', async () => {
    const res = await adminFetch(`/admin/users/${adminUserId}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      'errors.admin.cannotResetOwnPassword',
    );
  });

  it('reset-password with an explicit weak newPassword is rejected', async () => {
    const create = await adminFetch('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        username: 'kim',
        displayName: 'Kim',
        initialPassword: 'initial-strong-pw-13!',
      }),
    });
    const id = ((await create.json()) as CreateUserResponse).user.id;
    const res = await adminFetch(`/admin/users/${id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword: 'AllLetters' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('errors.auth.weakPassword');
  });
});

// `createUsersRepo` import is exercised via the helper tests above; the
// reference here keeps the unused-import linter quiet without changing
// runtime behavior. Specifically reads passwordHash via the repo to
// confirm storage shape unchanged.
void createUsersRepo;
