import type { LlmCallLog } from './call-log';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PruneLlmCallsOpts {
  readonly log: LlmCallLog;
  readonly retentionDays: number;
  /** Wallclock for the cutoff. Tests pass a fixed Date. */
  readonly now: Date;
  /** Optional sink for the "removed N rows" log line. */
  readonly logger?: (msg: string) => void;
}

/**
 * Pure one-shot prune of the `llm_calls` table.
 *
 * Phase 5.5 — extracted from the old `startLlmRetentionPrune` so the
 * `llm.calls.prune` scheduled-task handler can drive the same logic
 * without owning a timer. The handler (built-in/llm-prune.ts) calls
 * this on every tick; `startLlmRetentionPrune` is gone — the
 * scheduler registry replaces the bespoke `setInterval`.
 *
 * Cutoff is `now - retentionDays` rendered as ISO-8601 so it sorts
 * lexicographically against the `started_at TEXT` column.
 */
export function pruneLlmCalls(opts: PruneLlmCallsOpts): number {
  const cutoff = new Date(opts.now.getTime() - opts.retentionDays * DAY_MS);
  const deleted = opts.log.pruneOlderThan(cutoff);
  if (deleted > 0 && opts.logger !== undefined) {
    opts.logger(`[llm] prune removed ${deleted} row(s) older than ${cutoff.toISOString()}`);
  }
  return deleted;
}
