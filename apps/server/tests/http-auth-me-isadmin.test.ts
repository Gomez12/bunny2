/**
 * Phase 2.4 — `/auth/me` isAdmin must be computed transitively.
 *
 * Scenario: create `engineering`, make it a sub-group of `admin`, add a
 * fresh user to `engineering`. /auth/me.isAdmin should report true.
 * Remove the membership; the answer must flip back to false on the
 * next call (cache is invalidated by the bus subscriber).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { makeTestAppSeeded, type TestApp } from './_helpers/app';
import { loginSeededAdminRotated, seedNonAdminUser } from './_helpers/auth';

let t: TestApp;
let adminToken: string;

beforeEach(async () => {
  t = await makeTestAppSeeded('bunny2-me-isadmin-');
  const admin = await loginSeededAdminRotated({
    db: t.db,
    bus: t.bus,
    app: t.app,
    seedLog: t.seedLog,
  });
  adminToken = admin.token;
});
afterEach(() => t.cleanup());

async function adminPost(input: string, body: unknown): Promise<Response> {
  return t.app.fetch(
    new Request(`http://localhost${input}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('GET /auth/me — transitive isAdmin (phase 2.4)', () => {
  it('resolves isAdmin=true for a user inherited via a sub-group of admin, then false after removal', async () => {
    // Look up admin group id from the list endpoint.
    const listRes = await t.app.fetch(
      new Request('http://localhost/admin/groups', {
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    );
    const list = (await listRes.json()) as { groups: { id: string; slug: string }[] };
    const adminGroupId = list.groups.find((g) => g.slug === 'admin')?.id ?? '';
    expect(adminGroupId).not.toBe('');

    // Create `engineering` and add it as a child of `admin`.
    const engRes = await adminPost('/admin/groups', { slug: 'engineering', name: 'Engineering' });
    expect(engRes.status).toBe(201);
    const engineeringId = ((await engRes.json()) as { group: { id: string } }).group.id;
    const subRes = await adminPost(`/admin/groups/${adminGroupId}/members`, {
      groupId: engineeringId,
    });
    expect(subRes.status).toBe(201);

    // Fresh user belongs only to `engineering`.
    const inheriting = await seedNonAdminUser({ db: t.db, app: t.app }, { username: 'inheriting' });
    const addRes = await adminPost(`/admin/groups/${engineeringId}/members`, {
      userId: inheriting.user.id,
    });
    expect(addRes.status).toBe(201);

    const meRes = await t.app.fetch(
      new Request('http://localhost/auth/me', {
        headers: { authorization: `Bearer ${inheriting.token}` },
      }),
    );
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { isAdmin: boolean };
    expect(me.isAdmin).toBe(true);

    // Now remove the membership; the resolver's bus subscriber must
    // invalidate the cache so the next /auth/me sees the change.
    const remRes = await t.app.fetch(
      new Request(
        `http://localhost/admin/groups/${engineeringId}/members/${inheriting.user.id}?kind=user`,
        {
          method: 'DELETE',
          headers: { authorization: `Bearer ${adminToken}` },
        },
      ),
    );
    expect(remRes.status).toBe(200);

    const meAfterRes = await t.app.fetch(
      new Request('http://localhost/auth/me', {
        headers: { authorization: `Bearer ${inheriting.token}` },
      }),
    );
    const meAfter = (await meAfterRes.json()) as { isAdmin: boolean };
    expect(meAfter.isAdmin).toBe(false);
  });
});
