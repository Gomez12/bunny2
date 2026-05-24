/**
 * Phase 5.3 — scheduled-tasks module barrel + boot-time handler
 * registration.
 *
 * Importing this module does NOT side-effect-register handlers (a
 * boot-time call to `registerBuiltInScheduledTaskHandlers(...)` does
 * that, with the per-handler deps wired in). Resolving handler deps
 * at registration time keeps the registry pure (no module-load
 * side-effects on environment / db) which makes the test reset
 * helpers behave predictably.
 *
 * The built-in set is fixed; non-built-in handlers register
 * themselves from their own domain modules (e.g. a future
 * `reports/weekly-digest.ts` would call `registerScheduledTaskHandler`
 * from its own boot hook).
 *
 * Out-of-scope runners (intentionally NOT seeded as scheduled tasks
 * — plan §4.3 decision #2):
 *  - `connectorRunner`: per-link cadence comes from
 *    `layer_attachments.config`, doesn't fit a single cron/interval.
 *  - `enrichmentRunner`: event-driven (subscribes to entity events),
 *    not time-based. Inherits crash-safety from the durable bus.
 *  - `todoCalendarProjection`: also event-driven. Same story.
 * All three keep their specialised wiring in `index.ts`; the
 * scheduled-tasks UI / registry only surfaces the generic set.
 */

import {
  registerScheduledTaskHandler,
  type ScheduledTaskHandler,
  getScheduledTaskHandler,
} from './registry';
import {
  scheduledRunsPruneHandler,
  createLlmPruneHandler,
  createHealthcheckHandler,
  busOutboxPruneHandler,
} from './built-in';
import type { LlmCallLog } from '../llm';

export interface RegisterBuiltInsDeps {
  /** Sink used by `llm.calls.prune`. */
  readonly llmCallLog: LlmCallLog;
  /** Fallback retention (days) for the LLM prune. Usually `config.llm.retentionDays`. */
  readonly llmRetentionDays: number;
  /** Stamped into `system.healthcheck.tick` payloads. */
  readonly schemaVersion: string | null;
  /** Stamped into `system.healthcheck.tick` payloads. */
  readonly busAdapter: string;
}

/**
 * Idempotent registration of every built-in handler. Safe to call
 * multiple times in production wiring (it skips kinds already
 * present in the registry) and from tests after a registry reset.
 * Production callers should invoke this once at boot, before
 * `scheduler.start()`, `runSubscriber.start()`, and the system-task
 * seed.
 */
export function registerBuiltInScheduledTaskHandlers(deps: RegisterBuiltInsDeps): void {
  const handlers: readonly ScheduledTaskHandler[] = [
    scheduledRunsPruneHandler,
    createLlmPruneHandler({
      llmCallLog: deps.llmCallLog,
      defaultRetentionDays: deps.llmRetentionDays,
    }),
    createHealthcheckHandler({
      schemaVersion: deps.schemaVersion,
      busAdapter: deps.busAdapter,
    }),
    busOutboxPruneHandler,
  ];
  for (const handler of handlers) {
    if (getScheduledTaskHandler(handler.kind) === null) {
      registerScheduledTaskHandler(handler);
    }
  }
}

export { createScheduledTasksRepo } from './repo';
export type {
  ScheduledTasksRepo,
  ScheduledTask,
  ScheduledTaskRun,
  InsertScheduledTaskInput,
  InsertScheduledTaskRunInput,
  UpdateScheduledTaskPatch,
  UpdateScheduledTaskRunPatch,
  ScheduledTaskListFilter,
} from './repo';

export {
  registerScheduledTaskHandler,
  getScheduledTaskHandler,
  listRegisteredScheduledTaskHandlers,
  __resetScheduledTaskRegistryForTests,
} from './registry';
export type {
  ScheduledTaskHandler,
  ScheduledTaskRunContext,
  ScheduledTaskHandlerLogger,
  RegisteredScheduledTaskHandlerInfo,
} from './registry';

export { createScheduler } from './scheduler';
export type { Scheduler, SchedulerDeps, ProcessRole } from './scheduler';

export { createScheduledRunSubscriber } from './run-subscriber';
export type { RunSubscriber, RunSubscriberDeps } from './run-subscriber';

export { computeNextRun } from './schedule';
export type { ComputeNextRunOptions } from './schedule';

export { SCHEDULED_TASK_EVENT_TYPES, SKIP_REASON_TO_RUN_STATUS } from './events';
export type {
  ScheduledTaskEventType,
  ScheduledTaskCreatedPayload,
  ScheduledTaskUpdatedPayload,
  ScheduledTaskDeletedPayload,
  ScheduledTaskPausedPayload,
  ScheduledTaskResumedPayload,
  ScheduledTaskRunRequestedPayload,
  ScheduledTaskRunStartedPayload,
  ScheduledTaskRunSucceededPayload,
  ScheduledTaskRunFailedPayload,
  ScheduledTaskRunSkippedPayload,
  ScheduledTaskRunSkipReason,
} from './events';

export {
  scheduledRunsPruneHandler,
  pruneScheduledTaskRuns,
  SCHEDULED_RUNS_PRUNE_KIND,
  LLM_PRUNE_KIND,
  createLlmPruneHandler,
  SYSTEM_HEALTHCHECK_KIND,
  createHealthcheckHandler,
  BUS_OUTBOX_PRUNE_KIND,
  busOutboxPruneHandler,
  pruneBusOutbox,
} from './built-in';
export type { CreateLlmPruneHandlerDeps, CreateHealthcheckHandlerDeps } from './built-in';

export { seedSystemScheduledTasksIfNeeded, SYSTEM_SCHEDULED_TASKS_SEED_DONE_KEY } from './seed';
export type { SeedSystemScheduledTasksDeps, SeedSystemScheduledTasksResult } from './seed';
