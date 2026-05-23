import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase } from '../src/storage/sqlite';
import { currentSchemaVersion } from '../src/storage/migrations';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-mig-'));
}

describe('migrations', () => {
  it('applies all migrations on a fresh database', () => {
    const dir = mkTmp();
    const db = openDatabase(dir);
    try {
      expect(currentSchemaVersion(db)).toBe('0002_users_groups');
      const tables = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all()
        .map((r) => r.name);
      expect(tables).toContain('events');
      expect(tables).toContain('llm_calls');
      expect(tables).toContain('kv_meta');
      expect(tables).toContain('schema_migrations');
      // 0002 tables
      expect(tables).toContain('users');
      expect(tables).toContain('groups');
      expect(tables).toContain('user_group_memberships');
      expect(tables).toContain('group_group_memberships');
      expect(tables).toContain('sessions');

      const indexes = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
        )
        .all()
        .map((r) => r.name);
      expect(indexes).toContain('idx_users_deleted_at');
      expect(indexes).toContain('idx_groups_deleted_at');
      expect(indexes).toContain('idx_user_group_memberships_group');
      expect(indexes).toContain('idx_group_group_memberships_child');
      expect(indexes).toContain('idx_sessions_user');
      expect(indexes).toContain('idx_sessions_expires');
    } finally {
      db.close();
    }
  });

  it('is idempotent on reopen', () => {
    const dir = mkTmp();
    const db1 = openDatabase(dir);
    db1.close();
    const db2 = openDatabase(dir);
    try {
      const applied = db2
        .query<{ id: string }, []>('SELECT id FROM schema_migrations ORDER BY id')
        .all();
      expect(applied.map((r) => r.id)).toEqual(['0001_init', '0002_users_groups']);
    } finally {
      db2.close();
    }
  });
});
