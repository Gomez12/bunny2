/**
 * Phase 6.6 — `chat.runs.prune` retention tests.
 *
 * Covers:
 *  - deletes only `chat_pipeline_runs` rows older than `maxAgeDays`;
 *  - cascades to `chat_pipeline_steps` via the explicit FK-order
 *    delete inside the prune transaction;
 *  - honours the configurable `maxAgeDays` knob;
 *  - is idempotent (a second run against the same cutoff is 0/0).
 */

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
import {
  pruneChatPipelineRuns,
  chatRunsPruneHandler,
  CHAT_RUNS_PRUNE_KIND,
} from '../src/chat/runs-prune-handler';
import type { ScheduledTask, ScheduledTaskRun, ScheduledTaskRunContext } from '../src/scheduled';

function mkDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-chat-runs-prune-'));
  return openDatabase(dir);
}

interface Seed {
  readonly userId: string;
  readonly layerId: string;
  readonly conversationId: string;
}

function seed(db: Database): Seed {
  const nowIso = new Date().toISOString();
  const user = createUsersRepo(db).createUser({
    id: crypto.randomUUID(),
    username: 'alice',
    displayName: 'Alice',
    passwordHash: 'h',
    mustChangePassword: false,
    now: nowIso,
  });
  const layer = createLayersRepo(db).insertLayer({
    id: crypto.randomUUID(),
    type: 'everyone',
    slug: 'everyone',
    name: 'Everyone',
    now: nowIso,
  });
  const conv = createChatConversationsRepo(db).insertConversation({
    id: crypto.randomUUID(),
    layerId: layer.id,
    userId: user.id,
    title: 'demo',
    locale: 'en',
    now: nowIso,
  });
  return { userId: user.id, layerId: layer.id, conversationId: conv.id };
}

function insertRunAndStep(
  db: Database,
  conversationId: string,
  startedAtIso: string,
  correlationId: string,
): { runId: string; stepId: string; messageId: string } {
  const messages = createChatMessagesRepo(db);
  const runs = createChatPipelineRunsRepo(db);
  const steps = createChatPipelineStepsRepo(db);
  const message = messages.insertMessage({
    id: crypto.randomUUID(),
    conversationId,
    role: 'assistant',
    content: 'hi',
    status: 'done',
    correlationId,
    flowId: conversationId,
    now: startedAtIso,
  });
  const run = runs.insertRun({
    id: crypto.randomUUID(),
    messageId: message.id,
    status: 'succeeded',
    startedAt: startedAtIso,
  });
  const step = steps.insertStep({
    id: crypto.randomUUID(),
    runId: run.id,
    kind: 'intent',
    status: 'succeeded',
    startedAt: startedAtIso,
  });
  return { runId: run.id, stepId: step.id, messageId: message.id };
}

function countRows(db: Database, table: 'chat_pipeline_runs' | 'chat_pipeline_steps'): number {
  const row = db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get();
  return row?.count ?? 0;
}

describe('phase 6.6 — chat.runs.prune', () => {
  it('exposes the canonical handler kind', () => {
    expect(chatRunsPruneHandler.kind).toBe(CHAT_RUNS_PRUNE_KIND);
    expect(chatRunsPruneHandler.kind).toBe('chat.runs.prune');
  });

  it('deletes only runs older than the cutoff and cascades to steps', () => {
    const db = mkDb();
    try {
      const { conversationId } = seed(db);
      const now = new Date('2026-05-24T12:00:00.000Z');
      const oldIso = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago
      const recentIso = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
      insertRunAndStep(db, conversationId, oldIso, 'old-corr');
      insertRunAndStep(db, conversationId, recentIso, 'recent-corr');

      expect(countRows(db, 'chat_pipeline_runs')).toBe(2);
      expect(countRows(db, 'chat_pipeline_steps')).toBe(2);

      const res = pruneChatPipelineRuns(db, { maxAgeDays: 30 }, now);
      expect(res.runsDeleted).toBe(1);
      expect(res.stepsDeleted).toBe(1);
      expect(countRows(db, 'chat_pipeline_runs')).toBe(1);
      expect(countRows(db, 'chat_pipeline_steps')).toBe(1);
    } finally {
      db.close();
    }
  });

  it('respects the configurable maxAgeDays knob', () => {
    const db = mkDb();
    try {
      const { conversationId } = seed(db);
      const now = new Date('2026-05-24T12:00:00.000Z');
      const fiveDaysAgoIso = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
      insertRunAndStep(db, conversationId, fiveDaysAgoIso, 'corr-1');

      // maxAgeDays=30 → the 5-day-old row survives.
      const survives = pruneChatPipelineRuns(db, { maxAgeDays: 30 }, now);
      expect(survives.runsDeleted).toBe(0);

      // maxAgeDays=1 → the 5-day-old row gets pruned.
      const tighter = pruneChatPipelineRuns(db, { maxAgeDays: 1 }, now);
      expect(tighter.runsDeleted).toBe(1);
      expect(tighter.stepsDeleted).toBe(1);
    } finally {
      db.close();
    }
  });

  it('is idempotent — a second invocation against the same cutoff returns zero', () => {
    const db = mkDb();
    try {
      const { conversationId } = seed(db);
      const now = new Date('2026-05-24T12:00:00.000Z');
      const oldIso = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();
      insertRunAndStep(db, conversationId, oldIso, 'corr-1');

      const first = pruneChatPipelineRuns(db, { maxAgeDays: 30 }, now);
      expect(first.runsDeleted).toBe(1);
      const second = pruneChatPipelineRuns(db, { maxAgeDays: 30 }, now);
      expect(second.runsDeleted).toBe(0);
      expect(second.stepsDeleted).toBe(0);
    } finally {
      db.close();
    }
  });

  it('handler.run() drives the prune through the run context', async () => {
    const db = mkDb();
    try {
      const { conversationId } = seed(db);
      const now = new Date('2026-05-24T12:00:00.000Z');
      const oldIso = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();
      insertRunAndStep(db, conversationId, oldIso, 'corr-1');

      const ctx = makeCtx(db, now, { maxAgeDays: 30 });
      await chatRunsPruneHandler.run(ctx);
      expect(countRows(db, 'chat_pipeline_runs')).toBe(0);
      expect(countRows(db, 'chat_pipeline_steps')).toBe(0);
    } finally {
      db.close();
    }
  });
});

function makeCtx(
  db: Database,
  now: Date,
  config: Readonly<Record<string, unknown>>,
): ScheduledTaskRunContext {
  const nowIso = now.toISOString();
  const task: ScheduledTask = {
    id: 'task-prune',
    layerId: 'layer-everyone',
    slug: 'chat-runs-prune',
    kind: CHAT_RUNS_PRUNE_KIND,
    name: 'chat.runs.prune',
    status: 'active',
    pauseReason: null,
    schedule: { kind: 'interval', intervalMinutes: 1440 },
    config,
    maxAttempts: 1,
    backoffBaseMs: 1000,
    backoffMaxMs: 10_000,
    nextRunAt: nowIso,
    lastRunAt: null,
    attempt: 0,
    claimedAt: null,
    claimedByPid: null,
    version: 1,
    createdAt: nowIso,
    createdBy: 'system',
    updatedAt: nowIso,
    updatedBy: 'system',
    deletedAt: null,
    deletedBy: null,
  };
  const run: ScheduledTaskRun = {
    id: 'run-1',
    taskId: task.id,
    status: 'started',
    attempt: 1,
    triggeredBy: 'schedule',
    requestedAt: nowIso,
    startedAt: nowIso,
    finishedAt: null,
    durationMs: null,
    error: null,
    correlationId: 'cor-1',
  };
  return {
    task,
    run,
    correlationId: 'cor-1',
    now: () => nowIso,
    db,
    bus: null as never,
    llm: null as never,
    logger: {
      info: (): void => undefined,
      warn: (): void => undefined,
      error: (): void => undefined,
    },
  };
}
