import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase } from '../src/storage/sqlite';
import { createGroupsRepo } from '../src/repos/groups-repo';
import { createUsersRepo } from '../src/repos/users-repo';

function mkRepos() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-groups-'));
  const db = openDatabase(dir);
  return { db, groups: createGroupsRepo(db), users: createUsersRepo(db) };
}

const now = () => new Date().toISOString();

describe('groups-repo', () => {
  it('creates and reads a group by id and by slug', () => {
    const { db, groups } = mkRepos();
    try {
      const g = groups.createGroup({
        id: crypto.randomUUID(),
        slug: 'engineering',
        name: 'Engineering',
        description: 'eng folks',
        now: now(),
      });
      expect(groups.findGroupById(g.id)?.slug).toBe('engineering');
      expect(groups.findGroupBySlug('engineering')?.name).toBe('Engineering');
      // Slug is COLLATE NOCASE so case-insensitive lookup works.
      expect(groups.findGroupBySlug('ENGINEERING')?.id).toBe(g.id);
    } finally {
      db.close();
    }
  });

  it('addUserToGroup is idempotent (INSERT OR IGNORE)', () => {
    const { db, groups, users } = mkRepos();
    try {
      const g = groups.createGroup({
        id: crypto.randomUUID(),
        slug: 'admin',
        name: 'Admin',
        now: now(),
      });
      const u = users.createUser({
        id: crypto.randomUUID(),
        username: 'admin',
        displayName: 'Admin',
        passwordHash: 'h',
        mustChangePassword: false,
        now: now(),
      });
      groups.addUserToGroup(u.id, g.id, now());
      // Second add must not throw — idempotent on purpose.
      groups.addUserToGroup(u.id, g.id, now());
      expect(groups.listDirectUserMemberships(u.id)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('addGroupToGroup rejects parent == child', () => {
    const { db, groups } = mkRepos();
    try {
      const g = groups.createGroup({
        id: crypto.randomUUID(),
        slug: 'a',
        name: 'A',
        now: now(),
      });
      expect(() => groups.addGroupToGroup(g.id, g.id, now())).toThrow();
    } finally {
      db.close();
    }
  });

  it('listDirectGroupChildren returns inserted edges', () => {
    const { db, groups } = mkRepos();
    try {
      const parent = groups.createGroup({
        id: crypto.randomUUID(),
        slug: 'parent',
        name: 'Parent',
        now: now(),
      });
      const child1 = groups.createGroup({
        id: crypto.randomUUID(),
        slug: 'child1',
        name: 'Child 1',
        now: now(),
      });
      const child2 = groups.createGroup({
        id: crypto.randomUUID(),
        slug: 'child2',
        name: 'Child 2',
        now: now(),
      });
      groups.addGroupToGroup(parent.id, child1.id, now());
      groups.addGroupToGroup(parent.id, child2.id, now());
      const edges = groups
        .listDirectGroupChildren(parent.id)
        .map((e) => e.childGroupId)
        .sort();
      expect(edges).toEqual([child1.id, child2.id].sort());
    } finally {
      db.close();
    }
  });

  it('updateGroup bumps version and updates fields', () => {
    const { db, groups } = mkRepos();
    try {
      const g = groups.createGroup({
        id: crypto.randomUUID(),
        slug: 'engineering',
        name: 'Engineering',
        now: '2026-01-01T00:00:00.000Z',
      });
      const updated = groups.updateGroup(
        g.id,
        { name: 'Engineering Team', description: 'updated' },
        '2026-01-02T00:00:00.000Z',
      );
      expect(updated.name).toBe('Engineering Team');
      expect(updated.description).toBe('updated');
      expect(updated.version).toBe(2);
    } finally {
      db.close();
    }
  });

  it('soft delete + countActive', () => {
    const { db, groups } = mkRepos();
    try {
      const g1 = groups.createGroup({
        id: crypto.randomUUID(),
        slug: 'a',
        name: 'A',
        now: now(),
      });
      groups.createGroup({ id: crypto.randomUUID(), slug: 'b', name: 'B', now: now() });
      groups.softDeleteGroup(g1.id, now());
      expect(groups.countActive()).toBe(1);
      expect(groups.listGroups()).toHaveLength(1);
      expect(groups.listGroups({ includeDeleted: true })).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});
