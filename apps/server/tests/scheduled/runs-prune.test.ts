import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/storage/sqlite';
import { createUsersRepo } from '../../src/repos/users-repo';
import { createLayersRepo } from '../../src/repos/layers-repo';
import { createScheduledTasksRepo } from '../../src/scheduled/repo';
import { pruneScheduledTaskRuns } from '../../src/scheduled/built-in/runs-prune';

const isoNow = (d: Date = new Date()): string => d.toISOString();

function mkDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-sched-prune-'));
  return openDatabase(dir);
}

function seedTask(db: Database): string {
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
  const repo = createScheduledTasksRepo(db);
  return repo.insertTask({
    id: crypto.randomUUID(),
    layerId: layer.id,
    slug: 'p',
    kind: 'test.kind',
    name: 'p',
    schedule: { kind: 'interval', intervalMinutes: 1 },
    nextRunAt: isoNow(),
    createdBy: user.id,
    now: isoNow(),
  }).id;
}

function insertRunRow(db: Database, taskId: string, requestedAt: string): void {
  db.query<unknown, [string, string, string]>(
    `INSERT INTO scheduled_task_runs
       (id, task_id, status, attempt, triggered_by, requested_at)
     VALUES (?, ?, 'succeeded', 0, 'schedule', ?)`,
  ).run(crypto.randomUUID(), taskId, requestedAt);
}

function countRuns(db: Database, taskId: string): number {
  return (
    db
      .query<
        { n: number },
        [string]
      >(`SELECT COUNT(*) AS n FROM scheduled_task_runs WHERE task_id = ?`)
      .get(taskId)?.n ?? 0
  );
}

describe('pruneScheduledTaskRuns', () => {
  it('trims the per-task rank cap when every row is age-safe (high-frequency regime)', () => {
    const db = mkDb();
    try {
      const taskId = seedTask(db);
      const recent = new Date('2026-05-24T10:00:00Z');
      // 250 rows all within the same second — all young, but the
      // per-task cap of 200 should trim 50.
      for (let i = 0; i < 250; i += 1) {
        // Vary requested_at by milliseconds so ORDER BY DESC is
        // stable.
        const at = new Date(recent.getTime() - i).toISOString();
        insertRunRow(db, taskId, at);
      }
      expect(countRuns(db, taskId)).toBe(250);
      const deleted = pruneScheduledTaskRuns(db, { keepPerTask: 200, maxAgeDays: 30 }, recent);
      expect(deleted).toBe(50);
      expect(countRuns(db, taskId)).toBe(200);
    } finally {
      db.close();
    }
  });

  it('trims by age cap even when under the per-task rank cap (low-frequency regime)', () => {
    const db = mkDb();
    try {
      const taskId = seedTask(db);
      const now = new Date('2026-05-24T10:00:00Z');
      // 5 rows, all 60 days old → under the rank cap of 200 but
      // past the age cap of 30 days → all should go.
      for (let i = 0; i < 5; i += 1) {
        const at = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000 - i).toISOString();
        insertRunRow(db, taskId, at);
      }
      const deleted = pruneScheduledTaskRuns(db, { keepPerTask: 200, maxAgeDays: 30 }, now);
      expect(deleted).toBe(5);
      expect(countRuns(db, taskId)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('keeps rows that are within both caps and deletes only those failing at least one', () => {
    const db = mkDb();
    try {
      const taskId = seedTask(db);
      const now = new Date('2026-05-24T10:00:00Z');
      // 3 rows young (within both caps), 2 rows old (past age cap).
      for (let i = 0; i < 3; i += 1) {
        insertRunRow(db, taskId, new Date(now.getTime() - i * 1000).toISOString());
      }
      for (let i = 0; i < 2; i += 1) {
        insertRunRow(
          db,
          taskId,
          new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000 - i * 1000).toISOString(),
        );
      }
      const deleted = pruneScheduledTaskRuns(db, { keepPerTask: 200, maxAgeDays: 30 }, now);
      expect(deleted).toBe(2);
      expect(countRuns(db, taskId)).toBe(3);
    } finally {
      db.close();
    }
  });
});
