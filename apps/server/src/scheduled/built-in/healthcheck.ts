import type { ScheduledTaskHandler, ScheduledTaskRunContext } from '../registry';
import type { SystemHealthcheckTickPayload } from '../../bus/events';

/**
 * Phase 5.5 — built-in `system.healthcheck` scheduled-task handler.
 *
 * Two purposes:
 *  1. Dogfood the scheduler/bus pipeline end-to-end — if this stops
 *     ticking, something upstream (claim, publish, consume) is broken.
 *  2. Cheap "is the worker alive?" signal a future dashboard widget
 *     can read by tailing `events` for `system.healthcheck.tick`.
 *
 * The handler intentionally does almost nothing: it logs a short
 * "system OK" line and publishes one bus event. No DB writes, no
 * disk reads, no LLM calls — a healthcheck that touches every
 * subsystem would conflate "scheduler ran" with "all subsystems
 * healthy" and make alerting noisier than it needs to be.
 *
 * The factory closes over `schemaVersion` + `busAdapter` because the
 * generic `ScheduledTaskRunContext` deliberately does not expose
 * boot-time facts about the process — handlers that need them
 * receive them at registration. The handler does NOT read these
 * dynamically; the values are baked in at boot. That's fine: the
 * dashboard's interesting question is "is THIS process alive?",
 * and the bus event payload echoes the process's own
 * `schemaVersion` / `busAdapter` so a future federation can spot a
 * version drift between hosts.
 */

export const SYSTEM_HEALTHCHECK_KIND = 'system.healthcheck';

const DEFAULT_INTERVAL_MINUTES = 5;

export interface CreateHealthcheckHandlerDeps {
  /** Numeric SQLite migration the boot picked up. */
  readonly schemaVersion: string | null;
  /** Stable label of the bus adapter, e.g. `'durable-sqlite'`. */
  readonly busAdapter: string;
}

export function createHealthcheckHandler(deps: CreateHealthcheckHandlerDeps): ScheduledTaskHandler {
  return {
    kind: SYSTEM_HEALTHCHECK_KIND,
    defaultSchedule: { kind: 'interval', intervalMinutes: DEFAULT_INTERVAL_MINUTES },
    async run(ctx: ScheduledTaskRunContext): Promise<void> {
      const nowIso = ctx.now();
      ctx.logger.info('system.healthcheck: OK', {
        schemaVersion: deps.schemaVersion,
        busAdapter: deps.busAdapter,
      });
      const payload: SystemHealthcheckTickPayload = {
        now: nowIso,
        schemaVersion: deps.schemaVersion,
        busAdapter: deps.busAdapter,
      };
      await ctx.bus.publish({
        type: 'system.healthcheck.tick',
        payload,
        correlationId: ctx.correlationId,
      });
    },
  };
}
