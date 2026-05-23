import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from 'bun:sqlite';
import { applyMigrations, type Migration } from './migrations';

// `new URL('.').pathname` returns e.g. `/D:/repo/...` on Windows, which
// breaks `fs` calls. `fileURLToPath` decodes to a real OS path.
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

function loadMigrationsFromDisk(): Migration[] {
  const entries = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return entries.map((name) => ({
    id: name.replace(/\.sql$/, ''),
    sql: fs.readFileSync(path.join(migrationsDir, name), 'utf8'),
  }));
}

export const MIGRATIONS: readonly Migration[] = loadMigrationsFromDisk();

export type JournalMode = 'WAL' | 'DELETE' | 'MEMORY';

export interface OpenDatabaseOptions {
  /**
   * SQLite journal mode. Production uses WAL. Tests pass `DELETE`
   * because `bun:sqlite` on Windows holds the `-wal`/`-shm` files
   * after `db.close()`, which makes the temp-dir cleanup EBUSY.
   * Falls back to `BUNNY2_SQLITE_JOURNAL_MODE` env when unset.
   */
  readonly journalMode?: JournalMode;
}

export function openDatabase(dataDir: string, opts: OpenDatabaseOptions = {}): Database {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'bunny2.sqlite');
  const db = new Database(dbPath, { create: true });
  const envMode = Bun.env['BUNNY2_SQLITE_JOURNAL_MODE'] as JournalMode | undefined;
  const journalMode = opts.journalMode ?? envMode ?? 'WAL';
  db.exec(`PRAGMA journal_mode = ${journalMode}`);
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db, MIGRATIONS);
  return db;
}
