import type { Database } from 'bun:sqlite';

export interface Migration {
  readonly id: string;
  readonly sql: string;
}

export interface MigrationsResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

export function applyMigrations(db: Database, migrations: readonly Migration[]): MigrationsResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const existingRows = db.query<{ id: string }, []>('SELECT id FROM schema_migrations').all();
  const existing = new Set(existingRows.map((r) => r.id));

  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  const insert = db.query<unknown, [string, string]>(
    'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)',
  );

  for (const m of migrations) {
    if (existing.has(m.id)) {
      alreadyApplied.push(m.id);
      continue;
    }
    const tx = db.transaction(() => {
      db.exec(m.sql);
      insert.run(m.id, new Date().toISOString());
    });
    tx();
    applied.push(m.id);
  }

  return { applied, alreadyApplied };
}

export function currentSchemaVersion(db: Database): string | null {
  const row = db
    .query<{ id: string }, []>('SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1')
    .get();
  return row?.id ?? null;
}
