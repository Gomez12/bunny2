import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import type { ScheduledTasksRepo } from './repo';
import { computeNextRun } from './schedule';
import {
  SKIP_REASON_TO_RUN_STATUS,
  type ScheduledTaskRunRequestedPayload,
  type ScheduledTaskRunSkippedPayload,
} from './events';

/**
 * Phase 5.3 — scheduler tick service.
 *
 * The scheduler is the "ask for work" half of the runtime; the run
 * subscriber (see `run-subscriber.ts`) is the "do the work" half. The
 * tick is intentionally tiny: enumerate due rows, claim each one
 * atomically, insert a `requested` run row, publish
 * `scheduledtask.run.requested`. The handler does NOT run inline on
 * the tick — it runs on the bus consumer loop. Plan §14 risk
 * "Long-running handler blocks subsequent ticks" is mitigated by this
 * decoupling.
 *
 * Role gating: per plan §4.1 / §4.3 the tick only runs on
 * `worker` / `all` roles. `web` constructs the scheduler but
 * `start()` no-ops the timer; the same web process still serves
 * `POST .../runs` (manual runs, wired in 5.4) which publishes the
 * same event for the worker to consume.
 *
 * Boot recovery: on `start()` (worker/all only) we walk every active,
 * non-deleted task whose `next_run_at < now - graceWindow` and record
 * a single `skipped_offline` run row per task, re-anchoring
 * `next_run_at` forward to the next cron slot (or `now+interval`).
 * Plan §4.2 last paragraph: "single row per task — we don't replay
 * every missed slot, that would storm the bus after a long outage".
 * Grace window defaults to `5 * leaseMs` per the same paragraph.
 */

export type ProcessRole = 'web' | 'worker' | 'all';

export interface SchedulerDeps {
  readonly db: Database;
  readonly bus: MessageBus;
  readonly repo: ScheduledTasksRepo;
  readonly role: ProcessRole;
  /**
   * Claim lease window. A task whose `claimed_at` is older than
   * `now - leaseMs` is up for grabs again — the previous claimer
   * either crashed or the run subscriber dropped the row on the
   * floor. Default 5 minutes (matches the durable bus default).
   */
  readonly leaseMs?: number;
  /** Tick cadence. Default 30 seconds (plan §4.2 "default 30s"). */
  readonly tickIntervalMs?: number;
  /** Max rows claimed per tick. Default 50. */
  readonly batchLimit?: number;
  /**
   * Multiplier on `leaseMs` defining the boot-recovery grace window:
   * a task with `next_run_at < now - graceMultiplier*leaseMs` is
   * considered "missed during downtime" and gets one
   * `skipped_offline` row. Default 5 (plan §4.2 last paragraph).
   */
  readonly bootRecoveryGraceMultiplier?: number;
  /** PID used for `claimed_by_pid`. Default `process.pid`. */
  readonly pid?: number;
  /** Override for tests; defaults to `new Date()`. */
  readonly clock?: () => Date;
  /** Override for tests; defaults to `crypto.randomUUID`. */
  readonly idFactory?: () => string;
}

export interface Scheduler {
  /**
   * Arms the periodic tick (worker / all only) and runs boot recovery
   * once. Safe to call multiple times; subsequent calls are no-ops.
   * On `web` the tick stays off — the tick is the only thing
   * gated; the run subscriber registers itself on every role from
   * its own `start()`.
   */
  start(): void;
  /** Stops the tick timer. Safe to call multiple times. */
  stop(): void;
  /**
   * Drives a single tick synchronously. Returns the number of
   * `scheduledtask.run.requested` events emitted. Available on every
   * role for test ergonomics; on `web` production wiring nothing
   * calls it (the timer is the only caller).
   */
  tickOnce(): Promise<number>;
}

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_TICK_MS = 30_000;
const DEFAULT_BATCH = 50;
const DEFAULT_GRACE_MULTIPLIER = 5;

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_MS;
  const batchLimit = deps.batchLimit ?? DEFAULT_BATCH;
  const graceMultiplier = deps.bootRecoveryGraceMultiplier ?? DEFAULT_GRACE_MULTIPLIER;
  const pid = deps.pid ?? (typeof process !== 'undefined' ? process.pid : 0);
  const clock = deps.clock ?? ((): Date => new Date());
  const idFactory = deps.idFactory ?? ((): string => crypto.randomUUID());

  let timer: ReturnType<typeof setInterval> | null = null;
  let recoveryDone = false;

  async function tickOnce(): Promise<number> {
    const now = clock();
    const nowIso = now.toISOString();
    const dueIds = deps.repo.listDueTaskIds(nowIso, leaseMs, batchLimit);
    if (dueIds.length === 0) return 0;
    let emitted = 0;
    for (const id of dueIds) {
      const claim = deps.repo.claimTask(id, pid, nowIso, leaseMs);
      if (claim === null) continue; // race lost; another worker owns it
      const task = claim.task;
      const runId = idFactory();
      const correlationId = idFactory();
      const nextAttempt = task.attempt + 1;
      deps.repo.insertRun({
        id: runId,
        taskId: task.id,
        status: 'requested',
        attempt: nextAttempt,
        triggeredBy: 'schedule',
        requestedAt: nowIso,
        correlationId,
      });
      const payload: ScheduledTaskRunRequestedPayload = {
        taskId: task.id,
        runId,
        kind: task.kind,
        layerId: task.layerId,
        triggeredBy: 'schedule',
        attempt: nextAttempt,
      };
      await deps.bus.publish({
        type: 'scheduledtask.run.requested',
        payload,
        correlationId,
      });
      emitted += 1;
    }
    return emitted;
  }

  function runBootRecovery(): void {
    const now = clock();
    const nowIso = now.toISOString();
    const graceMs = graceMultiplier * leaseMs;
    const staleCutoffIso = new Date(now.getTime() - graceMs).toISOString();
    const tasks = deps.repo.listTasks({ status: 'active' });
    for (const task of tasks) {
      if (task.deletedAt !== null) continue;
      if (task.nextRunAt >= staleCutoffIso) continue;
      // Single `skipped_offline` row per task — see file-header doc.
      const runId = idFactory();
      const correlationId = idFactory();
      deps.repo.insertRun({
        id: runId,
        taskId: task.id,
        status: SKIP_REASON_TO_RUN_STATUS.offline,
        attempt: task.attempt,
        triggeredBy: 'schedule',
        requestedAt: nowIso,
        correlationId,
      });
      // Re-anchor forward. `computeNextRun` with `from = now` advances
      // past the missed slot in both cron and interval cases.
      const next = computeNextRun(task.schedule, now, { from: now }).toISOString();
      deps.repo.setTaskNextRunAt(task.id, next, task.lastRunAt, nowIso);
      const payload: ScheduledTaskRunSkippedPayload = {
        taskId: task.id,
        runId,
        reason: 'offline',
      };
      // Fire-and-forget — boot recovery should not block start().
      void deps.bus.publish({
        type: 'scheduledtask.run.skipped',
        payload,
        correlationId,
      });
    }
  }

  return {
    start(): void {
      if (deps.role === 'web') {
        // Tick is gated to background-work roles; the run subscriber
        // is registered separately and lives on every role.
        return;
      }
      if (!recoveryDone) {
        recoveryDone = true;
        runBootRecovery();
      }
      if (timer !== null) return;
      const t = setInterval(() => {
        tickOnce().catch((err: unknown) => {
          // Tick failures are logged but must never crash the loop.
          // Per-task failures are already handled by `tickOnce`
          // (claim races skip silently; publish errors throw here).
          console.error('[scheduler] tick failed:', err);
        });
      }, tickIntervalMs);
      if (typeof (t as { unref?: () => void }).unref === 'function') {
        (t as { unref: () => void }).unref();
      }
      timer = t;
    },

    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },

    tickOnce,
  };
}
