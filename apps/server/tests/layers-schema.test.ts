import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import { openDatabase } from '../src/storage/sqlite';
import { applyMigrations, type Migration } from '../src/storage/migrations';
import { createUsersRepo } from '../src/repos/users-repo';
import { createGroupsRepo } from '../src/repos/groups-repo';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-layers-schema-'));
}

const now = () => new Date().toISOString();

describe('0003_layers schema', () => {
  it('rejects a personal layer without owner_user_id (CHECK constraint)', () => {
    const db = openDatabase(mkTmp());
    try {
      expect(() =>
        db
          .query<unknown, [string, string, string, string, string]>(
            `INSERT INTO layers (id, type, slug, name, created_at, updated_at)
             VALUES (?, 'personal', ?, ?, ?, ?)`,
          )
          .run(crypto.randomUUID(), 'bad-personal', 'Bad Personal', now(), now()),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects a group layer without owner_group_id (CHECK constraint)', () => {
    const db = openDatabase(mkTmp());
    try {
      expect(() =>
        db
          .query<unknown, [string, string, string, string, string]>(
            `INSERT INTO layers (id, type, slug, name, created_at, updated_at)
             VALUES (?, 'group', ?, ?, ?, ?)`,
          )
          .run(crypto.randomUUID(), 'bad-group', 'Bad Group', now(), now()),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects a project layer with an owner_user_id (CHECK constraint)', () => {
    const dir = mkTmp();
    const db = openDatabase(dir);
    try {
      const users = createUsersRepo(db);
      const u = users.createUser({
        id: crypto.randomUUID(),
        username: 'owner1',
        displayName: 'Owner',
        passwordHash: 'h',
        mustChangePassword: false,
        now: now(),
      });
      expect(() =>
        db
          .query<unknown, [string, string, string, string, string, string]>(
            `INSERT INTO layers (id, type, slug, name, owner_user_id, created_at, updated_at)
             VALUES (?, 'project', ?, ?, ?, ?, ?)`,
          )
          .run(crypto.randomUUID(), 'bad-project', 'Bad Project', u.id, now(), now()),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('accepts an everyone layer with no owners', () => {
    const db = openDatabase(mkTmp());
    try {
      const id = crypto.randomUUID();
      db.query<unknown, [string, string, string, string, string]>(
        `INSERT INTO layers (id, type, slug, name, created_at, updated_at)
         VALUES (?, 'everyone', ?, ?, ?, ?)`,
      ).run(id, 'everyone', 'Everyone', now(), now());
      const row = db.query<{ id: string }, [string]>('SELECT id FROM layers WHERE id = ?').get(id);
      expect(row?.id).toBe(id);
    } finally {
      db.close();
    }
  });

  it('rejects a self-edge in layer_visibility_edges (CHECK constraint)', () => {
    const db = openDatabase(mkTmp());
    try {
      const layerId = crypto.randomUUID();
      db.query<unknown, [string, string, string, string, string]>(
        `INSERT INTO layers (id, type, slug, name, created_at, updated_at)
         VALUES (?, 'everyone', ?, ?, ?, ?)`,
      ).run(layerId, 'everyone', 'Everyone', now(), now());
      expect(() =>
        db
          .query<unknown, [string, string, string]>(
            `INSERT INTO layer_visibility_edges
               (parent_layer_id, child_layer_id, direction, created_at)
             VALUES (?, ?, 'bottom_up', ?)`,
          )
          .run(layerId, layerId, now()),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects a duplicate (layer_id, kind, ref_id) attachment', () => {
    const db = openDatabase(mkTmp());
    try {
      const layerId = crypto.randomUUID();
      db.query<unknown, [string, string, string, string, string]>(
        `INSERT INTO layers (id, type, slug, name, created_at, updated_at)
         VALUES (?, 'project', ?, ?, ?, ?)`,
      ).run(layerId, 'proj-1', 'P1', now(), now());

      const insertAtt = db.query<unknown, [string, string, string, string, string, string]>(
        `INSERT INTO layer_attachments
           (id, layer_id, kind, ref_id, config_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      insertAtt.run(crypto.randomUUID(), layerId, 'agent', 'ref-x', '{}', now());
      expect(() =>
        insertAtt.run(crypto.randomUUID(), layerId, 'agent', 'ref-x', '{}', now()),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('runs 0001 + 0002 + 0003 in order without error on top of phase-2 data', () => {
    // Boot with phase-2 schema only by loading manually, then apply 0003.
    const dir = mkTmp();
    const dbPath = path.join(dir, 'bunny2.sqlite');
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(dbPath, { create: true });
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('PRAGMA foreign_keys = ON');

    const migrationsDir = path.join(import.meta.dir, '..', 'src', 'storage', 'migrations');
    const phase2: Migration[] = ['0001_init.sql', '0002_users_groups.sql'].map((f) => ({
      id: f.replace(/\.sql$/, ''),
      sql: fs.readFileSync(path.join(migrationsDir, f), 'utf8'),
    }));
    applyMigrations(db, phase2);

    // Insert real phase-2 data so we can prove 0003 doesn't disturb it.
    const users = createUsersRepo(db);
    const groups = createGroupsRepo(db);
    const u = users.createUser({
      id: crypto.randomUUID(),
      username: 'admin',
      displayName: 'Admin',
      passwordHash: 'h',
      mustChangePassword: false,
      now: now(),
    });
    const g = groups.createGroup({
      id: crypto.randomUUID(),
      slug: 'admin',
      name: 'Admin',
      now: now(),
    });
    groups.addUserToGroup(u.id, g.id, now());

    const phase3: Migration[] = [
      {
        id: '0003_layers',
        sql: fs.readFileSync(path.join(migrationsDir, '0003_layers.sql'), 'utf8'),
      },
    ];
    const result = applyMigrations(db, phase3);
    expect(result.applied).toEqual(['0003_layers']);

    // Phase-2 data still resolves.
    expect(users.findUserById(u.id)?.username).toBe('admin');
    expect(groups.findGroupBySlug('admin')?.id).toBe(g.id);
    // Phase-3 tables are now present.
    const layersCount = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM layers').get();
    expect(layersCount?.n).toBe(0);

    db.close();
  });
});
