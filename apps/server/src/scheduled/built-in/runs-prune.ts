import type { Database } from 'bun:sqlite';
import type { ScheduledTaskHandler, ScheduledTaskRunContext } from '../registry';

/**
 * Phase 5.3 — built-in run-history retention handler.
 *
 * Resolves plan §15 open question #2: "keep last N runs per task
 * (default N=200) OR runs newer than 30 days, whichever cuts more".
 *
 * Interpretation: "whichever cuts more" picks the stricter ceiling.
 * A row survives only when BOTH policies want to keep it — i.e.
 * delete when EITHER policy votes delete (rank > N OR older than
 * 30 days). A high-frequency task hits the N cap first; a
 * low-frequency task hits the age cap. The two caps work together
 * to bound disk usage in both regimes.
 *
 * Implementation: emit one DELETE per task — `WHERE requested_at <
 * <per-task Nth-most-recent>` (rank cap) OR `requested_at <
 * <age-cutoff>` (age cap). Combined with `WHERE task_id = ?` via
 * the correlated subquery; one SQL statement handles every
 * task_id at once.
 *
 * The handler is REGISTERED here but NOT seeded — phase 5.5 seeds
 * the actual `scheduled_tasks` row in the `everyone` layer with
 * the default `intervalMinutes=60` cadence. Until then the handler
 * exists in the registry but is dormant.
 */

export const SCHEDULED_RUNS_PRUNE_KIND = 'scheduled.runs.prune';

const DEFAULT_KEEP_PER_TASK = 200;
const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_INTERVAL_MINUTES = 60;

interface RunsPruneConfig {
  readonly keepPerTask: number;
  readonly maxAgeDays: number;
}

function readConfig(raw: Readonly<Record<string, unknown>>): RunsPruneConfig {
  const keepPerTask = pickPositiveInt(raw['keepPerTask'], DEFAULT_KEEP_PER_TASK);
  const maxAgeDays = pickPositiveInt(raw['maxAgeDays'], DEFAULT_MAX_AGE_DAYS);
  return { keepPerTask, maxAgeDays };
}

function pickPositiveInt(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0 && Number.isInteger(v)) {
    return v;
  }
  return fallback;
}

/**
 * Deletes rows older than the per-task `keepPerTask`th-most-recent
 * AND older than `maxAgeDays`. Returns the number of rows deleted —
 * the handler logs it for ops visibility.
 *
 * Exported so the (future) 5.7 docs test and ad-hoc maintenance
 * scripts can drive the same pruning logic without going through
 * the scheduler.
 */
export function pruneScheduledTaskRuns(db: Database, opts: RunsPruneConfig, now: Date): number {
  const cutoffIso = new Date(now.getTime() - opts.maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  // Per-task cutoff: the requested_at of the `keepPerTask`-th most
  // recent row. SQLite has no `FETCH NEXT … OFFSET` syntax tied to
  // window functions, so we use a correlated subquery with LIMIT 1
  // OFFSET (N-1). Rows older than this cutoff per task are
  // candidates; we then AND with the age cutoff.
  // NB: alias is `r` not `inner` — `INNER` is a SQLite reserved
  // word and triggers a parse error / silent misbehaviour on some
  // builds.
  //
  // Delete-side OR:
  //   (a) row is past the per-task rank cap (older than the
  //       Nth-most-recent row), OR
  //   (b) row is older than `maxAgeDays`.
  //
  // The keep-side is the AND of (NOT a) AND (NOT b) — i.e. a row
  // survives only when both policies agree to keep it.
  const sql = `
    DELETE FROM scheduled_task_runs
     WHERE requested_at < ?
        OR requested_at < COALESCE(
             (SELECT r.requested_at
                FROM scheduled_task_runs r
               WHERE r.task_id = scheduled_task_runs.task_id
               ORDER BY r.requested_at DESC
               LIMIT 1 OFFSET ?),
             '0000-00-00')
  `;
  const res = db.query<unknown, [string, number]>(sql).run(cutoffIso, opts.keepPerTask - 1);
  return res.changes;
}

export const scheduledRunsPruneHandler: ScheduledTaskHandler = {
  kind: SCHEDULED_RUNS_PRUNE_KIND,
  defaultSchedule: { kind: 'interval', intervalMinutes: DEFAULT_INTERVAL_MINUTES },
  async run(ctx: ScheduledTaskRunContext): Promise<void> {
    const config = readConfig(ctx.task.config);
    const now = new Date(ctx.now());
    const deleted = pruneScheduledTaskRuns(ctx.db, config, now);
    if (deleted > 0) {
      ctx.logger.info(`runs-prune deleted ${deleted} row(s)`, {
        keepPerTask: config.keepPerTask,
        maxAgeDays: config.maxAgeDays,
      });
    }
  },
};
