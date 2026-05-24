import type { Database } from 'bun:sqlite';
import type {
  ScheduledTaskPauseReason,
  ScheduledTaskRunStatus,
  ScheduledTaskRunTrigger,
  ScheduledTaskSchedule,
  ScheduledTaskStatus,
} from '@bunny2/shared';

/**
 * Phase 5.0 — repository over `scheduled_tasks` + `scheduled_task_runs`.
 *
 * Pure persistence. No cron evaluation, no claim-lease decision, no
 * bus publishing. The scheduler service (phase 5.3) layers those on
 * top of this repo. The HTTP routes (phase 5.4) read/write through
 * it. Tests assert the SQL contract: round-trip CRUD, per-layer
 * uniqueness on `(layer_id, slug)`, the `cron`/`interval` mutex
 * CHECK from `0012_scheduled_tasks.sql`, and the claim/release
 * sequence the scheduler tick will use.
 *
 * One repo, two tables — `scheduled_task_runs` rows always belong
 * to a `scheduled_tasks` row, so splitting them across two repos
 * would only add an indirection. The methods are namespaced so the
 * call sites stay self-documenting (`repo.claimDueTasks(...)`,
 * `repo.insertRun(...)`).
 */

// ---------- task --------------------------------------------------------

export interface ScheduledTask {
  readonly id: string;
  readonly layerId: string;
  readonly slug: string;
  readonly kind: string;
  readonly name: string;
  readonly status: ScheduledTaskStatus;
  readonly pauseReason: ScheduledTaskPauseReason | null;
  readonly schedule: ScheduledTaskSchedule;
  readonly config: Readonly<Record<string, unknown>>;
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly nextRunAt: string;
  readonly lastRunAt: string | null;
  readonly attempt: number;
  readonly claimedAt: string | null;
  readonly claimedByPid: number | null;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly deletedAt: string | null;
  readonly deletedBy: string | null;
}

interface ScheduledTaskRow {
  id: string;
  layer_id: string;
  slug: string;
  kind: string;
  name: string;
  status: ScheduledTaskStatus;
  pause_reason: ScheduledTaskPauseReason | null;
  schedule_kind: 'cron' | 'interval';
  cron_expression: string | null;
  cron_timezone: string | null;
  interval_minutes: number | null;
  config_json: string;
  max_attempts: number;
  backoff_base_ms: number;
  backoff_max_ms: number;
  next_run_at: string;
  last_run_at: string | null;
  attempt: number;
  claimed_at: string | null;
  claimed_by_pid: number | null;
  version: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

const TASK_COLS =
  'id, layer_id, slug, kind, name, status, pause_reason, ' +
  'schedule_kind, cron_expression, cron_timezone, interval_minutes, ' +
  'config_json, max_attempts, backoff_base_ms, backoff_max_ms, ' +
  'next_run_at, last_run_at, attempt, claimed_at, claimed_by_pid, ' +
  'version, created_at, created_by, updated_at, updated_by, ' +
  'deleted_at, deleted_by';

export interface InsertScheduledTaskInput {
  readonly id: string;
  readonly layerId: string;
  readonly slug: string;
  readonly kind: string;
  readonly name: string;
  readonly schedule: ScheduledTaskSchedule;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly maxAttempts?: number;
  readonly backoffBaseMs?: number;
  readonly backoffMaxMs?: number;
  readonly nextRunAt: string;
  readonly createdBy: string;
  readonly now: string;
}

export interface UpdateScheduledTaskPatch {
  readonly name?: string;
  readonly schedule?: ScheduledTaskSchedule;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly maxAttempts?: number;
  readonly backoffBaseMs?: number;
  readonly backoffMaxMs?: number;
  /**
   * Set by the runner after computing the next firing time, OR by
   * the HTTP edit route when the schedule changes (in which case
   * the route recomputes it server-side).
   */
  readonly nextRunAt?: string;
}

export type ScheduledTaskListFilter = Readonly<{
  layerId?: string;
  kind?: string;
  status?: ScheduledTaskStatus;
  includeDeleted?: boolean;
}>;

/**
 * Claim attempt result. `taken` is the row the caller now owns and
 * must drive through `releaseClaim` or `markRunFinished`; `null`
 * means another worker beat us to it (race lost; nothing to do).
 */
export interface ClaimAttempt {
  readonly task: ScheduledTask;
  readonly nowOwnedByPid: number;
}

// ---------- run ---------------------------------------------------------

export interface ScheduledTaskRun {
  readonly id: string;
  readonly taskId: string;
  readonly status: ScheduledTaskRunStatus;
  readonly attempt: number;
  readonly triggeredBy: ScheduledTaskRunTrigger;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly error: string | null;
  readonly correlationId: string | null;
}

interface ScheduledTaskRunRow {
  id: string;
  task_id: string;
  status: ScheduledTaskRunStatus;
  attempt: number;
  triggered_by: ScheduledTaskRunTrigger;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  error: string | null;
  correlation_id: string | null;
}

const RUN_COLS =
  'id, task_id, status, attempt, triggered_by, ' +
  'requested_at, started_at, finished_at, duration_ms, error, correlation_id';

export interface InsertScheduledTaskRunInput {
  readonly id: string;
  readonly taskId: string;
  readonly status: ScheduledTaskRunStatus;
  readonly attempt: number;
  readonly triggeredBy: ScheduledTaskRunTrigger;
  readonly requestedAt: string;
  readonly correlationId?: string | null;
}

export interface UpdateScheduledTaskRunPatch {
  readonly status?: ScheduledTaskRunStatus;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly durationMs?: number | null;
  readonly error?: string | null;
}

// ---------- repo --------------------------------------------------------

export interface ScheduledTasksRepo {
  insertTask(input: InsertScheduledTaskInput): ScheduledTask;
  getTaskById(id: string): ScheduledTask | null;
  getTaskBySlug(layerId: string, slug: string): ScheduledTask | null;
  listTasks(filter?: ScheduledTaskListFilter): ScheduledTask[];
  updateTask(
    id: string,
    patch: UpdateScheduledTaskPatch,
    updatedBy: string,
    now: string,
  ): ScheduledTask;
  setTaskStatus(
    id: string,
    status: ScheduledTaskStatus,
    pauseReason: ScheduledTaskPauseReason | null,
    updatedBy: string,
    now: string,
  ): ScheduledTask;
  setTaskAttempt(id: string, attempt: number, now: string): ScheduledTask;
  setTaskNextRunAt(
    id: string,
    nextRunAt: string,
    lastRunAt: string | null,
    now: string,
  ): ScheduledTask;
  softDeleteTask(id: string, deletedBy: string, now: string): void;

  /**
   * Atomic single-task claim used by the scheduler tick. Returns
   * the claimed row, OR `null` if (a) the row no longer matches
   * the due/active predicate, (b) another worker already holds an
   * unexpired lease. The caller passes its `pid` so logs show who
   * holds the claim.
   */
  claimTask(id: string, pid: number, now: string, leaseMs: number): ClaimAttempt | null;

  /**
   * Set of due rows the scheduler should attempt to claim on the
   * next tick. Cheap indexed read against `idx_scheduled_tasks_due`.
   */
  listDueTaskIds(now: string, leaseMs: number, limit: number): readonly string[];

  /** Clears `claimed_at` / `claimed_by_pid`. Called after run finalisation. */
  releaseClaim(id: string, now: string): void;

  insertRun(input: InsertScheduledTaskRunInput): ScheduledTaskRun;
  getRunById(id: string): ScheduledTaskRun | null;
  updateRun(id: string, patch: UpdateScheduledTaskRunPatch): ScheduledTaskRun;
  listRunsForTask(taskId: string, limit?: number): ScheduledTaskRun[];
}

function rowToTask(row: ScheduledTaskRow): ScheduledTask {
  return {
    id: row.id,
    layerId: row.layer_id,
    slug: row.slug,
    kind: row.kind,
    name: row.name,
    status: row.status,
    pauseReason: row.pause_reason,
    schedule: rowToSchedule(row),
    config: parseConfig(row.config_json, row.id),
    maxAttempts: row.max_attempts,
    backoffBaseMs: row.backoff_base_ms,
    backoffMaxMs: row.backoff_max_ms,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    attempt: row.attempt,
    claimedAt: row.claimed_at,
    claimedByPid: row.claimed_by_pid,
    version: row.version,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
  };
}

function rowToSchedule(row: ScheduledTaskRow): ScheduledTaskSchedule {
  if (row.schedule_kind === 'cron') {
    if (row.cron_expression === null || row.cron_timezone === null) {
      throw new Error(
        `scheduled-tasks-repo: cron row ${row.id} missing cron_expression or cron_timezone`,
      );
    }
    return {
      kind: 'cron',
      cronExpression: row.cron_expression,
      cronTimezone: row.cron_timezone,
    };
  }
  if (row.interval_minutes === null) {
    throw new Error(`scheduled-tasks-repo: interval row ${row.id} missing interval_minutes`);
  }
  return { kind: 'interval', intervalMinutes: row.interval_minutes };
}

function parseConfig(json: string, taskId: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `scheduled-tasks-repo: invalid config_json on task ${taskId}: ${(err as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`scheduled-tasks-repo: config_json on task ${taskId} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function scheduleColumns(schedule: ScheduledTaskSchedule): {
  cronExpression: string | null;
  cronTimezone: string | null;
  intervalMinutes: number | null;
} {
  if (schedule.kind === 'cron') {
    return {
      cronExpression: schedule.cronExpression,
      cronTimezone: schedule.cronTimezone,
      intervalMinutes: null,
    };
  }
  return { cronExpression: null, cronTimezone: null, intervalMinutes: schedule.intervalMinutes };
}

function rowToRun(row: ScheduledTaskRunRow): ScheduledTaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    status: row.status,
    attempt: row.attempt,
    triggeredBy: row.triggered_by,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    error: row.error,
    correlationId: row.correlation_id,
  };
}

export function createScheduledTasksRepo(db: Database): ScheduledTasksRepo {
  const findById = db.query<ScheduledTaskRow, [string]>(
    `SELECT ${TASK_COLS} FROM scheduled_tasks WHERE id = ?`,
  );

  const findBySlug = db.query<ScheduledTaskRow, [string, string]>(
    `SELECT ${TASK_COLS} FROM scheduled_tasks WHERE layer_id = ? AND slug = ?`,
  );

  const insert = db.query<
    unknown,
    [
      string,
      string,
      string,
      string,
      string,
      ScheduledTaskStatus,
      'cron' | 'interval',
      string | null,
      string | null,
      number | null,
      string,
      number,
      number,
      number,
      string,
      string,
      string,
      string,
      string,
    ]
  >(
    `INSERT INTO scheduled_tasks
       (id, layer_id, slug, kind, name, status,
        schedule_kind, cron_expression, cron_timezone, interval_minutes,
        config_json, max_attempts, backoff_base_ms, backoff_max_ms,
        next_run_at, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const softDelete = db.query<unknown, [string, string, string, string]>(
    `UPDATE scheduled_tasks
        SET deleted_at = ?, deleted_by = ?, status = 'canceled',
            updated_at = ?, version = version + 1
      WHERE id = ? AND deleted_at IS NULL`,
  );

  const releaseClaim = db.query<unknown, [string, string]>(
    `UPDATE scheduled_tasks
        SET claimed_at = NULL, claimed_by_pid = NULL,
            updated_at = ?
      WHERE id = ?`,
  );

  const claim = db.query<unknown, [string, number, string, string, string, string]>(
    `UPDATE scheduled_tasks
        SET claimed_at = ?, claimed_by_pid = ?,
            updated_at = ?
      WHERE id = ?
        AND status = 'active'
        AND deleted_at IS NULL
        AND next_run_at <= ?
        AND (claimed_at IS NULL OR claimed_at < ?)`,
  );

  // Hot-path due-id query — does NOT load full rows. Selects ids
  // the tick will then try to `claim()` one by one. Loading full
  // rows here would waste IO on rows another worker will steal.
  const listDue = db.query<{ id: string }, [string, string, number]>(
    `SELECT id FROM scheduled_tasks
       WHERE status = 'active'
         AND deleted_at IS NULL
         AND next_run_at <= ?
         AND (claimed_at IS NULL OR claimed_at < ?)
       ORDER BY next_run_at ASC
       LIMIT ?`,
  );

  const setAttempt = db.query<unknown, [number, string, string]>(
    `UPDATE scheduled_tasks
        SET attempt = ?, updated_at = ?, version = version + 1
      WHERE id = ?`,
  );

  const setNextRunAt = db.query<unknown, [string, string | null, string, string]>(
    `UPDATE scheduled_tasks
        SET next_run_at = ?, last_run_at = ?, updated_at = ?,
            version = version + 1
      WHERE id = ?`,
  );

  const setStatus = db.query<
    unknown,
    [ScheduledTaskStatus, ScheduledTaskPauseReason | null, string, string, string]
  >(
    `UPDATE scheduled_tasks
        SET status = ?, pause_reason = ?, updated_by = ?,
            updated_at = ?, version = version + 1
      WHERE id = ? AND deleted_at IS NULL`,
  );

  const findRunById = db.query<ScheduledTaskRunRow, [string]>(
    `SELECT ${RUN_COLS} FROM scheduled_task_runs WHERE id = ?`,
  );

  const insertRun = db.query<
    unknown,
    [string, string, ScheduledTaskRunStatus, number, ScheduledTaskRunTrigger, string, string | null]
  >(
    `INSERT INTO scheduled_task_runs
       (id, task_id, status, attempt, triggered_by, requested_at, correlation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  return {
    insertTask(input) {
      const cols = scheduleColumns(input.schedule);
      const configJson = JSON.stringify(input.config ?? {});
      insert.run(
        input.id,
        input.layerId,
        input.slug,
        input.kind,
        input.name,
        'active',
        input.schedule.kind,
        cols.cronExpression,
        cols.cronTimezone,
        cols.intervalMinutes,
        configJson,
        input.maxAttempts ?? 3,
        input.backoffBaseMs ?? 60_000,
        input.backoffMaxMs ?? 3_600_000,
        input.nextRunAt,
        input.now,
        input.createdBy,
        input.now,
        input.createdBy,
      );
      const row = findById.get(input.id);
      if (row === null) {
        throw new Error(`scheduled-tasks-repo: failed to read back task ${input.id} after insert`);
      }
      return rowToTask(row);
    },

    getTaskById(id) {
      const row = findById.get(id);
      return row === null ? null : rowToTask(row);
    },

    getTaskBySlug(layerId, slug) {
      const row = findBySlug.get(layerId, slug);
      return row === null ? null : rowToTask(row);
    },

    listTasks(filter = {}) {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (filter.includeDeleted !== true) where.push('deleted_at IS NULL');
      if (filter.layerId !== undefined) {
        where.push('layer_id = ?');
        params.push(filter.layerId);
      }
      if (filter.kind !== undefined) {
        where.push('kind = ?');
        params.push(filter.kind);
      }
      if (filter.status !== undefined) {
        where.push('status = ?');
        params.push(filter.status);
      }
      const whereSql = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;
      const sql = `SELECT ${TASK_COLS} FROM scheduled_tasks${whereSql} ORDER BY slug`;
      const stmt = db.query<ScheduledTaskRow, typeof params>(sql);
      return stmt.all(...params).map(rowToTask);
    },

    updateTask(id, patch, updatedBy, now) {
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      if (patch.name !== undefined) {
        sets.push('name = ?');
        params.push(patch.name);
      }
      if (patch.schedule !== undefined) {
        const cols = scheduleColumns(patch.schedule);
        sets.push('schedule_kind = ?');
        params.push(patch.schedule.kind);
        sets.push('cron_expression = ?');
        params.push(cols.cronExpression);
        sets.push('cron_timezone = ?');
        params.push(cols.cronTimezone);
        sets.push('interval_minutes = ?');
        params.push(cols.intervalMinutes);
      }
      if (patch.config !== undefined) {
        sets.push('config_json = ?');
        params.push(JSON.stringify(patch.config));
      }
      if (patch.maxAttempts !== undefined) {
        sets.push('max_attempts = ?');
        params.push(patch.maxAttempts);
      }
      if (patch.backoffBaseMs !== undefined) {
        sets.push('backoff_base_ms = ?');
        params.push(patch.backoffBaseMs);
      }
      if (patch.backoffMaxMs !== undefined) {
        sets.push('backoff_max_ms = ?');
        params.push(patch.backoffMaxMs);
      }
      if (patch.nextRunAt !== undefined) {
        sets.push('next_run_at = ?');
        params.push(patch.nextRunAt);
      }
      if (sets.length === 0) {
        const existing = findById.get(id);
        if (existing === null) {
          throw new Error(`scheduled-tasks-repo: task ${id} not found`);
        }
        return rowToTask(existing);
      }
      sets.push('updated_by = ?');
      params.push(updatedBy);
      sets.push('updated_at = ?');
      params.push(now);
      sets.push('version = version + 1');
      const sql = `UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`;
      params.push(id);
      db.query<unknown, typeof params>(sql).run(...params);
      const row = findById.get(id);
      if (row === null) {
        throw new Error(`scheduled-tasks-repo: task ${id} not found after update`);
      }
      return rowToTask(row);
    },

    setTaskStatus(id, status, pauseReason, updatedBy, now) {
      setStatus.run(status, pauseReason, updatedBy, now, id);
      const row = findById.get(id);
      if (row === null) {
        throw new Error(`scheduled-tasks-repo: task ${id} not found after setTaskStatus`);
      }
      return rowToTask(row);
    },

    setTaskAttempt(id, attempt, now) {
      setAttempt.run(attempt, now, id);
      const row = findById.get(id);
      if (row === null) {
        throw new Error(`scheduled-tasks-repo: task ${id} not found after setTaskAttempt`);
      }
      return rowToTask(row);
    },

    setTaskNextRunAt(id, nextRunAt, lastRunAt, now) {
      setNextRunAt.run(nextRunAt, lastRunAt, now, id);
      const row = findById.get(id);
      if (row === null) {
        throw new Error(`scheduled-tasks-repo: task ${id} not found after setTaskNextRunAt`);
      }
      return rowToTask(row);
    },

    softDeleteTask(id, deletedBy, now) {
      softDelete.run(now, deletedBy, now, id);
    },

    claimTask(id, pid, now, leaseMs) {
      const leaseCutoff = new Date(Date.parse(now) - leaseMs).toISOString();
      const res = claim.run(now, pid, now, id, now, leaseCutoff);
      if (res.changes === 0) return null;
      const row = findById.get(id);
      if (row === null) {
        // Race: row deleted between claim UPDATE and read. Treat as
        // lost claim — the caller will just skip this tick.
        return null;
      }
      return { task: rowToTask(row), nowOwnedByPid: pid };
    },

    listDueTaskIds(now, leaseMs, limit) {
      const leaseCutoff = new Date(Date.parse(now) - leaseMs).toISOString();
      return listDue.all(now, leaseCutoff, limit).map((r) => r.id);
    },

    releaseClaim(id, now) {
      releaseClaim.run(now, id);
    },

    insertRun(input) {
      insertRun.run(
        input.id,
        input.taskId,
        input.status,
        input.attempt,
        input.triggeredBy,
        input.requestedAt,
        input.correlationId ?? null,
      );
      const row = findRunById.get(input.id);
      if (row === null) {
        throw new Error(`scheduled-tasks-repo: failed to read back run ${input.id} after insert`);
      }
      return rowToRun(row);
    },

    getRunById(id) {
      const row = findRunById.get(id);
      return row === null ? null : rowToRun(row);
    },

    updateRun(id, patch) {
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      if (patch.status !== undefined) {
        sets.push('status = ?');
        params.push(patch.status);
      }
      if (patch.startedAt !== undefined) {
        sets.push('started_at = ?');
        params.push(patch.startedAt);
      }
      if (patch.finishedAt !== undefined) {
        sets.push('finished_at = ?');
        params.push(patch.finishedAt);
      }
      if (patch.durationMs !== undefined) {
        sets.push('duration_ms = ?');
        params.push(patch.durationMs);
      }
      if (patch.error !== undefined) {
        sets.push('error = ?');
        params.push(patch.error);
      }
      if (sets.length === 0) {
        const existing = findRunById.get(id);
        if (existing === null) {
          throw new Error(`scheduled-tasks-repo: run ${id} not found`);
        }
        return rowToRun(existing);
      }
      const sql = `UPDATE scheduled_task_runs SET ${sets.join(', ')} WHERE id = ?`;
      params.push(id);
      db.query<unknown, typeof params>(sql).run(...params);
      const row = findRunById.get(id);
      if (row === null) {
        throw new Error(`scheduled-tasks-repo: run ${id} not found after update`);
      }
      return rowToRun(row);
    },

    listRunsForTask(taskId, limit = 50) {
      const sql = `SELECT ${RUN_COLS} FROM scheduled_task_runs
                   WHERE task_id = ?
                   ORDER BY requested_at DESC
                   LIMIT ?`;
      return db.query<ScheduledTaskRunRow, [string, number]>(sql).all(taskId, limit).map(rowToRun);
    },
  };
}
