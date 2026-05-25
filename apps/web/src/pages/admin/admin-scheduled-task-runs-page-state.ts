/**
 * Phase 4 (ui-exposure-gaps) — pure view-state for
 * `AdminScheduledTaskRunsPage`.
 *
 * Mirrors `scheduled-tasks-page-state.ts`: branch projection (loading
 * / error / empty / ready) plus the row-level expansion toggle so the
 * "row expanded / collapsed" tests stay DOM-free.
 *
 * The page composes:
 *   - one `listAdminScheduledTaskRuns(taskId)` call for the runs list;
 *   - one `listAdminScheduledTasks()` call for the task title /
 *     `layerSlug` hints — the runs endpoint returns runs only, not the
 *     parent task. Both reads are tolerated independently: the runs
 *     table renders even if the task lookup fails.
 */

import type { AdminScheduledTaskRow, ScheduledTaskRunSummary } from '../../lib/api-types';

export type AdminScheduledTaskRunsInput =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly errorKey: string }
  | {
      readonly status: 'ready';
      readonly runs: readonly ScheduledTaskRunSummary[];
      readonly task: AdminScheduledTaskRow | null;
    };

export type AdminScheduledTaskRunsView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | {
      readonly kind: 'empty';
      readonly task: AdminScheduledTaskRow | null;
    }
  | {
      readonly kind: 'ready';
      readonly runs: readonly ScheduledTaskRunSummary[];
      readonly task: AdminScheduledTaskRow | null;
    };

export function adminScheduledTaskRunsView(
  input: AdminScheduledTaskRunsInput,
): AdminScheduledTaskRunsView {
  if (input.status === 'loading') return { kind: 'loading' };
  if (input.status === 'error') return { kind: 'error', errorKey: input.errorKey };
  if (input.runs.length === 0) return { kind: 'empty', task: input.task };
  return { kind: 'ready', runs: input.runs, task: input.task };
}

/**
 * Toggle helper for the JSON-details expander. Returns a new `Set`
 * (immutable update) so React's reference check fires.
 */
export function toggleExpandedRun(
  expanded: ReadonlySet<string>,
  runId: string,
): ReadonlySet<string> {
  const next = new Set(expanded);
  if (next.has(runId)) next.delete(runId);
  else next.add(runId);
  return next;
}

/**
 * Project a `ScheduledTaskRunSummary` to the JSON payload the details
 * expander renders. Kept here so the test can assert the exact key set
 * we expose to the admin (no PII, no internal IDs the admin can't act
 * on). `correlationId` is included so admins can grep the log file.
 */
export function runDetailsJson(run: ScheduledTaskRunSummary): {
  readonly id: string;
  readonly taskId: string;
  readonly status: string;
  readonly attempt: number;
  readonly triggeredBy: string;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly correlationId: string | null;
  readonly error: string | null;
} {
  return {
    id: run.id,
    taskId: run.taskId,
    status: run.status,
    attempt: run.attempt,
    triggeredBy: run.triggeredBy,
    requestedAt: run.requestedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    correlationId: run.correlationId,
    error: run.error,
  };
}
