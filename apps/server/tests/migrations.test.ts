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
  it('applies the initial migration on a fresh database', () => {
    const dir = mkTmp();
    const db = openDatabase(dir);
    try {
      expect(currentSchemaVersion(db)).toBe('0001_init');
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
      const applied = db2.query<{ id: string }, []>('SELECT id FROM schema_migrations').all();
      expect(applied).toHaveLength(1);
      expect(applied[0]?.id).toBe('0001_init');
    } finally {
      db2.close();
    }
  });
});
