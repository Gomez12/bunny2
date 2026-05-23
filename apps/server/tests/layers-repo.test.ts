import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../src/storage/sqlite';
import { createUsersRepo } from '../src/repos/users-repo';
import { createGroupsRepo } from '../src/repos/groups-repo';
import { createLayersRepo } from '../src/repos/layers-repo';
import { createLayerVisibilityRepo } from '../src/repos/layer-visibility-repo';
import { createLayerMembersRepo } from '../src/repos/layer-members-repo';
import { createLayerLocalesRepo } from '../src/repos/layer-locales-repo';
import { createLayerAttachmentsRepo } from '../src/repos/layer-attachments-repo';
import { createLayerWidgetsRepo } from '../src/repos/layer-widgets-repo';

const now = () => new Date().toISOString();

function mkDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-layers-'));
  return openDatabase(dir);
}

function newUser(db: Database, username: string) {
  return createUsersRepo(db).createUser({
    id: crypto.randomUUID(),
    username,
    displayName: username,
    passwordHash: 'h',
    mustChangePassword: false,
    now: now(),
  });
}

function newGroup(db: Database, slug: string) {
  return createGroupsRepo(db).createGroup({
    id: crypto.randomUUID(),
    slug,
    name: slug,
    now: now(),
  });
}

describe('layers-repo', () => {
  it('inserts and reads a project layer by id and slug', () => {
    const db = mkDb();
    try {
      const repo = createLayersRepo(db);
      const created = repo.insertLayer({
        id: crypto.randomUUID(),
        type: 'project',
        slug: 'bunny2',
        name: 'Bunny2',
        now: now(),
      });
      expect(created.version).toBe(1);
      expect(repo.getLayerById(created.id)?.slug).toBe('bunny2');
      expect(repo.getLayerBySlug('bunny2')?.id).toBe(created.id);
      expect(repo.getLayerBySlug('BUNNY2')?.id).toBe(created.id);
    } finally {
      db.close();
    }
  });

  it('listLayers filters by type and excludes soft-deleted by default', () => {
    const db = mkDb();
    try {
      const repo = createLayersRepo(db);
      repo.insertLayer({
        id: crypto.randomUUID(),
        type: 'everyone',
        slug: 'everyone',
        name: 'Everyone',
        now: now(),
      });
      const project = repo.insertLayer({
        id: crypto.randomUUID(),
        type: 'project',
        slug: 'p1',
        name: 'P1',
        now: now(),
      });
      repo.insertLayer({
        id: crypto.randomUUID(),
        type: 'project',
        slug: 'p2',
        name: 'P2',
        now: now(),
      });
      expect(repo.listLayers().length).toBe(3);
      expect(
        repo
          .listLayers({ type: 'project' })
          .map((l) => l.slug)
          .sort(),
      ).toEqual(['p1', 'p2']);
      repo.softDeleteLayer(project.id, now());
      expect(repo.listLayers({ type: 'project' }).map((l) => l.slug)).toEqual(['p2']);
      expect(
        repo
          .listLayers({ type: 'project', includeDeleted: true })
          .map((l) => l.slug)
          .sort(),
      ).toEqual(['p1', 'p2']);
    } finally {
      db.close();
    }
  });

  it('updateLayer bumps version and updated_at; soft-delete bumps version', () => {
    const db = mkDb();
    try {
      const repo = createLayersRepo(db);
      const created = repo.insertLayer({
        id: crypto.randomUUID(),
        type: 'project',
        slug: 'p1',
        name: 'P1',
        now: '2026-01-01T00:00:00.000Z',
      });
      const updated = repo.updateLayer(
        created.id,
        { name: 'P1 Renamed', description: 'desc' },
        '2026-01-02T00:00:00.000Z',
      );
      expect(updated.name).toBe('P1 Renamed');
      expect(updated.description).toBe('desc');
      expect(updated.version).toBe(2);
      expect(updated.updatedAt).toBe('2026-01-02T00:00:00.000Z');

      repo.softDeleteLayer(created.id, '2026-01-03T00:00:00.000Z');
      const after = repo.getLayerById(created.id);
      expect(after?.deletedAt).toBe('2026-01-03T00:00:00.000Z');
      expect(after?.version).toBe(3);
    } finally {
      db.close();
    }
  });

  it('rejects a duplicate slug regardless of case', () => {
    const db = mkDb();
    try {
      const repo = createLayersRepo(db);
      repo.insertLayer({
        id: crypto.randomUUID(),
        type: 'project',
        slug: 'Bunny2',
        name: 'B',
        now: now(),
      });
      expect(() =>
        repo.insertLayer({
          id: crypto.randomUUID(),
          type: 'project',
          slug: 'bunny2',
          name: 'B',
          now: now(),
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});

describe('layer-visibility-repo', () => {
  it('adds, lists and removes edges; rejects a self-edge', () => {
    const db = mkDb();
    try {
      const layers = createLayersRepo(db);
      const a = layers.insertLayer({
        id: crypto.randomUUID(),
        type: 'project',
        slug: 'a',
        name: 'A',
        now: now(),
      });
      const b = layers.insertLayer({
        id: crypto.randomUUID(),
        type: 'project',
        slug: 'b',
        name: 'B',
        now: now(),
      });
      const repo = createLayerVisibilityRepo(db);
      repo.addEdge({
        parentLayerId: a.id,
        childLayerId: b.id,
        direction: 'bottom_up',
        now: now(),
      });
      expect(repo.listEdgesForChild(b.id).length).toBe(1);
      expect(repo.listEdgesForParent(a.id).length).toBe(1);
      expect(() =>
        repo.addEdge({
          parentLayerId: a.id,
          childLayerId: a.id,
          direction: 'bottom_up',
          now: now(),
        }),
      ).toThrow();
      repo.removeEdge(a.id, b.id);
      expect(repo.listEdgesForChild(b.id).length).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('layer-members-repo', () => {
  it('adds, lists, and removes user + group members idempotently', () => {
    const db = mkDb();
    try {
      const u = newUser(db, 'alice');
      const g = newGroup(db, 'devs');
      const layer = createLayersRepo(db).insertLayer({
        id: crypto.randomUUID(),
        type: 'project',
        slug: 'p',
        name: 'P',
        now: now(),
      });
      const repo = createLayerMembersRepo(db);

      repo.addUserMember({ layerId: layer.id, userId: u.id, role: 'owner', now: now() });
      // Idempotent re-add: must not throw.
      repo.addUserMember({ layerId: layer.id, userId: u.id, role: 'owner', now: now() });
      expect(repo.listUserMembers(layer.id).map((m) => m.userId)).toEqual([u.id]);
      expect(repo.listLayersForUser(u.id).map((m) => m.layerId)).toEqual([layer.id]);

      // Removing a non-member is a no-op.
      repo.removeUserMember(layer.id, crypto.randomUUID());
      expect(repo.listUserMembers(layer.id).length).toBe(1);
      repo.removeUserMember(layer.id, u.id);
      expect(repo.listUserMembers(layer.id).length).toBe(0);

      repo.addGroupMember({ layerId: layer.id, groupId: g.id, now: now() });
      repo.addGroupMember({ layerId: layer.id, groupId: g.id, now: now() });
      expect(repo.listGroupMembers(layer.id).map((m) => m.groupId)).toEqual([g.id]);
      expect(repo.listLayersForGroup(g.id).map((m) => m.layerId)).toEqual([layer.id]);
      repo.removeGroupMember(layer.id, g.id);
      expect(repo.listGroupMembers(layer.id).length).toBe(0);
    } finally {
      db.close();
    }
  });

  it("defaults role to 'member' when not provided", () => {
    const db = mkDb();
    try {
      const u = newUser(db, 'bob');
      const layer = createLayersRepo(db).insertLayer({
        id: crypto.randomUUID(),
        type: 'project',
        slug: 'p',
        name: 'P',
        now: now(),
      });
      const repo = createLayerMembersRepo(db);
      repo.addUserMember({ layerId: layer.id, userId: u.id, now: now() });
      expect(repo.listUserMembers(layer.id)[0]?.role).toBe('member');
    } finally {
      db.close();
    }
  });
});

describe('layer-locales-repo', () => {
  it('setLocales replaces transactionally; default lookup works', () => {
    const db = mkDb();
    try {
      const layer = createLayersRepo(db).insertLayer({
        id: crypto.randomUUID(),
        type: 'project',
        slug: 'p',
        name: 'P',
        now: now(),
      });
      const repo = createLayerLocalesRepo(db);
      repo.setLocales(layer.id, ['en', 'nl', 'fr'], 'nl', now());
      const locales = repo.listLocales(layer.id);
      expect(locales.map((l) => l.locale).sort()).toEqual(['en', 'fr', 'nl']);
      expect(locales.find((l) => l.locale === 'nl')?.isDefault).toBe(true);
      expect(locales.find((l) => l.locale === 'en')?.isDefault).toBe(false);

      // Replace: previous entries are deleted in the same tx.
      repo.setLocales(layer.id, ['en'], 'en', now());
      const after = repo.listLocales(layer.id);
      expect(after.length).toBe(1);
      expect(after[0]?.locale).toBe('en');
      expect(after[0]?.isDefault).toBe(true);
    } finally {
      db.close();
    }
  });

  it('rejects a defaultLocale not in the locales list', () => {
    const db = mkDb();
    try {
      const layer = createLayersRepo(db).insertLayer({
        id: crypto.randomUUID(),
        type: 'project',
        slug: 'p',
        name: 'P',
        now: now(),
      });
      const repo = createLayerLocalesRepo(db);
      expect(() => repo.setLocales(layer.id, ['en'], 'nl', now())).toThrow();
    } finally {
      db.close();
    }
  });
});

describe('layer-attachments-repo', () => {
  it('insert/list/remove and parses config_json on read', () => {
    const db = mkDb();
    try {
      const layer = createLayersRepo(db).insertLayer({
        id: crypto.randomUUID(),
        type: 'project',
        slug: 'p',
        name: 'P',
        now: now(),
      });
      const repo = createLayerAttachmentsRepo(db);
      const att = repo.insertAttachment({
        id: crypto.randomUUID(),
        layerId: layer.id,
        kind: 'agent',
        refId: 'agent-1',
        config: { model: 'gpt-4o' },
        now: now(),
      });
      expect(att.config).toEqual({ model: 'gpt-4o' });
      const list = repo.listAttachments(layer.id);
      expect(list.length).toBe(1);
      expect(list[0]?.config).toEqual({ model: 'gpt-4o' });
      expect(repo.listAttachments(layer.id, 'skill').length).toBe(0);
      repo.removeAttachment(att.id);
      expect(repo.listAttachments(layer.id).length).toBe(0);
      // Removing a missing one is a no-op.
      repo.removeAttachment(att.id);
    } finally {
      db.close();
    }
  });

  it('rejects an invalid kind via the table CHECK constraint', () => {
    const db = mkDb();
    try {
      const layer = createLayersRepo(db).insertLayer({
        id: crypto.randomUUID(),
        type: 'project',
        slug: 'p',
        name: 'P',
        now: now(),
      });
      expect(() =>
        db
          .query<unknown, [string, string, string, string, string, string]>(
            `INSERT INTO layer_attachments
               (id, layer_id, kind, ref_id, config_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(crypto.randomUUID(), layer.id, 'bogus', 'r', '{}', now()),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});

describe('layer-widgets-repo', () => {
  it('insert/list/move/remove', () => {
    const db = mkDb();
    try {
      const layer = createLayersRepo(db).insertLayer({
        id: crypto.randomUUID(),
        type: 'project',
        slug: 'p',
        name: 'P',
        now: now(),
      });
      const repo = createLayerWidgetsRepo(db);
      const w1 = repo.insertWidget({
        id: crypto.randomUUID(),
        layerId: layer.id,
        widgetKind: 'notes',
        position: 1,
        now: now(),
      });
      const w2 = repo.insertWidget({
        id: crypto.randomUUID(),
        layerId: layer.id,
        widgetKind: 'todos',
        position: 0,
        layout: { rows: 2 },
        now: now(),
      });
      const list = repo.listWidgets(layer.id);
      expect(list.map((w) => w.id)).toEqual([w2.id, w1.id]);
      expect(list[0]?.layout).toEqual({ rows: 2 });

      repo.moveWidget(w1.id, -1);
      const reordered = repo.listWidgets(layer.id);
      expect(reordered.map((w) => w.id)).toEqual([w1.id, w2.id]);

      repo.removeWidget(w1.id);
      expect(repo.listWidgets(layer.id).map((w) => w.id)).toEqual([w2.id]);
      // Idempotent.
      repo.removeWidget(w1.id);
    } finally {
      db.close();
    }
  });
});
