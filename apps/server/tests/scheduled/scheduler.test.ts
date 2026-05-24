import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import type { BusEvent } from '@bunny2/bus';
import { openDatabase } from '../../src/storage/sqlite';
import { createUsersRepo } from '../../src/repos/users-repo';
import { createLayersRepo } from '../../src/repos/layers-repo';
import { createScheduledTasksRepo } from '../../src/scheduled/repo';
import { createScheduler } from '../../src/scheduled/scheduler';
import type {
  ScheduledTaskRunRequestedPayload,
  ScheduledTaskRunSkippedPayload,
} from '../../src/scheduled/events';

const isoNow = (d: Date = new Date()): string => d.toISOString();

function mkDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-sched-svc-'));
  return openDatabase(dir);
}

function seedLayerAndUser(db: Database): { userId: string; layerId: string } {
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

function insertActiveIntervalTask(
  db: Database,
  layerId: string,
  userId: string,
  opts: { slug: string; nextRunAt: string; intervalMinutes?: number },
): string {
  const repo = createScheduledTasksRepo(db);
  const created = repo.insertTask({
    id: crypto.randomUUID(),
    layerId,
    slug: opts.slug,
    kind: 'test.kind',
    name: 'Test task',
    schedule: { kind: 'interval', intervalMinutes: opts.intervalMinutes ?? 1 },
    nextRunAt: opts.nextRunAt,
    createdBy: userId,
    now: isoNow(),
  });
  return created.id;
}

describe('scheduler service', () => {
  it('publishes scheduledtask.run.requested for each due task on tickOnce', async () => {
    const db = mkDb();
    try {
      const { userId, layerId } = seedLayerAndUser(db);
      const past = isoNow(new Date(Date.now() - 60_000));
      insertActiveIntervalTask(db, layerId, userId, { slug: 't1', nextRunAt: past });
      insertActiveIntervalTask(db, layerId, userId, { slug: 't2', nextRunAt: past });
      const repo = createScheduledTasksRepo(db);
      const bus = new InMemoryMessageBus();
      const received: BusEvent<ScheduledTaskRunRequestedPayload>[] = [];
      bus.subscribe<ScheduledTaskRunRequestedPayload>('scheduledtask.run.requested', (e) => {
        received.push(e);
      });
      const scheduler = createScheduler({ db, bus, repo, role: 'worker' });
      const emitted = await scheduler.tickOnce();
      expect(emitted).toBe(2);
      expect(received).toHaveLength(2);
      expect(received.every((e) => e.payload.triggeredBy === 'schedule')).toBe(true);
      // Run rows landed.
      for (const e of received) {
        const run = repo.getRunById(e.payload.runId);
        expect(run?.status).toBe('requested');
        expect(run?.attempt).toBe(1);
      }
    } finally {
      db.close();
    }
  });

  it('claim is single-shot when two ticks race against the same row', async () => {
    const db = mkDb();
    try {
      const { userId, layerId } = seedLayerAndUser(db);
      const past = isoNow(new Date(Date.now() - 60_000));
      insertActiveIntervalTask(db, layerId, userId, { slug: 'race', nextRunAt: past });
      const repo = createScheduledTasksRepo(db);
      const busA = new InMemoryMessageBus();
      const busB = new InMemoryMessageBus();
      const a = createScheduler({ db, bus: busA, repo, role: 'worker', pid: 1 });
      const b = createScheduler({ db, bus: busB, repo, role: 'worker', pid: 2 });
      const [emittedA, emittedB] = await Promise.all([a.tickOnce(), b.tickOnce()]);
      expect(emittedA + emittedB).toBe(1);
    } finally {
      db.close();
    }
  });

  it('boot recovery emits one skipped_offline run per stale task and re-anchors next_run_at', async () => {
    const db = mkDb();
    try {
      const { userId, layerId } = seedLayerAndUser(db);
      const longAgo = isoNow(new Date(Date.now() - 60 * 60 * 1000));
      const taskId = insertActiveIntervalTask(db, layerId, userId, {
        slug: 'stale',
        nextRunAt: longAgo,
        intervalMinutes: 5,
      });
      const repo = createScheduledTasksRepo(db);
      const bus = new InMemoryMessageBus();
      const skippedEvents: BusEvent<ScheduledTaskRunSkippedPayload>[] = [];
      bus.subscribe<ScheduledTaskRunSkippedPayload>('scheduledtask.run.skipped', (e) => {
        skippedEvents.push(e);
      });
      // Use a tight lease so the grace window fires immediately.
      const scheduler = createScheduler({
        db,
        bus,
        repo,
        role: 'worker',
        leaseMs: 1_000,
        bootRecoveryGraceMultiplier: 1,
      });
      scheduler.start();
      // Boot recovery runs synchronously on start(); event publishes
      // are awaited microtasks — yield once.
      await Promise.resolve();
      scheduler.stop();
      // Exactly one skipped row landed for the one stale task.
      const runs = repo.listRunsForTask(taskId);
      const skipped = runs.filter((r) => r.status === 'skipped_offline');
      expect(skipped).toHaveLength(1);
      // next_run_at re-anchored forward, no longer matches the
      // long-ago timestamp.
      const refreshed = repo.getTaskById(taskId);
      expect(refreshed?.nextRunAt).not.toBe(longAgo);
      // And the skipped event fired.
      expect(skippedEvents.some((e) => e.payload.taskId === taskId)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('start() on role=web does not arm the tick or run boot recovery', () => {
    const db = mkDb();
    try {
      const { userId, layerId } = seedLayerAndUser(db);
      const longAgo = isoNow(new Date(Date.now() - 60 * 60 * 1000));
      const taskId = insertActiveIntervalTask(db, layerId, userId, {
        slug: 'web-stale',
        nextRunAt: longAgo,
        intervalMinutes: 5,
      });
      const repo = createScheduledTasksRepo(db);
      const bus = new InMemoryMessageBus();
      const scheduler = createScheduler({
        db,
        bus,
        repo,
        role: 'web',
        leaseMs: 1_000,
        bootRecoveryGraceMultiplier: 1,
      });
      scheduler.start();
      scheduler.stop();
      // No skipped row created — boot recovery skipped on web.
      const runs = repo.listRunsForTask(taskId);
      expect(runs).toHaveLength(0);
      // next_run_at untouched on web.
      expect(repo.getTaskById(taskId)?.nextRunAt).toBe(longAgo);
    } finally {
      db.close();
    }
  });
});
