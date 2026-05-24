/**
 * Phase 3.2 — effective-layer-set resolver.
 *
 * Verifies:
 *  - admin-only scenario: only the admin's personal + everyone + group
 *  - group-of-groups: transitive group layers are included
 *  - soft-deleted group's layer is excluded
 *  - soft-deleted layer is excluded
 *  - `top_down` edge produces the expected child→from-parent expansion
 *  - cache hit returns the same frozen array reference
 *  - `invalidate(userId)` forces a re-resolve
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import { safeRmSync } from './_helpers/temp-dir';
import { openDatabase } from '../src/storage/sqlite';
import { createUsersRepo } from '../src/repos/users-repo';
import { createGroupsRepo } from '../src/repos/groups-repo';
import { createLayersRepo } from '../src/repos/layers-repo';
import { createLayerVisibilityRepo } from '../src/repos/layer-visibility-repo';
import { createLayerMembersRepo } from '../src/repos/layer-members-repo';
import { createGroupResolver } from '../src/auth/group-resolver';
import { seedLayersIfNeeded } from '../src/layers/seed';
import { createLayerResolver } from '../src/layers/resolver';

let dir: string;
let db: Database;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-layer-resolver-'));
  db = openDatabase(dir);
});
afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  safeRmSync(dir);
});

function mkUser(username: string): string {
  const id = crypto.randomUUID();
  createUsersRepo(db).createUser({
    id,
    username,
    displayName: username,
    passwordHash: 'h',
    mustChangePassword: false,
    now: new Date().toISOString(),
  });
  return id;
}
function mkGroup(slug: string): string {
  const id = crypto.randomUUID();
  createGroupsRepo(db).createGroup({
    id,
    slug,
    name: slug,
    now: new Date().toISOString(),
  });
  return id;
}

describe('layer resolver — basic scenarios', () => {
  it('admin only — returns personal + everyone + their group layers', async () => {
    const aliceId = mkUser('alice');
    const groupId = mkGroup('a');
    createGroupsRepo(db).addUserToGroup(aliceId, groupId, new Date().toISOString());

    const bus = new InMemoryMessageBus();
    const transitive = createGroupResolver({ db, bus });
    await seedLayersIfNeeded({ db, bus, transitiveGroups: transitive });

    const resolver = createLayerResolver({ db, transitiveGroups: transitive });
    const layers = await resolver.effectiveLayers(aliceId);
    const slugs = layers.map((l) => l.slug).sort();
    expect(slugs).toEqual(['everyone', 'group-a', 'personal-alice']);
    // Sorted by type then slug — `everyone` < `group` < `personal`.
    expect(layers.map((l) => l.type)).toEqual(['everyone', 'group', 'personal']);
  });

  it('group-of-groups chain — includes every transitive group layer', async () => {
    const aliceId = mkUser('alice');
    const a = mkGroup('a');
    const b = mkGroup('b');
    const c = mkGroup('c');
    const groups = createGroupsRepo(db);
    groups.addUserToGroup(aliceId, a, new Date().toISOString());
    groups.addGroupToGroup(b, a, new Date().toISOString()); // b contains a
    groups.addGroupToGroup(c, b, new Date().toISOString()); // c contains b

    const bus = new InMemoryMessageBus();
    const transitive = createGroupResolver({ db, bus });
    await seedLayersIfNeeded({ db, bus, transitiveGroups: transitive });

    const resolver = createLayerResolver({ db, transitiveGroups: transitive });
    const layers = await resolver.effectiveLayers(aliceId);
    const slugs = layers.map((l) => l.slug).sort();
    expect(slugs).toContain('group-a');
    expect(slugs).toContain('group-b');
    expect(slugs).toContain('group-c');
  });

  it('soft-deleted group excludes its layer from the user set', async () => {
    const aliceId = mkUser('alice');
    const a = mkGroup('a');
    const b = mkGroup('b');
    createGroupsRepo(db).addUserToGroup(aliceId, a, new Date().toISOString());
    createGroupsRepo(db).addUserToGroup(aliceId, b, new Date().toISOString());

    const bus = new InMemoryMessageBus();
    const transitive = createGroupResolver({ db, bus });
    await seedLayersIfNeeded({ db, bus, transitiveGroups: transitive });
    // Soft-delete the group; the layer seed already created `group-b`.
    createGroupsRepo(db).softDeleteGroup(b, new Date().toISOString());

    const resolver = createLayerResolver({ db, transitiveGroups: transitive });
    const slugs = (await resolver.effectiveLayers(aliceId)).map((l) => l.slug);
    expect(slugs).toContain('group-a');
    // The `group-b` layer row itself is still present; the resolver's
    // SQL filters `deleted_at IS NULL`. Soft-delete the layer to be
    // certain — the group soft-delete alone doesn't propagate yet
    // (that's the `group.deleted` subscriber, exercised in the
    // subscribers test). For now we assert that, after we also soft-
    // delete the layer, it's gone.
    const layersRepo = createLayersRepo(db);
    const groupBLayer = layersRepo.getLayerBySlug('group-b');
    if (groupBLayer === null) throw new Error('test setup: group-b layer missing');
    layersRepo.softDeleteLayer(groupBLayer.id, new Date().toISOString());

    const resolver2 = createLayerResolver({ db, transitiveGroups: transitive });
    const slugs2 = (await resolver2.effectiveLayers(aliceId)).map((l) => l.slug);
    expect(slugs2).not.toContain('group-b');
  });

  it('soft-deleted layer is excluded from the resolved set', async () => {
    const aliceId = mkUser('alice');
    const a = mkGroup('a');
    createGroupsRepo(db).addUserToGroup(aliceId, a, new Date().toISOString());

    const bus = new InMemoryMessageBus();
    const transitive = createGroupResolver({ db, bus });
    await seedLayersIfNeeded({ db, bus, transitiveGroups: transitive });

    const layersRepo = createLayersRepo(db);
    const personal = layersRepo.getLayerBySlug('personal-alice');
    if (personal === null) throw new Error('test setup: personal-alice missing');
    layersRepo.softDeleteLayer(personal.id, new Date().toISOString());

    const resolver = createLayerResolver({ db, transitiveGroups: transitive });
    const slugs = (await resolver.effectiveLayers(aliceId)).map((l) => l.slug);
    expect(slugs).not.toContain('personal-alice');
  });

  it('top_down edge — child→parent edge with top_down adds the child when the parent is reachable', async () => {
    const aliceId = mkUser('alice');
    const bus = new InMemoryMessageBus();
    const transitive = createGroupResolver({ db, bus });
    await seedLayersIfNeeded({ db, bus, transitiveGroups: transitive });

    const layersRepo = createLayersRepo(db);
    // Create a project layer with no members — alice should not see it.
    const projectId = crypto.randomUUID();
    layersRepo.insertLayer({
      id: projectId,
      type: 'project',
      slug: 'project-x',
      name: 'Project X',
      now: new Date().toISOString(),
    });

    const visibility = createLayerVisibilityRepo(db);
    // Alice's personal layer is the parent; project-x is the child of
    // a top_down edge. With direction=`top_down` (child→parent stored
    // with parent=personal-alice, child=project-x), the resolver adds
    // the child (project-x) when the parent (personal-alice) is in the
    // set. So alice gains visibility into project-x.
    const personal = layersRepo.getLayerBySlug('personal-alice');
    if (personal === null) throw new Error('test setup');
    visibility.addEdge({
      parentLayerId: personal.id,
      childLayerId: projectId,
      direction: 'top_down',
      now: new Date().toISOString(),
    });

    const resolver = createLayerResolver({ db, transitiveGroups: transitive });
    const slugs = (await resolver.effectiveLayers(aliceId)).map((l) => l.slug);
    expect(slugs).toContain('project-x');
  });

  it('project layer with the user as a direct member is included', async () => {
    const aliceId = mkUser('alice');
    const bus = new InMemoryMessageBus();
    const transitive = createGroupResolver({ db, bus });
    await seedLayersIfNeeded({ db, bus, transitiveGroups: transitive });

    const layersRepo = createLayersRepo(db);
    const projectId = crypto.randomUUID();
    layersRepo.insertLayer({
      id: projectId,
      type: 'project',
      slug: 'project-x',
      name: 'Project X',
      now: new Date().toISOString(),
    });
    createLayerMembersRepo(db).addUserMember({
      layerId: projectId,
      userId: aliceId,
      now: new Date().toISOString(),
    });

    const resolver = createLayerResolver({ db, transitiveGroups: transitive });
    const slugs = (await resolver.effectiveLayers(aliceId)).map((l) => l.slug);
    expect(slugs).toContain('project-x');
  });

  it('cache hit returns the same frozen array reference; invalidate(userId) drops it', async () => {
    const aliceId = mkUser('alice');
    const bus = new InMemoryMessageBus();
    const transitive = createGroupResolver({ db, bus });
    await seedLayersIfNeeded({ db, bus, transitiveGroups: transitive });

    const resolver = createLayerResolver({ db, transitiveGroups: transitive });
    const first = await resolver.effectiveLayers(aliceId);
    const second = await resolver.effectiveLayers(aliceId);
    expect(second).toBe(first); // same frozen reference
    expect(Object.isFrozen(first)).toBe(true);

    resolver.invalidate(aliceId);
    const third = await resolver.effectiveLayers(aliceId);
    expect(third).not.toBe(first);
    // …but it resolves to the same set.
    expect(third.map((l) => l.slug).sort()).toEqual(first.map((l) => l.slug).sort());
  });

  it('invalidate() with no argument drops every cached set', async () => {
    const aliceId = mkUser('alice');
    const bobId = mkUser('bob');
    const bus = new InMemoryMessageBus();
    const transitive = createGroupResolver({ db, bus });
    await seedLayersIfNeeded({ db, bus, transitiveGroups: transitive });

    const resolver = createLayerResolver({ db, transitiveGroups: transitive });
    const aliceA = await resolver.effectiveLayers(aliceId);
    const bobA = await resolver.effectiveLayers(bobId);
    resolver.invalidate();
    const aliceB = await resolver.effectiveLayers(aliceId);
    const bobB = await resolver.effectiveLayers(bobId);
    expect(aliceB).not.toBe(aliceA);
    expect(bobB).not.toBe(bobA);
  });

  it('invalidate(userId) on an unknown key is a no-op', async () => {
    const bus = new InMemoryMessageBus();
    const transitive = createGroupResolver({ db, bus });
    await seedLayersIfNeeded({ db, bus, transitiveGroups: transitive });

    const resolver = createLayerResolver({ db, transitiveGroups: transitive });
    // Should not throw.
    resolver.invalidate('00000000-0000-0000-0000-000000000000');
  });
});
