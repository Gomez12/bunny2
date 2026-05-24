import type { Database } from 'bun:sqlite';
import type { ScheduledTaskHandler, ScheduledTaskRunContext } from '../registry';

/**
 * Phase 5.5 — built-in `bus.outbox.prune` scheduled-task handler.
 *
 * Mitigates plan §14 risk "Outbox grows unbounded". The
 * `bus_outbox` row stays put after the consumer marks it
 * `delivered` / `dead` / `abandoned` so a DLQ inspector can still
 * fetch the full payload; without a sweep the table would grow
 * forever. Default retention is 7 days from `delivered_at`, matching
 * the plan §14 risk row.
 *
 * IMPORTANT: this handler only prunes the OUTBOX delivery ledger.
 * DLQ rows themselves stay in `bus_dlq` indefinitely — that table
 * is the audit trail for "what went wrong" and is small enough that
 * unbounded growth is not a concern in v1 (one row per dead
 * delivery). If a DLQ retention policy is needed later it ships as
 * a separate handler.
 *
 * Config contract:
 *  - `retentionDays` (positive integer; default 7).
 *
 * Cutoff math: `delivered_at` is only set when status transitioned
 * to `delivered`. `abandoned` and `dead` rows have
 * `delivered_at IS NULL`, so we COALESCE to `occurred_at` for
 * those — otherwise the WHERE clause would never match them and
 * abandoned/dead rows would accumulate forever (the exact failure
 * mode the plan calls out).
 */

export const BUS_OUTBOX_PRUNE_KIND = 'bus.outbox.prune';

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_INTERVAL_MINUTES = 60;

interface OutboxPruneConfig {
  readonly retentionDays: number;
}

function readConfig(raw: Readonly<Record<string, unknown>>): OutboxPruneConfig {
  const v = raw['retentionDays'];
  if (typeof v === 'number' && Number.isFinite(v) && v > 0 && Number.isInteger(v)) {
    return { retentionDays: v };
  }
  return { retentionDays: DEFAULT_RETENTION_DAYS };
}

/**
 * Deletes terminal `bus_outbox` rows older than the retention cutoff.
 * Returns the number of rows removed.
 *
 * Exported so smoke / maintenance scripts can drive the prune
 * directly without going through the scheduler.
 */
export function pruneBusOutbox(db: Database, retentionDays: number, now: Date): number {
  const cutoffIso = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  // `delivered_at` is NULL on `abandoned` / `dead` rows; fall back to
  // `occurred_at` so those rows age out by their original publish
  // time rather than living forever.
  const res = db
    .query<unknown, [string]>(
      `DELETE FROM bus_outbox
        WHERE status IN ('delivered', 'abandoned', 'dead')
          AND COALESCE(delivered_at, occurred_at) < ?`,
    )
    .run(cutoffIso);
  return res.changes;
}

export const busOutboxPruneHandler: ScheduledTaskHandler = {
  kind: BUS_OUTBOX_PRUNE_KIND,
  defaultSchedule: { kind: 'interval', intervalMinutes: DEFAULT_INTERVAL_MINUTES },
  async run(ctx: ScheduledTaskRunContext): Promise<void> {
    const { retentionDays } = readConfig(ctx.task.config);
    const now = new Date(ctx.now());
    const deleted = pruneBusOutbox(ctx.db, retentionDays, now);
    if (deleted > 0) {
      ctx.logger.info(`bus.outbox.prune deleted ${deleted} row(s)`, { retentionDays });
    } else {
      ctx.logger.info('bus.outbox.prune: no terminal rows older than cutoff', { retentionDays });
    }
  },
};
