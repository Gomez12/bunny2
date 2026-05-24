/**
 * Phase 5.3 — `scheduledtask.*` event taxonomy.
 *
 * Same shape as `entities/events.ts`: a closed const-tuple of event
 * type strings plus one typed payload interface per row. The plan
 * §7 table is the source of truth; this file is the runtime
 * registration that prevents a new event from being published
 * without also being acknowledged here.
 *
 * Anti-leak invariants (mirroring the same section of the plan):
 *  - `error` carries the handler's `err.message` only — no stack,
 *    no payload echo. Stacks land in `console.error` from the
 *    run subscriber.
 *  - `config_json` from the task row is NEVER echoed in any of
 *    these payloads. Handlers that need secrets must read from
 *    `layer_attachments` or env.
 *  - Run events carry `correlationId` so the LLM call log and the
 *    `events` table can be joined for any handler that calls an
 *    LLM. The scheduler tick mints the correlation id; the
 *    subscriber forwards it on `started` / `succeeded` / `failed`.
 *
 * Phase 5.3 does NOT register the `bus.dlq.*` family — that lives
 * in 5.4 next to the admin DLQ routes.
 */

import type {
  ScheduledTaskPauseReason,
  ScheduledTaskRunStatus,
  ScheduledTaskRunTrigger,
  ScheduleKind,
} from '@bunny2/shared';

/**
 * Closed set of event type strings emitted by the scheduled-tasks
 * domain. Tuple type so a stray string typo at a publish site fails
 * type-checking. The CRUD events (`created`, `updated`, `deleted`,
 * `paused`, `resumed`) are wired in 5.4 by the HTTP routes; the
 * `run.*` events are wired in 5.3 by the scheduler tick + the run
 * subscriber.
 */
export const SCHEDULED_TASK_EVENT_TYPES = [
  'scheduledtask.created',
  'scheduledtask.updated',
  'scheduledtask.deleted',
  'scheduledtask.paused',
  'scheduledtask.resumed',
  'scheduledtask.run.requested',
  'scheduledtask.run.started',
  'scheduledtask.run.succeeded',
  'scheduledtask.run.failed',
  'scheduledtask.run.skipped',
] as const;

export type ScheduledTaskEventType = (typeof SCHEDULED_TASK_EVENT_TYPES)[number];

// ---------- CRUD payloads (emitted by 5.4 routes) ----------------------

export interface ScheduledTaskCreatedPayload {
  readonly taskId: string;
  readonly layerId: string;
  readonly kind: string;
  readonly slug: string;
  readonly scheduleKind: ScheduleKind;
  readonly createdBy: string;
}

export interface ScheduledTaskUpdatedPayload {
  readonly taskId: string;
  readonly patch: Readonly<Record<string, unknown>>;
  readonly updatedBy: string;
}

export interface ScheduledTaskDeletedPayload {
  readonly taskId: string;
  readonly slug: string;
  readonly deletedBy: string;
}

export interface ScheduledTaskPausedPayload {
  readonly taskId: string;
  /**
   * `manual` is a user/admin action via the HTTP route; `max_attempts`
   * is the runner auto-pausing after exhausting the retry budget.
   * Mirrors `ScheduledTaskPauseReason` from the shared package.
   */
  readonly reason: ScheduledTaskPauseReason;
  /** `null` when the runner is the actor (max_attempts auto-pause). */
  readonly actorId: string | null;
}

export interface ScheduledTaskResumedPayload {
  readonly taskId: string;
  readonly resumedBy: string;
}

// ---------- run-lifecycle payloads (emitted by 5.3 services) -----------

export interface ScheduledTaskRunRequestedPayload {
  readonly taskId: string;
  readonly runId: string;
  readonly kind: string;
  readonly layerId: string;
  readonly triggeredBy: ScheduledTaskRunTrigger;
  readonly attempt: number;
}

export interface ScheduledTaskRunStartedPayload {
  readonly taskId: string;
  readonly runId: string;
}

export interface ScheduledTaskRunSucceededPayload {
  readonly taskId: string;
  readonly runId: string;
  readonly durationMs: number;
}

export interface ScheduledTaskRunFailedPayload {
  readonly taskId: string;
  readonly runId: string;
  readonly error: string;
  readonly attempt: number;
  readonly willRetry: boolean;
  readonly nextRunAt: string | null;
}

/**
 * `reason` mirrors the `skipped_*` subset of `ScheduledTaskRunStatus`
 * minus the `skipped_` prefix. The `crashed` reason is reserved for
 * the bus-replay path in a later phase; 5.3 emits `offline` (boot
 * recovery) and `no_handler` (missing handler lookup).
 */
export type ScheduledTaskRunSkipReason = 'offline' | 'no_handler' | 'crashed';

export interface ScheduledTaskRunSkippedPayload {
  readonly taskId: string;
  readonly runId: string;
  readonly reason: ScheduledTaskRunSkipReason;
}

/**
 * Map of a skip-payload `reason` to the matching SQL row status. The
 * scheduler and run-subscriber both write the run row AND publish the
 * event; this map keeps the two in lock-step so a future enum
 * extension cannot drift between them.
 */
export const SKIP_REASON_TO_RUN_STATUS: Readonly<
  Record<ScheduledTaskRunSkipReason, ScheduledTaskRunStatus>
> = {
  offline: 'skipped_offline',
  no_handler: 'skipped_no_handler',
  crashed: 'skipped_crashed',
};
