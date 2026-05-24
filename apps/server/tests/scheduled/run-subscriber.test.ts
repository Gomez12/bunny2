import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import type { BusEvent, MessageBus, SubscribeOptions } from '@bunny2/bus';
import { openDatabase } from '../../src/storage/sqlite';
import { createUsersRepo } from '../../src/repos/users-repo';
import { createLayersRepo } from '../../src/repos/layers-repo';
import { createScheduledTasksRepo } from '../../src/scheduled/repo';
import {
  __resetScheduledTaskRegistryForTests,
  registerScheduledTaskHandler,
  type ScheduledTaskHandler,
} from '../../src/scheduled/registry';
import { createScheduledRunSubscriber } from '../../src/scheduled/run-subscriber';
import type {
  ScheduledTaskRunFailedPayload,
  ScheduledTaskRunSkippedPayload,
  ScheduledTaskRunSucceededPayload,
} from '../../src/scheduled/events';
import type { LlmClient } from '../../src/llm';

const isoNow = (d: Date = new Date()): string => d.toISOString();

function mkDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-sched-sub-'));
  return openDatabase(dir);
}

function fakeLlm(): LlmClient {
  return {
    endpoint: 'test://noop',
    defaultModel: 'noop',
    async chat() {
      throw new Error('llm not used in this test');
    },
  } as unknown as LlmClient;
}

function seed(db: Database): { userId: string; layerId: string } {
  const user = createUsersRepo(db).createUser({
    id: crypto.randomUUID(),
    username: 'admin',
    displayName: 'Admin',
    passwordHash: 'h',
    mustChangePassword: false,
    now: isoNow(),
  });
  const layer = createLayersRepo(db).insertLayer({
    id: crypto.randomUUID(),
    type: 'everyone',
    slug: 'everyone',
    name: 'Everyone',
    now: isoNow(),
  });
  return { userId: user.id, layerId: layer.id };
}

function insertTask(
  db: Database,
  layerId: string,
  userId: string,
  opts: {
    kind: string;
    slug: string;
    intervalMinutes?: number;
    maxAttempts?: number;
    backoffBaseMs?: number;
    backoffMaxMs?: number;
  },
): string {
  const repo = createScheduledTasksRepo(db);
  const created = repo.insertTask({
    id: crypto.randomUUID(),
    layerId,
    slug: opts.slug,
    kind: opts.kind,
    name: opts.slug,
    schedule: { kind: 'interval', intervalMinutes: opts.intervalMinutes ?? 5 },
    maxAttempts: opts.maxAttempts ?? 3,
    backoffBaseMs: opts.backoffBaseMs ?? 60_000,
    backoffMaxMs: opts.backoffMaxMs ?? 3_600_000,
    nextRunAt: isoNow(),
    createdBy: userId,
    now: isoNow(),
  });
  return created.id;
}

interface PublishedRun {
  readonly type: string;
  readonly payload: unknown;
}

async function requestRun(
  db: Database,
  bus: MessageBus,
  taskId: string,
  attempt: number,
): Promise<{ runId: string; correlationId: string }> {
  const repo = createScheduledTasksRepo(db);
  const task = repo.getTaskById(taskId);
  if (task === null) throw new Error('task missing');
  const runId = crypto.randomUUID();
  const correlationId = crypto.randomUUID();
  repo.insertRun({
    id: runId,
    taskId,
    status: 'requested',
    attempt,
    triggeredBy: 'schedule',
    requestedAt: isoNow(),
    correlationId,
  });
  await bus.publish({
    type: 'scheduledtask.run.requested',
    payload: {
      taskId,
      runId,
      kind: task.kind,
      layerId: task.layerId,
      triggeredBy: 'schedule',
      attempt,
    },
    correlationId,
  });
  // Yield until handler chain has settled. With InMemoryMessageBus the
  // publish awaits the dispatch directly, so a single microtask flush
  // is enough.
  await Promise.resolve();
  return { runId, correlationId };
}

describe('scheduled run subscriber', () => {
  afterEach(() => {
    __resetScheduledTaskRegistryForTests();
  });

  it('drives success path: started → succeeded, attempt reset to 0, next_run_at re-anchored', async () => {
    const db = mkDb();
    try {
      const { userId, layerId } = seed(db);
      let ran = 0;
      const handler: ScheduledTaskHandler = {
        kind: 'test.ok',
        async run() {
          ran += 1;
        },
      };
      registerScheduledTaskHandler(handler);
      const taskId = insertTask(db, layerId, userId, { kind: 'test.ok', slug: 'ok' });
      const bus = new InMemoryMessageBus();
      const seen: PublishedRun[] = [];
      for (const t of [
        'scheduledtask.run.started',
        'scheduledtask.run.succeeded',
        'scheduledtask.run.failed',
        'scheduledtask.run.skipped',
      ]) {
        bus.subscribe(t, (e) => {
          seen.push({ type: e.type, payload: e.payload });
        });
      }
      const repo = createScheduledTasksRepo(db);
      const sub = createScheduledRunSubscriber({ db, bus, repo, llm: fakeLlm() });
      sub.start();
      const { runId } = await requestRun(db, bus, taskId, 1);
      expect(ran).toBe(1);
      const run = repo.getRunById(runId);
      expect(run?.status).toBe('succeeded');
      expect(run?.durationMs).not.toBeNull();
      const task = repo.getTaskById(taskId);
      expect(task?.attempt).toBe(0);
      const succeeded = seen.find((s) => s.type === 'scheduledtask.run.succeeded');
      expect(succeeded).toBeDefined();
      const succeededPayload = succeeded?.payload as ScheduledTaskRunSucceededPayload;
      expect(succeededPayload.taskId).toBe(taskId);
    } finally {
      db.close();
    }
  });

  it('on throw: increments attempt, publishes failed with willRetry=true, schedules backoff', async () => {
    const db = mkDb();
    try {
      const { userId, layerId } = seed(db);
      registerScheduledTaskHandler({
        kind: 'test.fail',
        async run() {
          throw new Error('boom');
        },
      });
      const taskId = insertTask(db, layerId, userId, {
        kind: 'test.fail',
        slug: 'fail',
        maxAttempts: 3,
        backoffBaseMs: 60_000,
        backoffMaxMs: 3_600_000,
        intervalMinutes: 5,
      });
      const bus = new InMemoryMessageBus();
      const failed: BusEvent<ScheduledTaskRunFailedPayload>[] = [];
      bus.subscribe<ScheduledTaskRunFailedPayload>('scheduledtask.run.failed', (e) => {
        failed.push(e);
      });
      const repo = createScheduledTasksRepo(db);
      const sub = createScheduledRunSubscriber({ db, bus, repo, llm: fakeLlm() });
      sub.start();
      const beforeMs = Date.now();
      const { runId } = await requestRun(db, bus, taskId, 1);
      const run = repo.getRunById(runId);
      expect(run?.status).toBe('failed');
      expect(run?.error).toBe('boom');
      const task = repo.getTaskById(taskId);
      expect(task?.attempt).toBe(1);
      expect(task?.status).toBe('active');
      const ev = failed[0];
      expect(ev?.payload.willRetry).toBe(true);
      expect(ev?.payload.attempt).toBe(1);
      // Backoff math: attempt 1 → base * 2^0 = 60s. The cron/interval
      // next is now+5min, which exceeds backoff, so next_run_at lands
      // about 5min from `beforeMs`.
      const nextMs = Date.parse(task?.nextRunAt ?? '');
      expect(nextMs - beforeMs).toBeGreaterThanOrEqual(60_000);
      expect(nextMs - beforeMs).toBeLessThan(10 * 60_000);
    } finally {
      db.close();
    }
  });

  it('past maxAttempts → status=paused with reason=max_attempts, willRetry=false', async () => {
    const db = mkDb();
    try {
      const { userId, layerId } = seed(db);
      registerScheduledTaskHandler({
        kind: 'test.fatal',
        async run() {
          throw new Error('always-fails');
        },
      });
      // maxAttempts=1 means the very first failure exhausts the budget.
      const taskId = insertTask(db, layerId, userId, {
        kind: 'test.fatal',
        slug: 'fatal',
        maxAttempts: 1,
      });
      const bus = new InMemoryMessageBus();
      const failed: BusEvent<ScheduledTaskRunFailedPayload>[] = [];
      bus.subscribe<ScheduledTaskRunFailedPayload>('scheduledtask.run.failed', (e) => {
        failed.push(e);
      });
      const repo = createScheduledTasksRepo(db);
      const sub = createScheduledRunSubscriber({ db, bus, repo, llm: fakeLlm() });
      sub.start();
      await requestRun(db, bus, taskId, 1);
      const task = repo.getTaskById(taskId);
      expect(task?.status).toBe('paused');
      expect(task?.pauseReason).toBe('max_attempts');
      expect(failed[0]?.payload.willRetry).toBe(false);
    } finally {
      db.close();
    }
  });

  it('missing handler → run row gets skipped_no_handler and skipped event fires', async () => {
    const db = mkDb();
    try {
      const { userId, layerId } = seed(db);
      const taskId = insertTask(db, layerId, userId, { kind: 'unregistered.kind', slug: 'ghost' });
      const bus = new InMemoryMessageBus();
      const skipped: BusEvent<ScheduledTaskRunSkippedPayload>[] = [];
      bus.subscribe<ScheduledTaskRunSkippedPayload>('scheduledtask.run.skipped', (e) => {
        skipped.push(e);
      });
      const repo = createScheduledTasksRepo(db);
      const sub = createScheduledRunSubscriber({ db, bus, repo, llm: fakeLlm() });
      sub.start();
      const { runId } = await requestRun(db, bus, taskId, 1);
      const run = repo.getRunById(runId);
      expect(run?.status).toBe('skipped_no_handler');
      expect(skipped[0]?.payload.reason).toBe('no_handler');
    } finally {
      db.close();
    }
  });

  it('subscribes with idempotent=true so the durable adapter can replay in-flight rows', () => {
    const db = mkDb();
    try {
      const observed: { type: string; options: SubscribeOptions | undefined }[] = [];
      const repo = createScheduledTasksRepo(db);
      const fakeBus: MessageBus = {
        async publish(input) {
          return {
            id: crypto.randomUUID(),
            type: input.type,
            occurredAt: isoNow(),
            payload: input.payload,
          };
        },
        subscribe(type, _handler, options) {
          observed.push({ type, options });
          return () => undefined;
        },
      };
      const sub = createScheduledRunSubscriber({ db, bus: fakeBus, repo, llm: fakeLlm() });
      sub.start();
      const subscription = observed[0];
      expect(subscription?.type).toBe('scheduledtask.run.requested');
      expect(subscription?.options?.idempotent).toBe(true);
      expect(subscription?.options?.subscriberKey).toBe('scheduled.run-subscriber');
    } finally {
      db.close();
    }
  });
});
