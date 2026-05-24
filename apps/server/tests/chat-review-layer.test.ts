/**
 * Phase 6.6 — `chat.review-layer` placeholder handler.
 *
 * Pins that the kind is registered, the handler returns without
 * throwing, and the placeholder logs an event on each run so a
 * future ops dashboard can see the kind is wired (the real body
 * lands in phase 7).
 */

import { describe, expect, it } from 'bun:test';
import { chatReviewLayerHandler, CHAT_REVIEW_LAYER_KIND } from '../src/chat/review-layer-handler';
import type { ScheduledTask, ScheduledTaskRun, ScheduledTaskRunContext } from '../src/scheduled';

interface LogEntry {
  readonly level: 'info' | 'warn' | 'error';
  readonly msg: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

function makeCtx(): { ctx: ScheduledTaskRunContext; logs: LogEntry[] } {
  const nowIso = new Date('2026-05-24T12:00:00.000Z').toISOString();
  const logs: LogEntry[] = [];
  const task: ScheduledTask = {
    id: 'task-rl',
    layerId: 'layer-everyone',
    slug: 'chat-review-layer',
    kind: CHAT_REVIEW_LAYER_KIND,
    name: 'chat.review-layer',
    status: 'active',
    pauseReason: null,
    schedule: { kind: 'interval', intervalMinutes: 1440 },
    config: {},
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
    id: 'run-rl',
    taskId: task.id,
    status: 'started',
    attempt: 1,
    triggeredBy: 'schedule',
    requestedAt: nowIso,
    startedAt: nowIso,
    finishedAt: null,
    durationMs: null,
    error: null,
    correlationId: 'cor-rl',
  };
  const ctx: ScheduledTaskRunContext = {
    task,
    run,
    correlationId: 'cor-rl',
    now: () => nowIso,
    db: null as never,
    bus: null as never,
    llm: null as never,
    logger: {
      info: (msg, fields): void => {
        logs.push({ level: 'info', msg, fields });
      },
      warn: (msg, fields): void => {
        logs.push({ level: 'warn', msg, fields });
      },
      error: (msg, fields): void => {
        logs.push({ level: 'error', msg, fields });
      },
    },
  };
  return { ctx, logs };
}

describe('phase 6.6 — chat.review-layer placeholder', () => {
  it('registers the canonical kind', () => {
    expect(chatReviewLayerHandler.kind).toBe(CHAT_REVIEW_LAYER_KIND);
    expect(chatReviewLayerHandler.kind).toBe('chat.review-layer');
  });

  it('returns success and logs a placeholder event', async () => {
    const { ctx, logs } = makeCtx();
    await chatReviewLayerHandler.run(ctx);
    const evt = logs.find((l) => l.fields?.['event'] === 'chat.review-layer.placeholder');
    expect(evt).toBeDefined();
    expect(evt?.level).toBe('info');
  });
});
