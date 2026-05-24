import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../src/storage/sqlite';
import { createUsersRepo } from '../src/repos/users-repo';
import { createLayersRepo } from '../src/repos/layers-repo';
import { createChatConversationsRepo } from '../src/chat/repos/chat-conversations-repo';
import { createChatMessagesRepo } from '../src/chat/repos/chat-messages-repo';

const now = () => new Date().toISOString();

function mkDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-chat-msg-'));
  return openDatabase(dir);
}

function seedConversation(db: Database): { conversationId: string; userId: string } {
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
  const conv = createChatConversationsRepo(db).insertConversation({
    id: crypto.randomUUID(),
    layerId: layer.id,
    userId: user.id,
    title: 't',
    locale: 'en',
    now: now(),
  });
  return { conversationId: conv.id, userId: user.id };
}

describe('chat-messages-repo', () => {
  it('inserts a user message in queued state and reads it back', () => {
    const db = mkDb();
    try {
      const { conversationId } = seedConversation(db);
      const repo = createChatMessagesRepo(db);
      const msg = repo.insertMessage({
        id: crypto.randomUUID(),
        conversationId,
        role: 'user',
        content: 'hello',
        status: 'queued',
        correlationId: 'corr-1',
        flowId: 'flow-1',
        now: now(),
      });
      expect(msg.role).toBe('user');
      expect(msg.status).toBe('queued');
      expect(msg.tokensIn).toBeNull();
      expect(msg.finishedAt).toBeNull();
      expect(repo.getMessageById(msg.id)?.content).toBe('hello');
    } finally {
      db.close();
    }
  });

  it('lists messages in a conversation in ascending created_at order', () => {
    const db = mkDb();
    try {
      const { conversationId } = seedConversation(db);
      const repo = createChatMessagesRepo(db);
      const m1 = repo.insertMessage({
        id: crypto.randomUUID(),
        conversationId,
        role: 'user',
        content: 'first',
        status: 'done',
        correlationId: 'c',
        flowId: 'f',
        now: '2026-01-01T00:00:00.000Z',
      });
      const m2 = repo.insertMessage({
        id: crypto.randomUUID(),
        conversationId,
        role: 'assistant',
        content: 'second',
        status: 'done',
        correlationId: 'c',
        flowId: 'f',
        now: '2026-01-02T00:00:00.000Z',
      });
      const list = repo.listByConversation(conversationId);
      expect(list.map((m) => m.id)).toEqual([m1.id, m2.id]);
    } finally {
      db.close();
    }
  });

  it('updateMessage finalises an assistant turn with model + token counts', () => {
    const db = mkDb();
    try {
      const { conversationId } = seedConversation(db);
      const repo = createChatMessagesRepo(db);
      const msg = repo.insertMessage({
        id: crypto.randomUUID(),
        conversationId,
        role: 'assistant',
        content: '',
        status: 'running',
        correlationId: 'c',
        flowId: 'f',
        now: now(),
      });
      const done = repo.updateMessage(msg.id, {
        status: 'done',
        content: 'final answer',
        model: 'gpt-test',
        tokensIn: 12,
        tokensOut: 34,
        finishedAt: '2026-01-02T00:00:00.000Z',
      });
      expect(done.status).toBe('done');
      expect(done.content).toBe('final answer');
      expect(done.model).toBe('gpt-test');
      expect(done.tokensIn).toBe(12);
      expect(done.tokensOut).toBe(34);
      expect(done.finishedAt).toBe('2026-01-02T00:00:00.000Z');
    } finally {
      db.close();
    }
  });

  it('rejects messages with an invalid role via the SQL CHECK', () => {
    const db = mkDb();
    try {
      const { conversationId } = seedConversation(db);
      const repo = createChatMessagesRepo(db);
      expect(() =>
        repo.insertMessage({
          id: crypto.randomUUID(),
          conversationId,
          // Cast widens the static type only; the SQL CHECK rejects it.
          role: 'bot' as unknown as 'user',
          content: 'hi',
          status: 'queued',
          correlationId: 'c',
          flowId: 'f',
          now: now(),
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
