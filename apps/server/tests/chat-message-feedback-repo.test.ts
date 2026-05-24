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
import { createChatMessageFeedbackRepo } from '../src/chat/repos/chat-message-feedback-repo';

const now = () => new Date().toISOString();

function mkDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-chat-fb-'));
  return openDatabase(dir);
}

function seed(db: Database): { messageId: string; userId: string } {
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
  const msg = createChatMessagesRepo(db).insertMessage({
    id: crypto.randomUUID(),
    conversationId: conv.id,
    role: 'assistant',
    content: 'answer',
    status: 'done',
    correlationId: 'c',
    flowId: 'f',
    now: now(),
  });
  return { messageId: msg.id, userId: user.id };
}

describe('chat-message-feedback-repo', () => {
  it('inserts a thumbs-up feedback row', () => {
    const db = mkDb();
    try {
      const { messageId, userId } = seed(db);
      const repo = createChatMessageFeedbackRepo(db);
      const fb = repo.upsertFeedback({
        id: crypto.randomUUID(),
        messageId,
        userId,
        value: 'up',
        now: now(),
      });
      expect(fb.value).toBe('up');
      expect(fb.reason).toBeNull();
      expect(repo.getFeedbackByMessageId(messageId)?.value).toBe('up');
    } finally {
      db.close();
    }
  });

  it('second upsert overwrites the existing feedback row via UNIQUE(message_id)', () => {
    const db = mkDb();
    try {
      const { messageId, userId } = seed(db);
      const repo = createChatMessageFeedbackRepo(db);
      const first = repo.upsertFeedback({
        id: crypto.randomUUID(),
        messageId,
        userId,
        value: 'up',
        now: '2026-01-01T00:00:00.000Z',
      });
      const second = repo.upsertFeedback({
        id: crypto.randomUUID(),
        messageId,
        userId,
        value: 'down',
        reason: 'wrong date',
        now: '2026-01-02T00:00:00.000Z',
      });
      // ON CONFLICT(message_id) preserves the original `id` and
      // overwrites the mutable fields.
      expect(second.id).toBe(first.id);
      expect(second.value).toBe('down');
      expect(second.reason).toBe('wrong date');
      expect(second.createdAt).toBe('2026-01-02T00:00:00.000Z');
      // And only one row exists in total.
      const direct = db
        .query<
          { n: number },
          [string]
        >('SELECT COUNT(*) AS n FROM chat_message_feedback WHERE message_id = ?')
        .get(messageId);
      expect(direct?.n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('returns null when no feedback exists yet', () => {
    const db = mkDb();
    try {
      const { messageId } = seed(db);
      const repo = createChatMessageFeedbackRepo(db);
      expect(repo.getFeedbackByMessageId(messageId)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('rejects an invalid feedback value via the SQL CHECK', () => {
    const db = mkDb();
    try {
      const { messageId, userId } = seed(db);
      const repo = createChatMessageFeedbackRepo(db);
      expect(() =>
        repo.upsertFeedback({
          id: crypto.randomUUID(),
          messageId,
          userId,
          value: 'sideways' as unknown as 'up',
          now: now(),
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
