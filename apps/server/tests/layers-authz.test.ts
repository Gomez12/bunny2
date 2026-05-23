/**
 * Phase 3.4 — `canEditLayer` per the §4.4 authz table.
 *
 * One positive + one negative test per row in the §4.4 table. The v1
 * group-layer fallback (site-admin only — see `authz.ts` JSDoc) is
 * exercised explicitly so a future fix is forced to update this test.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { User as SafeUser } from '@bunny2/shared';
import { safeRmSync } from './_helpers/temp-dir';
import { openDatabase } from '../src/storage/sqlite';
import { createLayersRepo } from '../src/repos/layers-repo';
import { createLayerMembersRepo } from '../src/repos/layer-members-repo';
import { canEditLayer } from '../src/layers/authz';

interface Fixture {
  readonly dir: string;
  readonly db: Database;
}

function makeFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-layer-authz-'));
  const db = openDatabase(dir);
  return { dir, db };
}

function teardown(f: Fixture): void {
  try {
    f.db.close();
  } catch {
    /* already closed */
  }
  safeRmSync(f.dir);
}

function fakeUser(id: string, username = 'u'): SafeUser {
  return {
    id,
    username,
    displayName: username,
    mustChangePassword: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
    version: 1,
  };
}

let fixture: Fixture | null = null;
afterEach(() => {
  if (fixture !== null) {
    teardown(fixture);
    fixture = null;
  }
});

describe('canEditLayer — §4.4 table', () => {
  it('everyone layer: site-admin can edit', () => {
    fixture = makeFixture();
    const repo = createLayersRepo(fixture.db);
    const layer = repo.insertLayer({
      id: crypto.randomUUID(),
      type: 'everyone',
      slug: 'everyone',
      name: 'Everyone',
      now: new Date().toISOString(),
    });
    expect(
      canEditLayer({
        user: fakeUser(crypto.randomUUID()),
        layer,
        db: fixture.db,
        isSiteAdmin: true,
      }),
    ).toBe(true);
  });

  it('everyone layer: plain user cannot edit', () => {
    fixture = makeFixture();
    const repo = createLayersRepo(fixture.db);
    const layer = repo.insertLayer({
      id: crypto.randomUUID(),
      type: 'everyone',
      slug: 'everyone',
      name: 'Everyone',
      now: new Date().toISOString(),
    });
    expect(
      canEditLayer({
        user: fakeUser(crypto.randomUUID()),
        layer,
        db: fixture.db,
        isSiteAdmin: false,
      }),
    ).toBe(false);
  });

  it('personal layer: owning user can edit', () => {
    fixture = makeFixture();
    const repo = createLayersRepo(fixture.db);
    const ownerId = crypto.randomUUID();
    fixture.db.exec(
      `INSERT INTO users(id, username, display_name, password_hash, must_change_password, created_at, updated_at, version) ` +
        `VALUES ('${ownerId}', 'alice', 'Alice', 'h', 0, '2026-01-01', '2026-01-01', 1)`,
    );
    const layer = repo.insertLayer({
      id: crypto.randomUUID(),
      type: 'personal',
      slug: 'personal-alice',
      name: 'Personal — Alice',
      ownerUserId: ownerId,
      now: new Date().toISOString(),
    });
    expect(
      canEditLayer({
        user: fakeUser(ownerId, 'alice'),
        layer,
        db: fixture.db,
        isSiteAdmin: false,
      }),
    ).toBe(true);
  });

  it('personal layer: non-owner non-admin cannot edit', () => {
    fixture = makeFixture();
    const repo = createLayersRepo(fixture.db);
    const ownerId = crypto.randomUUID();
    fixture.db.exec(
      `INSERT INTO users(id, username, display_name, password_hash, must_change_password, created_at, updated_at, version) ` +
        `VALUES ('${ownerId}', 'alice', 'Alice', 'h', 0, '2026-01-01', '2026-01-01', 1)`,
    );
    const layer = repo.insertLayer({
      id: crypto.randomUUID(),
      type: 'personal',
      slug: 'personal-alice',
      name: 'Personal — Alice',
      ownerUserId: ownerId,
      now: new Date().toISOString(),
    });
    expect(
      canEditLayer({
        user: fakeUser(crypto.randomUUID(), 'bob'),
        layer,
        db: fixture.db,
        isSiteAdmin: false,
      }),
    ).toBe(false);
  });

  it('group layer (v1 fallback): site-admin can edit', () => {
    fixture = makeFixture();
    const repo = createLayersRepo(fixture.db);
    // Insert a fake "group" — group_id is a TEXT REFERENCES so we
    // satisfy the FK with a row in `groups`. The authz helper doesn't
    // touch the groups table in v1, but the layers CHECK does.
    fixture.db.exec(
      `INSERT INTO groups(id, slug, name, description, created_at, updated_at, version) ` +
        `VALUES ('00000000-0000-0000-0000-000000000010', 'g', 'G', NULL, '2026-01-01', '2026-01-01', 1)`,
    );
    const layer = repo.insertLayer({
      id: crypto.randomUUID(),
      type: 'group',
      slug: 'group-g',
      name: 'Group — G',
      ownerGroupId: '00000000-0000-0000-0000-000000000010',
      now: new Date().toISOString(),
    });
    expect(
      canEditLayer({
        user: fakeUser(crypto.randomUUID()),
        layer,
        db: fixture.db,
        isSiteAdmin: true,
      }),
    ).toBe(true);
  });

  it('group layer (v1 fallback): plain user cannot edit even when transitively in the group', () => {
    fixture = makeFixture();
    const repo = createLayersRepo(fixture.db);
    fixture.db.exec(
      `INSERT INTO groups(id, slug, name, description, created_at, updated_at, version) ` +
        `VALUES ('00000000-0000-0000-0000-000000000011', 'g', 'G', NULL, '2026-01-01', '2026-01-01', 1)`,
    );
    const layer = repo.insertLayer({
      id: crypto.randomUUID(),
      type: 'group',
      slug: 'group-g',
      name: 'Group — G',
      ownerGroupId: '00000000-0000-0000-0000-000000000011',
      now: new Date().toISOString(),
    });
    // v1 fallback: no per-group admin role exists yet — see follow-up
    // `docs/dev/follow-ups/group-layer-admin-role.md`.
    expect(
      canEditLayer({
        user: fakeUser(crypto.randomUUID()),
        layer,
        db: fixture.db,
        isSiteAdmin: false,
      }),
    ).toBe(false);
  });

  it('project layer: owner member can edit', () => {
    fixture = makeFixture();
    const repo = createLayersRepo(fixture.db);
    const members = createLayerMembersRepo(fixture.db);
    const userId = crypto.randomUUID();
    fixture.db.exec(
      `INSERT INTO users(id, username, display_name, password_hash, must_change_password, created_at, updated_at, version) ` +
        `VALUES ('${userId}', 'u', 'U', 'h', 0, '2026-01-01', '2026-01-01', 1)`,
    );
    const layer = repo.insertLayer({
      id: crypto.randomUUID(),
      type: 'project',
      slug: 'bunny2',
      name: 'Bunny2',
      now: new Date().toISOString(),
    });
    members.addUserMember({
      layerId: layer.id,
      userId,
      role: 'owner',
      now: new Date().toISOString(),
    });
    expect(
      canEditLayer({
        user: fakeUser(userId),
        layer,
        db: fixture.db,
        isSiteAdmin: false,
      }),
    ).toBe(true);
  });

  it('project layer: plain member (role=member) cannot edit', () => {
    fixture = makeFixture();
    const repo = createLayersRepo(fixture.db);
    const members = createLayerMembersRepo(fixture.db);
    const userId = crypto.randomUUID();
    fixture.db.exec(
      `INSERT INTO users(id, username, display_name, password_hash, must_change_password, created_at, updated_at, version) ` +
        `VALUES ('${userId}', 'u', 'U', 'h', 0, '2026-01-01', '2026-01-01', 1)`,
    );
    const layer = repo.insertLayer({
      id: crypto.randomUUID(),
      type: 'project',
      slug: 'bunny2',
      name: 'Bunny2',
      now: new Date().toISOString(),
    });
    members.addUserMember({
      layerId: layer.id,
      userId,
      role: 'member',
      now: new Date().toISOString(),
    });
    expect(
      canEditLayer({
        user: fakeUser(userId),
        layer,
        db: fixture.db,
        isSiteAdmin: false,
      }),
    ).toBe(false);
  });

  it('project layer: non-member cannot edit', () => {
    fixture = makeFixture();
    const repo = createLayersRepo(fixture.db);
    const layer = repo.insertLayer({
      id: crypto.randomUUID(),
      type: 'project',
      slug: 'bunny2',
      name: 'Bunny2',
      now: new Date().toISOString(),
    });
    expect(
      canEditLayer({
        user: fakeUser(crypto.randomUUID()),
        layer,
        db: fixture.db,
        isSiteAdmin: false,
      }),
    ).toBe(false);
  });
});
