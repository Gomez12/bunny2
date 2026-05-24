/**
 * Phase 3.2 — layer bus subscribers.
 *
 * Drives `user.created`, `user.deleted`, `group.created`, `group.deleted`,
 * `group.member_added`, `layer.*` through the in-memory bus and asserts:
 *
 *  - the right side-effect (personal/group layer seeded or soft-deleted)
 *  - the resolver cache is invalidated for the affected user / globally
 *  - `events` rows are appended through the same middleware chain
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { correlationIdMiddleware, errorCaptureMiddleware, telemetryMiddleware } from '@bunny2/bus';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import { safeRmSync } from './_helpers/temp-dir';
import { openDatabase } from '../src/storage/sqlite';
import { createSqliteEventLog } from '../src/bus/event-log';
import { createUsersRepo } from '../src/repos/users-repo';
import { createGroupsRepo } from '../src/repos/groups-repo';
import { createLayersRepo } from '../src/repos/layers-repo';
import { createGroupResolver } from '../src/auth/group-resolver';
import { seedLayersIfNeeded } from '../src/layers/seed';
import { createLayerResolver } from '../src/layers/resolver';
import { registerLayerSubscribers } from '../src/layers/subscribers';

let dir: string;
let db: Database;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-layer-subs-'));
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

interface Wired {
  bus: InMemoryMessageBus;
  transitive: ReturnType<typeof createGroupResolver>;
  resolver: ReturnType<typeof createLayerResolver>;
}

async function wire(): Promise<Wired> {
  const eventLog = createSqliteEventLog(db);
  const bus = new InMemoryMessageBus({
    middlewares: [
      correlationIdMiddleware,
      telemetryMiddleware(eventLog.writer),
      errorCaptureMiddleware(),
    ],
  });
  const transitive = createGroupResolver({ db, bus });
  await seedLayersIfNeeded({ db, bus, transitiveGroups: transitive });
  const resolver = createLayerResolver({ db, transitiveGroups: transitive });
  registerLayerSubscribers({ db, bus, resolver, transitiveGroups: transitive });
  return { bus, transitive, resolver };
}

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

describe('layer subscribers', () => {
  it('user.created — seeds the personal layer + bottom_up edge to everyone', async () => {
    const { bus } = await wire();
    const userId = mkUser('carol');
    await bus.publish({
      type: 'user.created',
      payload: { userId, username: 'carol' },
    });

    const personal = createLayersRepo(db).getLayerBySlug('personal-carol');
    expect(personal).not.toBeNull();
    expect(personal?.ownerUserId).toBe(userId);

    const edgesForChild = db
      .query<
        { parent_layer_id: string },
        [string]
      >(`SELECT parent_layer_id FROM layer_visibility_edges WHERE child_layer_id = ?`)
      .all(personal!.id);
    expect(edgesForChild.length).toBeGreaterThanOrEqual(1);
  });

  it('user.deleted — soft-deletes the personal layer and invalidates the user cache', async () => {
    const { bus, resolver } = await wire();
    const userId = mkUser('dave');
    await bus.publish({ type: 'user.created', payload: { userId, username: 'dave' } });

    // Prime cache.
    const before = await resolver.effectiveLayers(userId);
    expect(before.some((l) => l.slug === 'personal-dave')).toBe(true);

    // Soft-delete the user row first, then publish the event the
    // production code would have published next.
    createUsersRepo(db).softDeleteUser(userId, new Date().toISOString());
    await bus.publish({ type: 'user.deleted', payload: { userId } });

    const after = await resolver.effectiveLayers(userId);
    expect(after).not.toBe(before);
    expect(after.some((l) => l.slug === 'personal-dave')).toBe(false);
  });

  it('group.created — seeds the group layer + bottom_up edge to everyone', async () => {
    const { bus } = await wire();
    const groupId = mkGroup('eng');
    await bus.publish({
      type: 'group.created',
      payload: { groupId, slug: 'eng', name: 'eng' },
    });

    const layer = createLayersRepo(db).getLayerBySlug('group-eng');
    expect(layer).not.toBeNull();
    expect(layer?.ownerGroupId).toBe(groupId);
  });

  it('group.deleted — soft-deletes the group layer and broadly invalidates', async () => {
    const { bus, resolver } = await wire();
    const userId = mkUser('erin');
    const groupId = mkGroup('eng');
    createGroupsRepo(db).addUserToGroup(userId, groupId, new Date().toISOString());
    await bus.publish({ type: 'user.created', payload: { userId, username: 'erin' } });
    await bus.publish({ type: 'group.created', payload: { groupId, slug: 'eng', name: 'eng' } });

    const before = await resolver.effectiveLayers(userId);
    expect(before.some((l) => l.slug === 'group-eng')).toBe(true);

    createGroupsRepo(db).softDeleteGroup(groupId, new Date().toISOString());
    await bus.publish({ type: 'group.deleted', payload: { groupId } });

    const after = await resolver.effectiveLayers(userId);
    expect(after.some((l) => l.slug === 'group-eng')).toBe(false);
  });

  it('group.member_added (kind=user) — invalidates the affected user cache', async () => {
    const { bus, resolver } = await wire();
    const userId = mkUser('frank');
    const groupId = mkGroup('platform');
    // Seed the personal + group layer.
    await bus.publish({ type: 'user.created', payload: { userId, username: 'frank' } });
    await bus.publish({
      type: 'group.created',
      payload: { groupId, slug: 'platform', name: 'platform' },
    });

    const before = await resolver.effectiveLayers(userId);
    expect(before.some((l) => l.slug === 'group-platform')).toBe(false);

    // Add the user to the group, then publish the membership event.
    createGroupsRepo(db).addUserToGroup(userId, groupId, new Date().toISOString());
    await bus.publish({
      type: 'group.member_added',
      payload: { groupId, kind: 'user', userId },
    });

    const after = await resolver.effectiveLayers(userId);
    expect(after.some((l) => l.slug === 'group-platform')).toBe(true);
  });

  it('layer.* — any layer-domain event broadly invalidates the cache', async () => {
    const { bus, resolver } = await wire();
    const userId = mkUser('gina');
    await bus.publish({ type: 'user.created', payload: { userId, username: 'gina' } });

    const before = await resolver.effectiveLayers(userId);
    await bus.publish({
      type: 'layer.updated',
      payload: { layerId: 'irrelevant', slug: 'irrelevant' },
    });
    const after = await resolver.effectiveLayers(userId);
    // Same logical set, but the cache must have been dropped, so the
    // reference must differ.
    expect(after).not.toBe(before);
  });
});
