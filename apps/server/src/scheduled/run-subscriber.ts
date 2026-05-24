import type { Database } from 'bun:sqlite';
import type { BusEvent, MessageBus, Unsubscribe } from '@bunny2/bus';
import type { LlmClient } from '../llm';
import type { ScheduledTask, ScheduledTasksRepo } from './repo';
import { getScheduledTaskHandler, type ScheduledTaskHandlerLogger } from './registry';
import { computeNextRun } from './schedule';
import {
  SKIP_REASON_TO_RUN_STATUS,
  type ScheduledTaskRunFailedPayload,
  type ScheduledTaskRunRequestedPayload,
  type ScheduledTaskRunSkippedPayload,
  type ScheduledTaskRunStartedPayload,
  type ScheduledTaskRunSucceededPayload,
} from './events';

/**
 * Phase 5.3 — run subscriber.
 *
 * Listens on `scheduledtask.run.requested`, resolves the handler by
 * `task.kind`, drives it through `started → succeeded | failed |
 * skipped_no_handler`, owns the retry/backoff math, and re-anchors
 * `next_run_at` after every terminal state. The scheduler tick only
 * publishes; this subscriber does the actual work — split so the
 * tick stays fast (plan §14 "Long-running handler blocks subsequent
 * ticks").
 *
 * The subscriber declares itself `idempotent: true` (plan §4.3
 * decision #8) because the run row is the dedup key: replaying the
 * same `requested` event lands on the same `runId`, and the
 * `updateRun` calls overwrite the same row. The durable bus uses
 * this flag on boot to replay `in_flight` rows past the lease
 * window instead of abandoning them.
 *
 * Error containment: handler throws are caught and routed into the
 * `failed` path; `err.message` is clipped to 500 chars and stored
 * on the run row + bus event; the full stack lands in
 * `console.error` (parity with the connector/enrichment runners).
 * If the handler throws something un-serialisable, `String(err)` is
 * the fallback. The subscriber NEVER lets a handler error bubble to
 * the bus dispatch — that would push the row into the bus DLQ,
 * which is reserved for infrastructure failures rather than
 * application-level handler failures.
 */

const ERROR_MAX_LEN = 500;

export interface RunSubscriberDeps {
  readonly db: Database;
  readonly bus: MessageBus;
  readonly repo: ScheduledTasksRepo;
  readonly llm: LlmClient;
  /** Override for tests; defaults to `new Date()`. */
  readonly clock?: () => Date;
  /** Logger handed to handlers. Default `console`-shaped. */
  readonly logger?: ScheduledTaskHandlerLogger;
}

export interface RunSubscriber {
  /** Subscribes to `scheduledtask.run.requested`. Idempotent. */
  start(): void;
  /** Detaches the subscription. Safe to call multiple times. */
  stop(): void;
}

export function createScheduledRunSubscriber(deps: RunSubscriberDeps): RunSubscriber {
  const clock = deps.clock ?? ((): Date => new Date());
  const logger: ScheduledTaskHandlerLogger = deps.logger ?? defaultLogger();
  let unsubscribe: Unsubscribe | null = null;

  async function onRunRequested(event: BusEvent<ScheduledTaskRunRequestedPayload>): Promise<void> {
    const { taskId, runId } = event.payload;
    const correlationId = event.correlationId ?? '';

    const task = deps.repo.getTaskById(taskId);
    if (task === null) {
      // Task vanished between scheduler tick and subscriber dispatch
      // (e.g. soft-delete raced with the publish). Nothing to do —
      // the run row stays where the scheduler left it; admin can
      // inspect via the runs list.
      return;
    }
    const handler = getScheduledTaskHandler(task.kind);
    if (handler === null) {
      await markSkipped(task, runId, correlationId, 'no_handler');
      return;
    }
    const run = deps.repo.getRunById(runId);
    if (run === null) {
      // Run row missing — same race as above. Silently no-op rather
      // than fabricate a row.
      return;
    }

    const startedAtIso = clock().toISOString();
    deps.repo.updateRun(runId, { status: 'started', startedAt: startedAtIso });
    const startedPayload: ScheduledTaskRunStartedPayload = { taskId: task.id, runId };
    await deps.bus.publish({
      type: 'scheduledtask.run.started',
      payload: startedPayload,
      correlationId,
    });

    const startedMs = Date.parse(startedAtIso);
    try {
      await handler.run({
        task,
        run: { ...run, status: 'started', startedAt: startedAtIso },
        correlationId,
        now: (): string => clock().toISOString(),
        db: deps.db,
        bus: deps.bus,
        llm: deps.llm,
        logger,
      });
      await finishSuccess(task, runId, correlationId, startedMs);
    } catch (err) {
      // Stack to console.error; clipped message to the run row.
      console.error(
        `[scheduled] handler ${task.kind} failed for task=${task.id} run=${runId}:`,
        err,
      );
      await finishFailure(task, runId, correlationId, startedMs, err);
    } finally {
      // Always release the claim so the next tick can re-fire the
      // task on its new `next_run_at`. The retry-backoff branch also
      // mutates `next_run_at`; release-then-re-claim is the safe
      // ordering (a stuck claim_at would block the retry).
      const nowIso = clock().toISOString();
      deps.repo.releaseClaim(task.id, nowIso);
    }
  }

  async function finishSuccess(
    task: ScheduledTask,
    runId: string,
    correlationId: string,
    startedMs: number,
  ): Promise<void> {
    const now = clock();
    const nowIso = now.toISOString();
    const durationMs = Math.max(0, now.getTime() - startedMs);
    deps.repo.updateRun(runId, {
      status: 'succeeded',
      finishedAt: nowIso,
      durationMs,
    });
    deps.repo.setTaskAttempt(task.id, 0, nowIso);
    const nextRunAt = computeNextRun(task.schedule, now).toISOString();
    deps.repo.setTaskNextRunAt(task.id, nextRunAt, nowIso, nowIso);
    const payload: ScheduledTaskRunSucceededPayload = {
      taskId: task.id,
      runId,
      durationMs,
    };
    await deps.bus.publish({
      type: 'scheduledtask.run.succeeded',
      payload,
      correlationId,
    });
  }

  async function finishFailure(
    task: ScheduledTask,
    runId: string,
    correlationId: string,
    startedMs: number,
    err: unknown,
  ): Promise<void> {
    const now = clock();
    const nowIso = now.toISOString();
    const durationMs = Math.max(0, now.getTime() - startedMs);
    const errorMsg = clipErrorMessage(err);
    deps.repo.updateRun(runId, {
      status: 'failed',
      finishedAt: nowIso,
      durationMs,
      error: errorMsg,
    });
    const nextAttempt = task.attempt + 1;
    let willRetry = false;
    let nextRunAt: string | null = null;
    if (nextAttempt < task.maxAttempts) {
      // Retry: backoff = min(max, base * 2^(attempt-1)).
      const backoffMs = Math.min(
        task.backoffMaxMs,
        task.backoffBaseMs * Math.pow(2, nextAttempt - 1),
      );
      const cronOrIntervalNext = computeNextRun(task.schedule, now);
      const backoffNext = new Date(now.getTime() + backoffMs);
      const target =
        cronOrIntervalNext.getTime() > backoffNext.getTime() ? cronOrIntervalNext : backoffNext;
      nextRunAt = target.toISOString();
      deps.repo.setTaskAttempt(task.id, nextAttempt, nowIso);
      deps.repo.setTaskNextRunAt(task.id, nextRunAt, task.lastRunAt, nowIso);
      willRetry = true;
    } else {
      // Exhausted: auto-pause with reason=max_attempts; re-anchor
      // `next_run_at` to the next cron slot so a manual resume picks
      // up the proper cadence rather than firing immediately.
      deps.repo.setTaskAttempt(task.id, nextAttempt, nowIso);
      const cronOrIntervalNext = computeNextRun(task.schedule, now).toISOString();
      deps.repo.setTaskNextRunAt(task.id, cronOrIntervalNext, task.lastRunAt, nowIso);
      // `actorId` on the paused event is null when the runner is the
      // actor — see events.ts.
      deps.repo.setTaskStatus(task.id, 'paused', 'max_attempts', task.updatedBy, nowIso);
      nextRunAt = cronOrIntervalNext;
      willRetry = false;
    }
    const failedPayload: ScheduledTaskRunFailedPayload = {
      taskId: task.id,
      runId,
      error: errorMsg,
      attempt: nextAttempt,
      willRetry,
      nextRunAt,
    };
    await deps.bus.publish({
      type: 'scheduledtask.run.failed',
      payload: failedPayload,
      correlationId,
    });
    if (!willRetry) {
      await deps.bus.publish({
        type: 'scheduledtask.paused',
        payload: {
          taskId: task.id,
          reason: 'max_attempts',
          actorId: null,
        },
        correlationId,
      });
    }
  }

  async function markSkipped(
    task: ScheduledTask,
    runId: string,
    correlationId: string,
    reason: 'no_handler',
  ): Promise<void> {
    const nowIso = clock().toISOString();
    deps.repo.updateRun(runId, {
      status: SKIP_REASON_TO_RUN_STATUS[reason],
      finishedAt: nowIso,
      durationMs: 0,
    });
    // Re-anchor next_run_at so a missing handler does not loop the
    // scheduler tick on the same row. Attempt stays untouched —
    // missing handlers are not a retry-able failure (they reflect a
    // deployment gap, not a transient error).
    const next = computeNextRun(task.schedule, clock()).toISOString();
    deps.repo.setTaskNextRunAt(task.id, next, task.lastRunAt, nowIso);
    deps.repo.releaseClaim(task.id, nowIso);
    const payload: ScheduledTaskRunSkippedPayload = {
      taskId: task.id,
      runId,
      reason,
    };
    await deps.bus.publish({
      type: 'scheduledtask.run.skipped',
      payload,
      correlationId,
    });
  }

  return {
    start(): void {
      if (unsubscribe !== null) return;
      unsubscribe = deps.bus.subscribe<ScheduledTaskRunRequestedPayload>(
        'scheduledtask.run.requested',
        onRunRequested,
        // Plan §4.3 decision #8 — the run row is the dedup key, so
        // replaying a `requested` event on bus boot-recovery is
        // safe (idempotent UPDATEs land on the same row).
        { subscriberKey: 'scheduled.run-subscriber', idempotent: true },
      );
    },
    stop(): void {
      if (unsubscribe !== null) {
        unsubscribe();
        unsubscribe = null;
      }
    },
  };
}

function clipErrorMessage(err: unknown): string {
  let msg: string;
  if (err instanceof Error) {
    msg = err.message;
  } else {
    try {
      msg = String(err);
    } catch {
      msg = 'unknown error';
    }
  }
  if (msg.length > ERROR_MAX_LEN) {
    return msg.slice(0, ERROR_MAX_LEN);
  }
  return msg;
}

function defaultLogger(): ScheduledTaskHandlerLogger {
  return {
    info(msg, fields) {
      if (fields === undefined) console.log(`[scheduled] ${msg}`);
      else console.log(`[scheduled] ${msg}`, fields);
    },
    warn(msg, fields) {
      if (fields === undefined) console.warn(`[scheduled] ${msg}`);
      else console.warn(`[scheduled] ${msg}`, fields);
    },
    error(msg, fields) {
      if (fields === undefined) console.error(`[scheduled] ${msg}`);
      else console.error(`[scheduled] ${msg}`, fields);
    },
  };
}
