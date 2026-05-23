/**
 * Phase 2.4 — transitive group resolver.
 *
 * Verifies:
 *  - direct membership resolves
 *  - single-level transitive membership resolves
 *  - two-level transitive membership resolves
 *  - diamond inheritance (user in A, A child of B and C, both B and C
 *    children of D) — D sees the user
 *  - wouldCreateCycle detects self, direct loop, and indirect loop
 *  - bus-driven cache invalidation: `group.member_added` flips a
 *    cached answer on the next call
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import { InMemoryMessageBus } from '@bunny2/bus';
import { openDatabase } from '../src/storage/sqlite';
import { createGroupsRepo } from '../src/repos/groups-repo';
import { createUsersRepo } from '../src/repos/users-repo';
import { createGroupResolver } from '../src/auth/group-resolver';

let db: Database;
let dir: string;

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

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-resolver-'));
  db = openDatabase(dir);
});
afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  // Windows holds the WAL/SHM file briefly after db.close(); retry a few times.
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('group-resolver — isUserInGroup', () => {
  it('returns true for a direct user-group membership', () => {
    const bus = new InMemoryMessageBus();
    const resolver = createGroupResolver({ db, bus });
    const groups = createGroupsRepo(db);
    const userId = mkUser('alice');
    const groupId = mkGroup('a');
    groups.addUserToGroup(userId, groupId, new Date().toISOString());
    expect(resolver.isUserInGroup(userId, groupId)).toBe(true);
  });

  it('returns true through a single-level transitive sub-group', () => {
    const bus = new InMemoryMessageBus();
    const resolver = createGroupResolver({ db, bus });
    const groups = createGroupsRepo(db);
    const userId = mkUser('bob');
    const child = mkGroup('child');
    const parent = mkGroup('parent');
    groups.addUserToGroup(userId, child, new Date().toISOString());
    groups.addGroupToGroup(parent, child, new Date().toISOString());
    expect(resolver.isUserInGroup(userId, parent)).toBe(true);
    expect(resolver.isUserInGroup(userId, child)).toBe(true);
  });

  it('returns true through two-level transitive sub-groups', () => {
    const bus = new InMemoryMessageBus();
    const resolver = createGroupResolver({ db, bus });
    const groups = createGroupsRepo(db);
    const userId = mkUser('carol');
    const leaf = mkGroup('leaf');
    const mid = mkGroup('mid');
    const top = mkGroup('top');
    groups.addUserToGroup(userId, leaf, new Date().toISOString());
    groups.addGroupToGroup(mid, leaf, new Date().toISOString());
    groups.addGroupToGroup(top, mid, new Date().toISOString());
    expect(resolver.isUserInGroup(userId, top)).toBe(true);
  });

  it('resolves diamond inheritance — user reachable once through two paths', () => {
    const bus = new InMemoryMessageBus();
    const resolver = createGroupResolver({ db, bus });
    const groups = createGroupsRepo(db);
    const userId = mkUser('dave');
    const a = mkGroup('a');
    const b = mkGroup('b');
    const c = mkGroup('c');
    const d = mkGroup('d');
    groups.addUserToGroup(userId, a, new Date().toISOString());
    groups.addGroupToGroup(b, a, new Date().toISOString());
    groups.addGroupToGroup(c, a, new Date().toISOString());
    groups.addGroupToGroup(d, b, new Date().toISOString());
    groups.addGroupToGroup(d, c, new Date().toISOString());
    expect(resolver.isUserInGroup(userId, d)).toBe(true);
    const expansion = resolver.expandGroupMembers(d);
    expect(expansion.userIds.has(userId)).toBe(true);
    // Diamond: user appears exactly once even though there are two
    // paths from D down to A.
    expect(expansion.userIds.size).toBe(1);
  });

  it('returns false for an unrelated group', () => {
    const bus = new InMemoryMessageBus();
    const resolver = createGroupResolver({ db, bus });
    const userId = mkUser('eve');
    const lonely = mkGroup('lonely');
    expect(resolver.isUserInGroup(userId, lonely)).toBe(false);
  });
});

describe('group-resolver — wouldCreateCycle', () => {
  it('returns true for parent === child (self-reference)', () => {
    const bus = new InMemoryMessageBus();
    const resolver = createGroupResolver({ db, bus });
    const g = mkGroup('g');
    expect(resolver.wouldCreateCycle(g, g)).toBe(true);
  });

  it('returns true for a direct loop (parent already a descendant of child)', () => {
    const bus = new InMemoryMessageBus();
    const resolver = createGroupResolver({ db, bus });
    const groups = createGroupsRepo(db);
    const a = mkGroup('a');
    const b = mkGroup('b');
    // a contains b. Now ask: would `b → a` close a loop? Yes.
    groups.addGroupToGroup(a, b, new Date().toISOString());
    expect(resolver.wouldCreateCycle(b, a)).toBe(true);
  });

  it('returns true for an indirect loop two levels deep', () => {
    const bus = new InMemoryMessageBus();
    const resolver = createGroupResolver({ db, bus });
    const groups = createGroupsRepo(db);
    const a = mkGroup('a');
    const b = mkGroup('b');
    const c = mkGroup('c');
    // a → b → c. Would c → a close a loop? Yes — a is reachable from c
    // via a back-edge that does not exist yet but the answer comes from
    // the existing downward walk from c looking for a.
    groups.addGroupToGroup(a, b, new Date().toISOString());
    groups.addGroupToGroup(b, c, new Date().toISOString());
    expect(resolver.wouldCreateCycle(c, a)).toBe(true);
  });

  it('returns false for a safe edge addition', () => {
    const bus = new InMemoryMessageBus();
    const resolver = createGroupResolver({ db, bus });
    const a = mkGroup('a');
    const b = mkGroup('b');
    expect(resolver.wouldCreateCycle(a, b)).toBe(false);
  });
});

describe('group-resolver — cache invalidation', () => {
  it('returns the fresh answer after a group.member_added bus event', async () => {
    const bus = new InMemoryMessageBus();
    const resolver = createGroupResolver({ db, bus });
    const groups = createGroupsRepo(db);
    const userId = mkUser('frank');
    const groupId = mkGroup('eng');
    // Prime the cache with a negative answer.
    expect(resolver.isUserInGroup(userId, groupId)).toBe(false);
    // Mutate underlying DB then publish the invalidating event.
    groups.addUserToGroup(userId, groupId, new Date().toISOString());
    await bus.publish({
      type: 'group.member_added',
      payload: { groupId, kind: 'user', userId },
      correlationId: crypto.randomUUID(),
    });
    // Next call must reflect the new state.
    expect(resolver.isUserInGroup(userId, groupId)).toBe(true);
  });

  it('returns the fresh answer after a group.member_removed bus event', async () => {
    const bus = new InMemoryMessageBus();
    const resolver = createGroupResolver({ db, bus });
    const groups = createGroupsRepo(db);
    const userId = mkUser('grace');
    const groupId = mkGroup('marketing');
    groups.addUserToGroup(userId, groupId, new Date().toISOString());
    expect(resolver.isUserInGroup(userId, groupId)).toBe(true);
    groups.removeUserFromGroup(userId, groupId);
    await bus.publish({
      type: 'group.member_removed',
      payload: { groupId, kind: 'user', userId },
      correlationId: crypto.randomUUID(),
    });
    expect(resolver.isUserInGroup(userId, groupId)).toBe(false);
  });
});
