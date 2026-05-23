import * as fs from 'node:fs';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import { applyMigrations, type Migration } from './migrations';

const migrationsDir = path.join(new URL('.', import.meta.url).pathname, 'migrations');

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

export function openDatabase(dataDir: string): Database {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'bunny2.sqlite');
  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db, MIGRATIONS);
  return db;
}
