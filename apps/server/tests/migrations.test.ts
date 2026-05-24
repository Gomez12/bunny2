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
      expect(currentSchemaVersion(db)).toBe('0011_calendar_projection_todos');
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
      // 0003 tables
      expect(tables).toContain('layers');
      expect(tables).toContain('layer_visibility_edges');
      expect(tables).toContain('layer_user_members');
      expect(tables).toContain('layer_group_members');
      expect(tables).toContain('layer_locales');
      expect(tables).toContain('layer_attachments');
      expect(tables).toContain('layer_dashboard_widgets');
      // 0005 tables — universal entity contract foundation (phase 4.0).
      expect(tables).toContain('entity_versions');
      expect(tables).toContain('entity_translations');
      expect(tables).toContain('entity_external_links');
      expect(tables).toContain('entity_souls');
      // 0006 — first concrete entity kind (phase 4a.1).
      expect(tables).toContain('companies');
      // 0008 — second concrete entity kind (phase 4b.1).
      expect(tables).toContain('contacts');
      // 0009 — third concrete entity kind (phase 4c.1).
      expect(tables).toContain('calendar_events');
      // 0010 — fourth concrete entity kind (phase 4d.1).
      expect(tables).toContain('todos');
      // 0011 — todo → calendar projection bridge (phase 4d.6).
      // Derived index, NOT an entity kind. Sits outside the
      // `entity_*` namespace because it has no version chain, no
      // translations, no soul.
      expect(tables).toContain('calendar_projection_todos');

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
      // 0003 indexes
      expect(indexes).toContain('idx_layers_type');
      expect(indexes).toContain('idx_layers_deleted_at');
      expect(indexes).toContain('idx_layer_visibility_child');
      // 0004 index — partial-unique-index for "exactly one default
      // locale per layer".
      expect(indexes).toContain('idx_layer_locales_one_default');
      // 0005 indexes.
      expect(indexes).toContain('idx_entity_versions_lookup');
      expect(indexes).toContain('idx_entity_translations_kind');
      expect(indexes).toContain('idx_entity_external_links_entity');
      // 0006 indexes — companies.
      expect(indexes).toContain('idx_companies_layer');
      expect(indexes).toContain('idx_companies_deleted_at');
      expect(indexes).toContain('idx_companies_kvk');
      // 0008 indexes — contacts.
      expect(indexes).toContain('idx_contacts_layer');
      expect(indexes).toContain('idx_contacts_deleted_at');
      expect(indexes).toContain('idx_contacts_primary_email');
      expect(indexes).toContain('idx_contacts_company');
      // 0009 indexes — calendar_events.
      expect(indexes).toContain('idx_calendar_events_layer');
      expect(indexes).toContain('idx_calendar_events_deleted_at');
      expect(indexes).toContain('idx_calendar_events_starts_at');
      expect(indexes).toContain('idx_calendar_events_external_cal');
      // 0010 indexes — todos.
      expect(indexes).toContain('idx_todos_layer');
      expect(indexes).toContain('idx_todos_deleted_at');
      expect(indexes).toContain('idx_todos_status');
      expect(indexes).toContain('idx_todos_due_at');
      expect(indexes).toContain('idx_todos_priority');
      expect(indexes).toContain('idx_todos_linked');
      // 0011 indexes — todo → calendar projection bridge.
      expect(indexes).toContain('idx_calendar_projection_todos_layer');
      expect(indexes).toContain('idx_calendar_projection_todos_due_at');

      // 0007 — layer_attachments.kind CHECK extended to accept
      // `'connector'`. Asserting via INSERT is the only portable way
      // to verify a CHECK on SQLite (no introspection API exposes it).
      // The migrations test runs on a fresh DB without the layer seed;
      // insert a stub `everyone` layer just for the CHECK probe.
      const probeLayerId = '00000000-0000-0000-0000-000000000002';
      db.query<unknown, [string, string, string]>(
        "INSERT INTO layers (id, type, slug, name, created_at, updated_at) VALUES (?, 'everyone', ?, ?, datetime('now'), datetime('now'))",
      ).run(probeLayerId, 'probe-everyone', 'probe-everyone');
      db.query<unknown, [string, string, string]>(
        "INSERT INTO layer_attachments (id, layer_id, kind, ref_id, config_json, created_at) VALUES (?, ?, 'connector', ?, '{}', datetime('now'))",
      ).run('00000000-0000-0000-0000-0000000000aa', probeLayerId, 'kvk');
      const stored = db
        .query<{ kind: string }, [string]>('SELECT kind FROM layer_attachments WHERE id = ?')
        .get('00000000-0000-0000-0000-0000000000aa');
      expect(stored?.kind).toBe('connector');

      // 0010 — `todos` CHECK constraint: `linked_entity_id` and
      // `linked_entity_kind` must be both null or both set. Probe
      // both directions: a half-set row must fail; a both-null row
      // must succeed; a both-set row must succeed.
      const probeUserId = '00000000-0000-0000-0000-000000000003';
      db.query<unknown, [string, string]>(
        "INSERT INTO users (id, username, display_name, password_hash, must_change_password, created_at, updated_at) VALUES (?, ?, 'probe', 'h', 0, datetime('now'), datetime('now'))",
      ).run(probeUserId, 'probe-user');
      type FourArgs = [string, string, string, string];
      const okBothNull = (): void => {
        db.query<unknown, FourArgs>(
          "INSERT INTO todos (id, layer_id, slug, title, searchable_text, original_locale, payload_json, created_at, created_by, updated_at, updated_by) VALUES (?, ?, 'p1', 't', 't', 'en', '{}', datetime('now'), ?, datetime('now'), ?)",
        ).run('00000000-0000-0000-0000-0000000000b1', probeLayerId, probeUserId, probeUserId);
      };
      okBothNull();
      const okBothSet = (): void => {
        db.query<unknown, FourArgs>(
          "INSERT INTO todos (id, layer_id, slug, title, searchable_text, original_locale, payload_json, created_at, created_by, updated_at, updated_by, linked_entity_id, linked_entity_kind) VALUES (?, ?, 'p2', 't', 't', 'en', '{}', datetime('now'), ?, datetime('now'), ?, '00000000-0000-0000-0000-000000000099', 'contact')",
        ).run('00000000-0000-0000-0000-0000000000b2', probeLayerId, probeUserId, probeUserId);
      };
      okBothSet();
      // Half-set row must violate the CHECK. `bun:sqlite` throws on
      // constraint failure — wrap in `expect(...).toThrow()`.
      expect(() => {
        db.query<unknown, FourArgs>(
          "INSERT INTO todos (id, layer_id, slug, title, searchable_text, original_locale, payload_json, created_at, created_by, updated_at, updated_by, linked_entity_id) VALUES (?, ?, 'p3', 't', 't', 'en', '{}', datetime('now'), ?, datetime('now'), ?, '00000000-0000-0000-0000-000000000099')",
        ).run('00000000-0000-0000-0000-0000000000b3', probeLayerId, probeUserId, probeUserId);
      }).toThrow();
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
      expect(applied.map((r) => r.id)).toEqual([
        '0001_init',
        '0002_users_groups',
        '0003_layers',
        '0004_layer_locale_default',
        '0005_entities_base',
        '0006_companies',
        '0007_layer_attachments_connector_kind',
        '0008_contacts',
        '0009_calendar_events',
        '0010_todos',
        '0011_calendar_projection_todos',
      ]);
    } finally {
      db2.close();
    }
  });
});
