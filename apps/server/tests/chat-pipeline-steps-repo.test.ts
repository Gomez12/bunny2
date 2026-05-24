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
import { createChatPipelineStepsRepo } from '../src/chat/repos/chat-pipeline-steps-repo';

const now = () => new Date().toISOString();

function mkDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-chat-step-'));
  return openDatabase(dir);
}

function seedRun(db: Database): string {
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
  const run = createChatPipelineRunsRepo(db).insertRun({
    id: crypto.randomUUID(),
    messageId: msg.id,
    status: 'running',
    startedAt: now(),
  });
  return run.id;
}

describe('chat-pipeline-steps-repo', () => {
  it('inserts a pending step with default attempt = 1', () => {
    const db = mkDb();
    try {
      const runId = seedRun(db);
      const repo = createChatPipelineStepsRepo(db);
      const step = repo.insertStep({
        id: crypto.randomUUID(),
        runId,
        kind: 'intent',
        status: 'pending',
        startedAt: now(),
      });
      expect(step.kind).toBe('intent');
      expect(step.attempt).toBe(1);
      expect(step.outputJson).toBeNull();
      expect(step.llmCallId).toBeNull();
    } finally {
      db.close();
    }
  });

  it('lists steps for a run in start order', () => {
    const db = mkDb();
    try {
      const runId = seedRun(db);
      const repo = createChatPipelineStepsRepo(db);
      const a = repo.insertStep({
        id: crypto.randomUUID(),
        runId,
        kind: 'intent',
        status: 'succeeded',
        startedAt: '2026-01-01T00:00:00.000Z',
      });
      const b = repo.insertStep({
        id: crypto.randomUUID(),
        runId,
        kind: 'entities',
        status: 'succeeded',
        startedAt: '2026-01-01T00:00:01.000Z',
      });
      const c = repo.insertStep({
        id: crypto.randomUUID(),
        runId,
        kind: 'retrieval',
        status: 'succeeded',
        startedAt: '2026-01-01T00:00:02.000Z',
      });
      const d = repo.insertStep({
        id: crypto.randomUUID(),
        runId,
        kind: 'answer',
        status: 'running',
        startedAt: '2026-01-01T00:00:03.000Z',
      });
      expect(repo.listByRun(runId).map((s) => s.id)).toEqual([a.id, b.id, c.id, d.id]);
    } finally {
      db.close();
    }
  });

  it('writes output_json + llm_call_id on terminal transition', () => {
    const db = mkDb();
    try {
      const runId = seedRun(db);
      const repo = createChatPipelineStepsRepo(db);
      const step = repo.insertStep({
        id: crypto.randomUUID(),
        runId,
        kind: 'intent',
        status: 'running',
        startedAt: now(),
        inputJson: JSON.stringify({ text: 'hi' }),
      });
      // The FK on `llm_call_id` references `llm_calls(id)`, so seed a
      // call row before pointing the step at it.
      const llmCallId = crypto.randomUUID();
      db.query<unknown, [string, string, string, string, string]>(
        'INSERT INTO llm_calls (id, started_at, model, endpoint, request) VALUES (?, ?, ?, ?, ?)',
      ).run(llmCallId, now(), 'test-model', 'test://endpoint', '{}');
      const done = repo.updateStep(step.id, {
        status: 'succeeded',
        endedAt: '2026-01-01T00:00:01.000Z',
        outputJson: JSON.stringify({ intent: 'smalltalk' }),
        llmCallId,
      });
      expect(done.status).toBe('succeeded');
      expect(done.outputJson).toBe('{"intent":"smalltalk"}');
      expect(done.llmCallId).toBe(llmCallId);
      expect(done.errorCode).toBeNull();
    } finally {
      db.close();
    }
  });

  it('records a failed step with an error_code and preserves the input', () => {
    const db = mkDb();
    try {
      const runId = seedRun(db);
      const repo = createChatPipelineStepsRepo(db);
      const step = repo.insertStep({
        id: crypto.randomUUID(),
        runId,
        kind: 'intent',
        status: 'running',
        startedAt: now(),
        inputJson: '{"text":"hi"}',
      });
      const failed = repo.updateStep(step.id, {
        status: 'failed',
        endedAt: now(),
        errorCode: 'invalid_step_output',
      });
      expect(failed.status).toBe('failed');
      expect(failed.errorCode).toBe('invalid_step_output');
      expect(failed.inputJson).toBe('{"text":"hi"}');
    } finally {
      db.close();
    }
  });
});
