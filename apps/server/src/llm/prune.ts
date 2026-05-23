import type { LlmCallLog } from './call-log';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PruneOpts {
  readonly log: LlmCallLog;
  readonly retentionDays?: number;
  readonly intervalMs?: number;
  /** Override `new Date()` for tests. */
  readonly clock?: () => Date;
  /** Override `console.log` for tests / silent runs. */
  readonly logger?: (msg: string) => void;
}

export interface PruneHandle {
  /** Stops the background timer. Safe to call repeatedly. */
  stop(): void;
  /** Runs one prune pass immediately and returns the deleted-row count. */
  runOnce(): number;
}

/**
 * Periodic retention prune for `llm_calls`. Defaults: 180-day retention,
 * pass every 24h.
 *
 * Scheduling uses `setInterval`. We pick `setInterval` over self-rescheduling
 * `setTimeout` because the work is cheap (one indexed `DELETE`) and we want
 * predictable cadence without depending on call duration. The handle from
 * `stop()` calls `clearInterval` so tests can clean up.
 *
 * Cutoff is computed per call as `clock() - retentionDays days`. The cutoff
 * is rendered as ISO-8601 so it sorts lexicographically against the
 * `started_at TEXT` column (which is also ISO-8601).
 */
export function startLlmRetentionPrune(opts: PruneOpts): PruneHandle {
  const retentionDays = opts.retentionDays ?? 180;
  const intervalMs = opts.intervalMs ?? DAY_MS;
  const clock = opts.clock ?? ((): Date => new Date());
  const logger = opts.logger ?? ((msg: string): void => console.log(msg));

  const runOnce = (): number => {
    const now = clock();
    const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
    const deleted = opts.log.pruneOlderThan(cutoff);
    if (deleted > 0) {
      logger(`[llm] prune removed ${deleted} row(s) older than ${cutoff.toISOString()}`);
    }
    return deleted;
  };

  // Run immediately so a long-lived process doesn't wait a full day before
  // the first pass; the daily interval covers steady-state.
  runOnce();
  const timer = setInterval(runOnce, intervalMs);
  // Don't keep the Bun process alive solely to prune.
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }

  return {
    stop(): void {
      clearInterval(timer);
    },
    runOnce,
  };
}
