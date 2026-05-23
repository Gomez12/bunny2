import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase } from '../src/storage/sqlite';
import { createUsersRepo } from '../src/repos/users-repo';

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-users-'));
  const db = openDatabase(dir);
  return { db, repo: createUsersRepo(db) };
}

const now = () => new Date().toISOString();

describe('users-repo', () => {
  it('creates and reads a user by id', () => {
    const { db, repo } = mkRepo();
    try {
      const user = repo.createUser({
        id: crypto.randomUUID(),
        username: 'alice',
        displayName: 'Alice',
        passwordHash: 'hash-1',
        mustChangePassword: true,
        now: now(),
      });
      expect(user.username).toBe('alice');
      expect(user.mustChangePassword).toBe(true);
      expect(user.version).toBe(1);
      expect(repo.findUserById(user.id)?.username).toBe('alice');
    } finally {
      db.close();
    }
  });

  it('finds users by username case-insensitively', () => {
    const { db, repo } = mkRepo();
    try {
      repo.createUser({
        id: crypto.randomUUID(),
        username: 'Alice',
        displayName: 'Alice',
        passwordHash: 'h',
        mustChangePassword: false,
        now: now(),
      });
      expect(repo.findUserByUsername('alice')?.displayName).toBe('Alice');
      expect(repo.findUserByUsername('ALICE')?.displayName).toBe('Alice');
    } finally {
      db.close();
    }
  });

  it('rejects a duplicate username regardless of case', () => {
    const { db, repo } = mkRepo();
    try {
      repo.createUser({
        id: crypto.randomUUID(),
        username: 'Alice',
        displayName: 'Alice 1',
        passwordHash: 'h',
        mustChangePassword: false,
        now: now(),
      });
      expect(() =>
        repo.createUser({
          id: crypto.randomUUID(),
          username: 'alice',
          displayName: 'Alice 2',
          passwordHash: 'h',
          mustChangePassword: false,
          now: now(),
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('lists active users and includes soft-deleted on request', () => {
    const { db, repo } = mkRepo();
    try {
      const a = repo.createUser({
        id: crypto.randomUUID(),
        username: 'a',
        displayName: 'A',
        passwordHash: 'h',
        mustChangePassword: false,
        now: now(),
      });
      repo.createUser({
        id: crypto.randomUUID(),
        username: 'b',
        displayName: 'B',
        passwordHash: 'h',
        mustChangePassword: false,
        now: now(),
      });
      repo.softDeleteUser(a.id, now());
      expect(repo.listUsers().map((u) => u.username)).toEqual(['b']);
      expect(
        repo
          .listUsers({ includeDeleted: true })
          .map((u) => u.username)
          .sort(),
      ).toEqual(['a', 'b']);
      expect(repo.countActive()).toBe(1);
    } finally {
      db.close();
    }
  });

  it('updateUser bumps version and updated_at', () => {
    const { db, repo } = mkRepo();
    try {
      const created = repo.createUser({
        id: crypto.randomUUID(),
        username: 'eve',
        displayName: 'Eve',
        passwordHash: 'h',
        mustChangePassword: true,
        now: '2026-01-01T00:00:00.000Z',
      });
      const updated = repo.updateUser(
        created.id,
        { displayName: 'Evelyn', mustChangePassword: false },
        '2026-01-02T00:00:00.000Z',
      );
      expect(updated.displayName).toBe('Evelyn');
      expect(updated.mustChangePassword).toBe(false);
      expect(updated.version).toBe(2);
      expect(updated.updatedAt).toBe('2026-01-02T00:00:00.000Z');
    } finally {
      db.close();
    }
  });

  it('soft delete sets deleted_at and bumps version', () => {
    const { db, repo } = mkRepo();
    try {
      const u = repo.createUser({
        id: crypto.randomUUID(),
        username: 'tmp',
        displayName: 'Tmp',
        passwordHash: 'h',
        mustChangePassword: false,
        now: '2026-01-01T00:00:00.000Z',
      });
      repo.softDeleteUser(u.id, '2026-01-02T00:00:00.000Z');
      const after = repo.findUserById(u.id);
      expect(after?.deletedAt).toBe('2026-01-02T00:00:00.000Z');
      expect(after?.version).toBe(2);
    } finally {
      db.close();
    }
  });
});
