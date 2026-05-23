import type { Database } from 'bun:sqlite';

/**
 * Tiny typed helper over the `kv_meta` table (declared in 0001_init.sql).
 *
 * `kv_meta` is a single-row-per-key string store used by startup wiring to
 * remember one-shot facts: whether the admin seed has run, the id of the
 * seeded admin group/user, etc. It is intentionally untyped at the SQL
 * layer — callers decide the value shape and stringify accordingly.
 *
 * The seed (2.3) and the `/status` extension both need to read the same
 * key, so the helper lives here rather than being duplicated.
 */

interface KvMetaRow {
  value: string;
}

export function getMeta(db: Database, key: string): string | null {
  const row = db.query<KvMetaRow, [string]>('SELECT value FROM kv_meta WHERE key = ?').get(key);
  return row === null ? null : row.value;
}

export function setMeta(db: Database, key: string, value: string, now: string): void {
  // SQLite UPSERT. Mirrors the table's PRIMARY KEY on `key`.
  db.query<unknown, [string, string, string]>(
    `INSERT INTO kv_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now);
}
