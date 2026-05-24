/**
 * Phase 5.3 — scheduled-tasks module barrel + boot-time handler
 * registration.
 *
 * Importing this module side-effect-registers the built-in handlers
 * (currently just `scheduled.runs.prune`). New built-in handlers
 * should be added to the `BUILT_IN_HANDLERS` array — it stays
 * append-only so a stray double-registration cannot land.
 */

import {
  registerScheduledTaskHandler,
  type ScheduledTaskHandler,
  getScheduledTaskHandler,
} from './registry';
import { scheduledRunsPruneHandler } from './built-in/runs-prune';

const BUILT_IN_HANDLERS: readonly ScheduledTaskHandler[] = [scheduledRunsPruneHandler];

/**
 * Idempotent registration of every built-in handler. Safe to call
 * multiple times in production wiring (it skips kinds already
 * present in the registry) and from tests after a registry reset.
 * Production callers should invoke this once at boot, before
 * `scheduler.start()` and `runSubscriber.start()`.
 */
export function registerBuiltInScheduledTaskHandlers(): void {
  for (const handler of BUILT_IN_HANDLERS) {
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
} from './built-in/runs-prune';
