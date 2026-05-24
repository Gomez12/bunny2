import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import { openDatabase } from '../../src/storage/sqlite';
import { createSqliteLlmCallLog } from '../../src/llm/call-log';
import { createLlmPruneHandler } from '../../src/scheduled/built-in/llm-prune';
import type { ScheduledTask, ScheduledTaskRun } from '../../src/scheduled/repo';
import type {
  ScheduledTaskHandlerLogger,
  ScheduledTaskRunContext,
} from '../../src/scheduled/registry';
import type { LlmClient } from '../../src/llm';

function mkDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-llmprune-h-'));
  return openDatabase(dir);
}

function seedRow(db: Database, id: string, startedAt: string): void {
  db.query<unknown, [string, string, string, string, string]>(
    `INSERT INTO llm_calls (id, started_at, model, endpoint, request)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, startedAt, 'm', 'mock://echo', '{}');
}

function fakeTask(config: Record<string, unknown>): ScheduledTask {
  // Only the fields the handler actually reads need to be real.
  return {
    id: 't',
    layerId: 'l',
    slug: 'llm-calls-prune',
    kind: 'llm.calls.prune',
    name: 'x',
    status: 'active',
    pauseReason: null,
    schedule: { kind: 'interval', intervalMinutes: 60 * 24 },
    config,
    maxAttempts: 3,
    backoffBaseMs: 60_000,
    backoffMaxMs: 3_600_000,
    nextRunAt: '2026-05-24T00:00:00.000Z',
    lastRunAt: null,
    attempt: 0,
    claimedAt: null,
    claimedByPid: null,
    version: 1,
    createdAt: '2026-05-24T00:00:00.000Z',
    createdBy: 'u',
    updatedAt: '2026-05-24T00:00:00.000Z',
    updatedBy: 'u',
    deletedAt: null,
    deletedBy: null,
  };
}

function fakeRun(): ScheduledTaskRun {
  return {
    id: 'r',
    taskId: 't',
    status: 'started',
    attempt: 1,
    triggeredBy: 'schedule',
    requestedAt: '2026-05-24T00:00:00.000Z',
    startedAt: '2026-05-24T00:00:00.000Z',
    finishedAt: null,
    durationMs: null,
    error: null,
    correlationId: 'c',
  };
}

function fakeLlm(): LlmClient {
  return {
    endpoint: 'test://noop',
    defaultModel: 'noop',
    async chat() {
      throw new Error('llm not used');
    },
  } as unknown as LlmClient;
}

function captureLogger(): ScheduledTaskHandlerLogger & {
  readonly entries: { msg: string; fields: Readonly<Record<string, unknown>> | undefined }[];
} {
  const entries: { msg: string; fields: Readonly<Record<string, unknown>> | undefined }[] = [];
  return {
    entries,
    info(msg, fields) {
      entries.push({ msg, fields });
    },
    warn(msg, fields) {
      entries.push({ msg, fields });
    },
    error(msg, fields) {
      entries.push({ msg, fields });
    },
  };
}

function makeCtx(
  db: Database,
  task: ScheduledTask,
  nowIso: string,
  logger: ScheduledTaskHandlerLogger,
): ScheduledTaskRunContext {
  return {
    task,
    run: fakeRun(),
    correlationId: 'c',
    now: (): string => nowIso,
    db,
    bus: new InMemoryMessageBus(),
    llm: fakeLlm(),
    logger,
  };
}

describe('llm.calls.prune handler', () => {
  it('deletes rows older than the default retention when config is empty', async () => {
    const db = mkDb();
    try {
      const log = createSqliteLlmCallLog(db);
      // Default retention = 180 days; today = 2026-05-23 → cutoff = 2025-11-24.
      seedRow(db, 'old', '2025-01-01T00:00:00.000Z');
      seedRow(db, 'recent', '2026-05-22T00:00:00.000Z');
      expect(log.count()).toBe(2);

      const handler = createLlmPruneHandler({ llmCallLog: log, defaultRetentionDays: 180 });
      const logger = captureLogger();
      await handler.run(makeCtx(db, fakeTask({}), '2026-05-23T00:00:00.000Z', logger));
      expect(log.count()).toBe(1);
    } finally {
      db.close();
    }
  });

  it('honors task.config.retentionDays override', async () => {
    const db = mkDb();
    try {
      const log = createSqliteLlmCallLog(db);
      seedRow(db, 'a', '2026-05-01T00:00:00.000Z'); // 22 days old at "now"
      seedRow(db, 'b', '2026-05-22T00:00:00.000Z'); // 1 day old
      expect(log.count()).toBe(2);

      // Override retentionDays = 7 → only `b` survives.
      const handler = createLlmPruneHandler({ llmCallLog: log, defaultRetentionDays: 180 });
      const logger = captureLogger();
      await handler.run(
        makeCtx(db, fakeTask({ retentionDays: 7 }), '2026-05-23T00:00:00.000Z', logger),
      );
      expect(log.count()).toBe(1);
      const surviving = db
        .query<{ id: string }, []>('SELECT id FROM llm_calls')
        .all()
        .map((r) => r.id);
      expect(surviving).toEqual(['b']);
    } finally {
      db.close();
    }
  });

  it('ignores non-positive / non-integer config and falls back to the factory default', async () => {
    const db = mkDb();
    try {
      const log = createSqliteLlmCallLog(db);
      seedRow(db, 'old', '2025-01-01T00:00:00.000Z');
      seedRow(db, 'recent', '2026-05-22T00:00:00.000Z');

      const handler = createLlmPruneHandler({ llmCallLog: log, defaultRetentionDays: 180 });
      const logger = captureLogger();
      await handler.run(
        // Bad value — handler must fall back to defaultRetentionDays=180.
        makeCtx(db, fakeTask({ retentionDays: -3 }), '2026-05-23T00:00:00.000Z', logger),
      );
      expect(log.count()).toBe(1);
    } finally {
      db.close();
    }
  });

  it('declares a daily defaultSchedule', () => {
    const log = createSqliteLlmCallLog(mkDb());
    const handler = createLlmPruneHandler({ llmCallLog: log, defaultRetentionDays: 180 });
    expect(handler.kind).toBe('llm.calls.prune');
    expect(handler.defaultSchedule).toEqual({ kind: 'interval', intervalMinutes: 60 * 24 });
  });
});
