import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../src/storage/sqlite';
import { createUsersRepo } from '../src/repos/users-repo';
import { createLayersRepo } from '../src/repos/layers-repo';
import { createChatConversationsRepo } from '../src/chat/repos/chat-conversations-repo';

const now = () => new Date().toISOString();

function mkDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-chat-conv-'));
  return openDatabase(dir);
}

function seedUserAndLayer(db: Database): { userId: string; layerId: string } {
  const user = createUsersRepo(db).createUser({
    id: crypto.randomUUID(),
    username: 'admin',
    displayName: 'Admin',
    passwordHash: 'h',
    mustChangePassword: false,
    now: now(),
  });
  const layer = createLayersRepo(db).insertLayer({
    id: crypto.randomUUID(),
    type: 'everyone',
    slug: 'everyone',
    name: 'Everyone',
    now: now(),
  });
  return { userId: user.id, layerId: layer.id };
}

describe('chat-conversations-repo', () => {
  it('inserts and reads back a conversation by id', () => {
    const db = mkDb();
    try {
      const { userId, layerId } = seedUserAndLayer(db);
      const repo = createChatConversationsRepo(db);
      const created = repo.insertConversation({
        id: crypto.randomUUID(),
        layerId,
        userId,
        title: 'When is the Acme meeting?',
        locale: 'en',
        now: now(),
      });
      expect(created.title).toBe('When is the Acme meeting?');
      expect(created.locale).toBe('en');
      expect(created.deletedAt).toBeNull();
      expect(repo.getConversationById(created.id)?.title).toBe(created.title);
    } finally {
      db.close();
    }
  });

  it('lists conversations newest-first per (layer, user) and excludes soft-deleted', () => {
    const db = mkDb();
    try {
      const { userId, layerId } = seedUserAndLayer(db);
      const repo = createChatConversationsRepo(db);
      const a = repo.insertConversation({
        id: crypto.randomUUID(),
        layerId,
        userId,
        title: 'first',
        locale: 'en',
        now: '2026-01-01T00:00:00.000Z',
      });
      const b = repo.insertConversation({
        id: crypto.randomUUID(),
        layerId,
        userId,
        title: 'second',
        locale: 'en',
        now: '2026-01-02T00:00:00.000Z',
      });
      const list = repo.listConversations({ layerId, userId });
      expect(list.map((c) => c.id)).toEqual([b.id, a.id]);
      // Soft-delete with a timestamp older than b's `updated_at` so the
      // `includeDeleted` ordering remains [b, a]. The repo bumps
      // `updated_at` on soft-delete to keep the audit trail.
      repo.softDeleteConversation(a.id, userId, '2026-01-01T12:00:00.000Z');
      expect(repo.listConversations({ layerId, userId }).map((c) => c.id)).toEqual([b.id]);
      expect(
        repo.listConversations({ layerId, userId, includeDeleted: true }).map((c) => c.id),
      ).toEqual([b.id, a.id]);
    } finally {
      db.close();
    }
  });

  it('soft-delete sets deleted_at and deleted_by; restores invisible to plain list', () => {
    const db = mkDb();
    try {
      const { userId, layerId } = seedUserAndLayer(db);
      const repo = createChatConversationsRepo(db);
      const created = repo.insertConversation({
        id: crypto.randomUUID(),
        layerId,
        userId,
        title: 'tmp',
        locale: 'en',
        now: now(),
      });
      repo.softDeleteConversation(created.id, userId, '2026-02-02T00:00:00.000Z');
      const reloaded = repo.getConversationById(created.id);
      expect(reloaded?.deletedAt).toBe('2026-02-02T00:00:00.000Z');
      expect(reloaded?.deletedBy).toBe(userId);
    } finally {
      db.close();
    }
  });

  it('updateConversation rewrites title + locale and touches updated_at', () => {
    const db = mkDb();
    try {
      const { userId, layerId } = seedUserAndLayer(db);
      const repo = createChatConversationsRepo(db);
      const created = repo.insertConversation({
        id: crypto.randomUUID(),
        layerId,
        userId,
        title: 'old',
        locale: 'en',
        now: '2026-01-01T00:00:00.000Z',
      });
      const updated = repo.updateConversation(
        created.id,
        { title: 'new', locale: 'nl' },
        '2026-01-02T00:00:00.000Z',
      );
      expect(updated.title).toBe('new');
      expect(updated.locale).toBe('nl');
      expect(updated.updatedAt).toBe('2026-01-02T00:00:00.000Z');
    } finally {
      db.close();
    }
  });

  it('touchConversation only moves updated_at and skips soft-deleted rows', () => {
    const db = mkDb();
    try {
      const { userId, layerId } = seedUserAndLayer(db);
      const repo = createChatConversationsRepo(db);
      const created = repo.insertConversation({
        id: crypto.randomUUID(),
        layerId,
        userId,
        title: 'x',
        locale: 'en',
        now: '2026-01-01T00:00:00.000Z',
      });
      repo.touchConversation(created.id, '2026-01-05T00:00:00.000Z');
      expect(repo.getConversationById(created.id)?.updatedAt).toBe('2026-01-05T00:00:00.000Z');
      repo.softDeleteConversation(created.id, userId, '2026-01-06T00:00:00.000Z');
      // No-op on a soft-deleted row.
      repo.touchConversation(created.id, '2026-01-07T00:00:00.000Z');
      expect(repo.getConversationById(created.id)?.updatedAt).toBe('2026-01-06T00:00:00.000Z');
    } finally {
      db.close();
    }
  });
});
