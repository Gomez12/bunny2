/**
 * Phase 6.6 — `chat.runs.prune` scheduled-task handler.
 *
 * Retention for the chat pipeline tables. Mirrors the shape of
 * `apps/server/src/scheduled/built-in/runs-prune.ts`:
 *
 *  - A configurable `maxAgeDays` cutoff (default 30) decides how
 *    far back `chat_pipeline_runs` rows survive.
 *  - The pure `pruneChatPipelineRuns(db, opts, now)` function is
 *    exported so ad-hoc maintenance scripts + tests can drive the
 *    same logic without booting the scheduler.
 *  - The handler itself is async, idempotent, and logs the row
 *    count on every run for ops visibility.
 *
 * The 0014 migration does NOT declare `ON DELETE CASCADE` between
 * `chat_pipeline_steps.run_id` and `chat_pipeline_runs.id`, so the
 * prune deletes steps first, then runs, inside one
 * `db.transaction(...)` block. Foreign-key order matters: deleting
 * runs first would either leave orphan steps (FKs off) or violate
 * the constraint (FKs on). The transaction also gives us
 * atomicity — a partial prune mid-crash should not leave the chat
 * pipeline tables in a half-deleted state.
 *
 * Scope:
 *  - Touches `chat_pipeline_runs` + `chat_pipeline_steps` only.
 *  - Does NOT touch `chat_messages`. The thread stays in place even
 *    after the pipeline trace is gone; the UI degrades gracefully
 *    (the per-message Kanban shows the message in `done` / `failed`
 *    state without an expandable pipeline trail).
 *  - Does NOT touch `llm_calls`. That retention is owned by the
 *    phase 5.5 `llm.calls.prune` handler.
 */

import type { Database } from 'bun:sqlite';
import type { ScheduledTaskHandler, ScheduledTaskRunContext } from '../scheduled';

export const CHAT_RUNS_PRUNE_KIND = 'chat.runs.prune';

const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_INTERVAL_MINUTES = 60 * 24;

export interface ChatRunsPruneConfig {
  readonly maxAgeDays: number;
}

export interface ChatRunsPruneResult {
  readonly stepsDeleted: number;
  readonly runsDeleted: number;
}

function readConfig(raw: Readonly<Record<string, unknown>>): ChatRunsPruneConfig {
  return { maxAgeDays: pickPositiveInt(raw['maxAgeDays'], DEFAULT_MAX_AGE_DAYS) };
}

function pickPositiveInt(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0 && Number.isInteger(v)) {
    return v;
  }
  return fallback;
}

/**
 * Deletes every `chat_pipeline_runs` row (and its dependent
 * `chat_pipeline_steps` rows) whose `started_at` is older than the
 * configured cutoff. Returns the deletion counts so the handler
 * can log them for ops visibility.
 *
 * Idempotent: a second run against an already-pruned cutoff is a
 * no-op (0 / 0 returned).
 *
 * Foreign-key order:
 *   1. delete `chat_pipeline_steps` whose parent run is older than
 *      the cutoff (joined via `run_id`);
 *   2. delete the `chat_pipeline_runs` rows themselves.
 * Wrapped in `db.transaction(...)` so a crash mid-prune does not
 * leave a half-deleted set behind.
 */
export function pruneChatPipelineRuns(
  db: Database,
  opts: ChatRunsPruneConfig,
  now: Date,
): ChatRunsPruneResult {
  const cutoffIso = new Date(now.getTime() - opts.maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

  const deleteStepsSql = `
    DELETE FROM chat_pipeline_steps
     WHERE run_id IN (
       SELECT id FROM chat_pipeline_runs
        WHERE started_at < ?
     )
  `;
  const deleteRunsSql = `DELETE FROM chat_pipeline_runs WHERE started_at < ?`;

  const tx = db.transaction((cutoff: string): ChatRunsPruneResult => {
    const stepsRes = db.query<unknown, [string]>(deleteStepsSql).run(cutoff);
    const runsRes = db.query<unknown, [string]>(deleteRunsSql).run(cutoff);
    return { stepsDeleted: stepsRes.changes, runsDeleted: runsRes.changes };
  });
  return tx(cutoffIso);
}

export const chatRunsPruneHandler: ScheduledTaskHandler = {
  kind: CHAT_RUNS_PRUNE_KIND,
  defaultSchedule: { kind: 'interval', intervalMinutes: DEFAULT_INTERVAL_MINUTES },
  async run(ctx: ScheduledTaskRunContext): Promise<void> {
    const config = readConfig(ctx.task.config);
    const now = new Date(ctx.now());
    const result = pruneChatPipelineRuns(ctx.db, config, now);
    if (result.runsDeleted > 0 || result.stepsDeleted > 0) {
      ctx.logger.info('chat.runs.prune deleted', {
        event: 'chat.runs.prune.deleted',
        runsDeleted: result.runsDeleted,
        stepsDeleted: result.stepsDeleted,
        maxAgeDays: config.maxAgeDays,
      });
    }
  },
};
