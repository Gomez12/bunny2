import type { Database } from 'bun:sqlite';
import type { ScheduledTaskHandler, ScheduledTaskRunContext } from '../registry';
import { ANALYTICS_SINK_EVENT_TYPES } from '../../observability/events';

/**
 * Phase 6 of `docs/dev/plans/admin-observability-viewer.md` —
 * built-in `analytics.events.prune` scheduled-task handler.
 *
 * Mitigates the "table grows unbounded" risk for `analytics_events`,
 * the per-ADR-0031 D4 retention contract. Defaults match the ADR
 * (90 days). The retention window is configurable per environment
 * via `ANALYTICS_RETENTION_DAYS` AND per task row via
 * `config.retentionDays` — same precedence layering as the LLM
 * prune (`llm-prune.ts`).
 *
 * Config contract:
 *  - `retentionDays` (positive integer). If absent or invalid the
 *    handler falls back to the factory's `defaultRetentionDays`
 *    (`ANALYTICS_RETENTION_DAYS` env, or 90 when the env is
 *    missing).
 *
 * Default cadence: daily (`intervalMinutes = 24 * 60`).
 */

export const ANALYTICS_PRUNE_KIND = 'analytics.events.prune';

const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_INTERVAL_MINUTES = 24 * 60;
const ENV_RETENTION_DAYS = 'ANALYTICS_RETENTION_DAYS';

export interface CreateAnalyticsPruneHandlerDeps {
  /**
   * Fallback retention used when the task row's `config.retentionDays`
   * is missing or not a positive integer. Wired by `index.ts` from
   * `Bun.env[ANALYTICS_RETENTION_DAYS]` with a 90-day fallback.
   */
  readonly defaultRetentionDays?: number;
}

function pickRetentionDays(raw: Readonly<Record<string, unknown>>, fallback: number): number {
  const v = raw['retentionDays'];
  if (typeof v === 'number' && Number.isFinite(v) && v > 0 && Number.isInteger(v)) {
    return v;
  }
  return fallback;
}

/**
 * Deletes `analytics_events` rows older than the retention cutoff.
 * Returns the number of rows removed. Exported so smoke / maintenance
 * scripts can drive the prune directly without going through the
 * scheduler.
 */
export function pruneAnalyticsEvents(db: Database, retentionDays: number, now: Date): number {
  const cutoffIso = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const res = db
    .query<unknown, [string]>(`DELETE FROM analytics_events WHERE occurred_at < ?`)
    .run(cutoffIso);
  return res.changes;
}

/**
 * Reads `ANALYTICS_RETENTION_DAYS` from the env once at boot. Same
 * pattern as `config.llm.retentionDays`. Returns the default when the
 * env is missing or not a positive integer.
 */
export function readAnalyticsRetentionDaysFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env[ENV_RETENTION_DAYS];
  if (raw === undefined || raw === '') return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) return DEFAULT_RETENTION_DAYS;
  return n;
}

export function createAnalyticsPruneHandler(
  deps: CreateAnalyticsPruneHandlerDeps = {},
): ScheduledTaskHandler {
  const defaultRetentionDays = deps.defaultRetentionDays ?? readAnalyticsRetentionDaysFromEnv();
  return {
    kind: ANALYTICS_PRUNE_KIND,
    defaultSchedule: { kind: 'interval', intervalMinutes: DEFAULT_INTERVAL_MINUTES },
    async run(ctx: ScheduledTaskRunContext): Promise<void> {
      const retentionDays = pickRetentionDays(ctx.task.config, defaultRetentionDays);
      const now = new Date(ctx.now());
      const deleted = pruneAnalyticsEvents(ctx.db, retentionDays, now);

      // File-log shape mirrors the other prune handlers (logging.md
      // §4 retention surfaces). Console output is structured so
      // operators can grep the count.
      console.log('[analytics.events.pruned]', {
        event: 'analytics.events.pruned',
        deletedCount: deleted,
        retentionDays,
      });
      if (deleted === 0) {
        ctx.logger.info('analytics.events.prune: no rows older than cutoff', { retentionDays });
      } else {
        ctx.logger.info(`analytics.events.prune deleted ${deleted} row(s)`, { retentionDays });
      }

      try {
        await ctx.bus.publish({
          type: ANALYTICS_SINK_EVENT_TYPES.Pruned,
          payload: { deletedCount: deleted, retentionDays },
        });
      } catch {
        // Telemetry must never break the prune. Swallow.
      }
    },
  };
}
