import type { LlmCallLog } from '../../llm';
import { pruneLlmCalls } from '../../llm/prune';
import type { ScheduledTaskHandler, ScheduledTaskRunContext } from '../registry';

/**
 * Phase 5.5 — built-in `llm.calls.prune` scheduled-task handler.
 *
 * Replaces the bespoke `setInterval`-based `startLlmRetentionPrune`
 * that index.ts used to spawn at boot. The retention math (cutoff =
 * `now - retentionDays`) is unchanged; ownership of the cadence
 * moves to the generic scheduler so:
 *  - admins can pause/resume the prune from the layer settings page,
 *  - retention windows can be tuned per deployment via the task's
 *    `config.retentionDays` JSON field without a code change,
 *  - the run history (success / failure / duration) is visible in
 *    the same UI as every other scheduled job.
 *
 * Config contract:
 *  - `retentionDays` (positive integer). If absent or invalid the
 *    handler falls back to the factory's `defaultRetentionDays`
 *    (`config.llm.retentionDays` at boot — default 180).
 *
 * Default cadence: daily (`intervalMinutes = 24 * 60`). The seed in
 * `scheduled/seed.ts` writes a row with this cadence on first boot;
 * admins can switch to a cron schedule via the 5.6 UI.
 */

export const LLM_PRUNE_KIND = 'llm.calls.prune';

const DEFAULT_INTERVAL_MINUTES = 24 * 60;

export interface CreateLlmPruneHandlerDeps {
  readonly llmCallLog: LlmCallLog;
  /**
   * Fallback retention used when the task row's `config.retentionDays`
   * is missing or not a positive integer. Wired from
   * `config.llm.retentionDays` in `index.ts`.
   */
  readonly defaultRetentionDays: number;
}

function pickRetentionDays(raw: Readonly<Record<string, unknown>>, fallback: number): number {
  const v = raw['retentionDays'];
  if (typeof v === 'number' && Number.isFinite(v) && v > 0 && Number.isInteger(v)) {
    return v;
  }
  return fallback;
}

export function createLlmPruneHandler(deps: CreateLlmPruneHandlerDeps): ScheduledTaskHandler {
  return {
    kind: LLM_PRUNE_KIND,
    defaultSchedule: { kind: 'interval', intervalMinutes: DEFAULT_INTERVAL_MINUTES },
    async run(ctx: ScheduledTaskRunContext): Promise<void> {
      const retentionDays = pickRetentionDays(ctx.task.config, deps.defaultRetentionDays);
      const now = new Date(ctx.now());
      const deleted = pruneLlmCalls({
        log: deps.llmCallLog,
        retentionDays,
        now,
        // Route the "removed N rows" line through the handler logger so
        // it lands alongside every other scheduled-task log entry.
        logger: (msg) => ctx.logger.info(msg, { retentionDays }),
      });
      // `pruneLlmCalls` only logs when it removed >0 rows. Surface a
      // structured `info` entry on every successful run so a "did the
      // prune even fire?" check from the dashboard doesn't need a row
      // delta — the run-history table already has the answer.
      if (deleted === 0) {
        ctx.logger.info('llm.calls.prune: no rows older than cutoff', { retentionDays });
      }
    },
  };
}
