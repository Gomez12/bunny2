import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../src/storage/sqlite';
import { createUsersRepo } from '../src/repos/users-repo';
import { createLayersRepo } from '../src/repos/layers-repo';
import { createScheduledTasksRepo } from '../src/scheduled/repo';

const now = () => new Date().toISOString();

function mkDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-sched-'));
  return openDatabase(dir);
}

function seedLayerAndUser(db: Database): { userId: string; layerId: string } {
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
  return { userId: user.id, layerId: layer.id };
}

describe('scheduled-tasks-repo', () => {
  it('inserts a cron task and reads it back by id and slug', () => {
    const db = mkDb();
    try {
      const { userId, layerId } = seedLayerAndUser(db);
      const repo = createScheduledTasksRepo(db);
      const created = repo.insertTask({
        id: crypto.randomUUID(),
        layerId,
        slug: 'weekly-digest',
        kind: 'reports.weekly-digest',
        name: 'Weekly digest',
        schedule: { kind: 'cron', cronExpression: '0 7 * * MON', cronTimezone: 'Europe/Amsterdam' },
        nextRunAt: now(),
        createdBy: userId,
        now: now(),
      });
      expect(created.status).toBe('active');
      expect(created.schedule.kind).toBe('cron');
      expect(created.maxAttempts).toBe(3);
      expect(created.attempt).toBe(0);
      expect(created.version).toBe(1);
      expect(created.config).toEqual({});

      expect(repo.getTaskById(created.id)?.slug).toBe('weekly-digest');
      expect(repo.getTaskBySlug(layerId, 'weekly-digest')?.id).toBe(created.id);
    } finally {
      db.close();
    }
  });

  it('inserts an interval task with a non-default retry budget', () => {
    const db = mkDb();
    try {
      const { userId, layerId } = seedLayerAndUser(db);
      const repo = createScheduledTasksRepo(db);
      const created = repo.insertTask({
        id: crypto.randomUUID(),
        layerId,
        slug: 'health-check',
        kind: 'system.healthcheck',
        name: 'Health check',
        schedule: { kind: 'interval', intervalMinutes: 5 },
        maxAttempts: 10,
        backoffBaseMs: 1_000,
        backoffMaxMs: 30_000,
        config: { url: 'https://example.invalid/healthz' },
        nextRunAt: now(),
        createdBy: userId,
        now: now(),
      });
      expect(created.schedule).toEqual({ kind: 'interval', intervalMinutes: 5 });
      expect(created.maxAttempts).toBe(10);
      expect(created.backoffBaseMs).toBe(1_000);
      expect(created.backoffMaxMs).toBe(30_000);
      expect(created.config).toEqual({ url: 'https://example.invalid/healthz' });
    } finally {
      db.close();
    }
  });

  it('rejects a duplicate slug within the same layer', () => {
    const db = mkDb();
    try {
      const { userId, layerId } = seedLayerAndUser(db);
      const repo = createScheduledTasksRepo(db);
      const baseInput = {
        layerId,
        slug: 'sweep',
        kind: 'k',
        name: 'Sweep',
        schedule: { kind: 'interval' as const, intervalMinutes: 10 },
        nextRunAt: now(),
        createdBy: userId,
        now: now(),
      };
      repo.insertTask({ id: crypto.randomUUID(), ...baseInput });
      expect(() => repo.insertTask({ id: crypto.randomUUID(), ...baseInput })).toThrow();
    } finally {
      db.close();
    }
  });

  it('updates schedule + name + bumps the version', () => {
    const db = mkDb();
    try {
      const { userId, layerId } = seedLayerAndUser(db);
      const repo = createScheduledTasksRepo(db);
      const created = repo.insertTask({
        id: crypto.randomUUID(),
        layerId,
        slug: 'tmp',
        kind: 'k',
        name: 'Tmp',
        schedule: { kind: 'interval', intervalMinutes: 60 },
        nextRunAt: now(),
        createdBy: userId,
        now: now(),
      });
      const updated = repo.updateTask(
        created.id,
        {
          name: 'Renamed',
          schedule: { kind: 'cron', cronExpression: '*/15 * * * *', cronTimezone: 'UTC' },
        },
        userId,
        now(),
      );
      expect(updated.name).toBe('Renamed');
      expect(updated.schedule).toEqual({
        kind: 'cron',
        cronExpression: '*/15 * * * *',
        cronTimezone: 'UTC',
      });
      expect(updated.version).toBe(2);
    } finally {
      db.close();
    }
  });

  it('soft-deletes a task and excludes it from active listing', () => {
    const db = mkDb();
    try {
      const { userId, layerId } = seedLayerAndUser(db);
      const repo = createScheduledTasksRepo(db);
      const created = repo.insertTask({
        id: crypto.randomUUID(),
        layerId,
        slug: 'one-shot',
        kind: 'k',
        name: 'one',
        schedule: { kind: 'interval', intervalMinutes: 5 },
        nextRunAt: now(),
        createdBy: userId,
        now: now(),
      });
      repo.softDeleteTask(created.id, userId, now());
      expect(repo.listTasks({ layerId }).map((t) => t.id)).not.toContain(created.id);
      expect(repo.listTasks({ layerId, includeDeleted: true }).map((t) => t.id)).toContain(
        created.id,
      );
      const reloaded = repo.getTaskById(created.id);
      expect(reloaded?.status).toBe('canceled');
      expect(reloaded?.deletedAt).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it('claims a due task exactly once across two attempts', () => {
    const db = mkDb();
    try {
      const { userId, layerId } = seedLayerAndUser(db);
      const repo = createScheduledTasksRepo(db);
      const past = new Date(Date.now() - 60_000).toISOString();
      const t = repo.insertTask({
        id: crypto.randomUUID(),
        layerId,
        slug: 'claim-me',
        kind: 'k',
        name: 'claim me',
        schedule: { kind: 'interval', intervalMinutes: 5 },
        nextRunAt: past,
        createdBy: userId,
        now: now(),
      });
      const lease = 30_000;
      const dueIds = repo.listDueTaskIds(now(), lease, 10);
      expect(dueIds).toContain(t.id);

      const first = repo.claimTask(t.id, 1111, now(), lease);
      expect(first?.task.claimedByPid).toBe(1111);
      // Second concurrent claim before the lease expires must fail.
      const second = repo.claimTask(t.id, 2222, now(), lease);
      expect(second).toBeNull();

      // After releasing the claim, the row is claimable again.
      repo.releaseClaim(t.id, now());
      const third = repo.claimTask(t.id, 3333, now(), lease);
      expect(third?.task.claimedByPid).toBe(3333);
    } finally {
      db.close();
    }
  });

  it('reclaims a row whose lease has expired', () => {
    const db = mkDb();
    try {
      const { userId, layerId } = seedLayerAndUser(db);
      const repo = createScheduledTasksRepo(db);
      const past = new Date(Date.now() - 60_000).toISOString();
      const t = repo.insertTask({
        id: crypto.randomUUID(),
        layerId,
        slug: 'reclaim',
        kind: 'k',
        name: 'reclaim',
        schedule: { kind: 'interval', intervalMinutes: 5 },
        nextRunAt: past,
        createdBy: userId,
        now: now(),
      });
      const lease = 10_000;
      // Stamp an old claim manually so the lease is already expired
      // when we attempt the next claim.
      const oldClaimAt = new Date(Date.now() - 30_000).toISOString();
      db.query<unknown, [string, string]>(
        'UPDATE scheduled_tasks SET claimed_at = ?, claimed_by_pid = 9 WHERE id = ?',
      ).run(oldClaimAt, t.id);
      const claimed = repo.claimTask(t.id, 1234, now(), lease);
      expect(claimed?.task.claimedByPid).toBe(1234);
    } finally {
      db.close();
    }
  });

  it('writes + updates a run row and lists per-task history', () => {
    const db = mkDb();
    try {
      const { userId, layerId } = seedLayerAndUser(db);
      const repo = createScheduledTasksRepo(db);
      const t = repo.insertTask({
        id: crypto.randomUUID(),
        layerId,
        slug: 'with-history',
        kind: 'k',
        name: 'h',
        schedule: { kind: 'interval', intervalMinutes: 5 },
        nextRunAt: now(),
        createdBy: userId,
        now: now(),
      });
      const run = repo.insertRun({
        id: crypto.randomUUID(),
        taskId: t.id,
        status: 'requested',
        attempt: 0,
        triggeredBy: 'schedule',
        requestedAt: now(),
      });
      const started = repo.updateRun(run.id, {
        status: 'started',
        startedAt: now(),
      });
      expect(started.status).toBe('started');
      const finished = repo.updateRun(run.id, {
        status: 'succeeded',
        finishedAt: now(),
        durationMs: 42,
      });
      expect(finished.durationMs).toBe(42);
      const list = repo.listRunsForTask(t.id);
      expect(list.length).toBe(1);
      expect(list[0]?.status).toBe('succeeded');
    } finally {
      db.close();
    }
  });
});
