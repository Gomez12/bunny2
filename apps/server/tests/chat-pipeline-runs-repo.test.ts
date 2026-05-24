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
import { createChatPipelineRunsRepo } from '../src/chat/repos/chat-pipeline-runs-repo';

const now = () => new Date().toISOString();

function mkDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-chat-run-'));
  return openDatabase(dir);
}

function seedAssistantMessage(db: Database): string {
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
    content: '',
    status: 'running',
    correlationId: 'c',
    flowId: 'f',
    now: now(),
  });
  return msg.id;
}

describe('chat-pipeline-runs-repo', () => {
  it('inserts and reads back a pending run', () => {
    const db = mkDb();
    try {
      const messageId = seedAssistantMessage(db);
      const repo = createChatPipelineRunsRepo(db);
      const run = repo.insertRun({
        id: crypto.randomUUID(),
        messageId,
        status: 'pending',
        startedAt: now(),
      });
      expect(run.status).toBe('pending');
      expect(run.endedAt).toBeNull();
      expect(repo.getRunById(run.id)?.messageId).toBe(messageId);
    } finally {
      db.close();
    }
  });

  it('lists runs for a message in start order', () => {
    const db = mkDb();
    try {
      const messageId = seedAssistantMessage(db);
      const repo = createChatPipelineRunsRepo(db);
      const r1 = repo.insertRun({
        id: crypto.randomUUID(),
        messageId,
        status: 'failed',
        startedAt: '2026-01-01T00:00:00.000Z',
      });
      const r2 = repo.insertRun({
        id: crypto.randomUUID(),
        messageId,
        status: 'pending',
        startedAt: '2026-01-02T00:00:00.000Z',
      });
      expect(repo.listByMessage(messageId).map((r) => r.id)).toEqual([r1.id, r2.id]);
    } finally {
      db.close();
    }
  });

  it('updates the run on terminal transition', () => {
    const db = mkDb();
    try {
      const messageId = seedAssistantMessage(db);
      const repo = createChatPipelineRunsRepo(db);
      const run = repo.insertRun({
        id: crypto.randomUUID(),
        messageId,
        status: 'running',
        startedAt: '2026-01-01T00:00:00.000Z',
      });
      const done = repo.updateRun(run.id, {
        status: 'succeeded',
        endedAt: '2026-01-01T00:00:05.000Z',
      });
      expect(done.status).toBe('succeeded');
      expect(done.endedAt).toBe('2026-01-01T00:00:05.000Z');
    } finally {
      db.close();
    }
  });
});
