import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import { openDatabase } from '../../src/storage/sqlite';
import { createHealthcheckHandler } from '../../src/scheduled/built-in/healthcheck';
import type { ScheduledTask, ScheduledTaskRun } from '../../src/scheduled/repo';
import type {
  ScheduledTaskHandlerLogger,
  ScheduledTaskRunContext,
} from '../../src/scheduled/registry';
import type { LlmClient } from '../../src/llm';
import type { BusEvent } from '@bunny2/bus';
import type { SystemHealthcheckTickPayload } from '../../src/bus/events';

function mkDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-healthcheck-'));
  return openDatabase(dir);
}

function fakeTask(): ScheduledTask {
  return {
    id: 't',
    layerId: 'l',
    slug: 'system-healthcheck',
    kind: 'system.healthcheck',
    name: 'x',
    status: 'active',
    pauseReason: null,
    schedule: { kind: 'interval', intervalMinutes: 5 },
    config: {},
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

function noopLogger(): ScheduledTaskHandlerLogger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

describe('system.healthcheck handler', () => {
  it('publishes a system.healthcheck.tick event carrying schemaVersion and busAdapter', async () => {
    const db = mkDb();
    try {
      const bus = new InMemoryMessageBus();
      const seen: BusEvent<SystemHealthcheckTickPayload>[] = [];
      bus.subscribe<SystemHealthcheckTickPayload>('system.healthcheck.tick', (e) => {
        seen.push(e);
      });
      const handler = createHealthcheckHandler({
        schemaVersion: '0042_test',
        busAdapter: 'durable-sqlite',
      });
      const ctx: ScheduledTaskRunContext = {
        task: fakeTask(),
        run: fakeRun(),
        correlationId: 'corr-1',
        now: () => '2026-05-24T10:00:00.000Z',
        db,
        bus,
        llm: { endpoint: 't', defaultModel: 'd' } as unknown as LlmClient,
        logger: noopLogger(),
      };
      await handler.run(ctx);
      expect(seen).toHaveLength(1);
      const ev = seen[0]!;
      expect(ev.correlationId).toBe('corr-1');
      expect(ev.payload.schemaVersion).toBe('0042_test');
      expect(ev.payload.busAdapter).toBe('durable-sqlite');
      expect(ev.payload.now).toBe('2026-05-24T10:00:00.000Z');
    } finally {
      db.close();
    }
  });

  it('declares a 5-minute defaultSchedule', () => {
    const handler = createHealthcheckHandler({ schemaVersion: null, busAdapter: 'x' });
    expect(handler.kind).toBe('system.healthcheck');
    expect(handler.defaultSchedule).toEqual({ kind: 'interval', intervalMinutes: 5 });
  });
});
