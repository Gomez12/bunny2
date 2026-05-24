import { Cron } from 'croner';
import type { ScheduledTaskSchedule } from '@bunny2/shared';

/**
 * Phase 5.3 — pure schedule math.
 *
 * One file, two branches:
 *  - cron: defer to `croner` with the per-task timezone. `croner`
 *    understands DST + leap years; we explicitly do not roll our
 *    own here (plan §10, §14 "croner produces a wrong cron-next
 *    around DST" — risk mitigated by colocating every code path
 *    that talks to `croner` in this file so a swap is local).
 *  - interval: `now + intervalMinutes`. No drift correction — the
 *    plan §14 "Tick drift after a long suspend" decision is to
 *    re-anchor from the actual claim time on every tick, not to
 *    extrapolate from a `lastTick + interval` cursor.
 *
 * `nextRunAt` is always rendered in UTC (the SQL columns store ISO
 * strings; the scheduler tick compares them lexicographically).
 */

export interface ComputeNextRunOptions {
  /**
   * Anchor for the cron walk. `croner` returns "the next firing
   * STRICTLY AFTER `from`". When unset, defaults to `now`. The
   * scheduler tick passes `now` here; the boot-recovery pass passes
   * the original `next_run_at` so the re-anchored value picks up
   * the next slot AFTER the missed one rather than re-firing the
   * same slot.
   */
  readonly from?: Date;
}

export function computeNextRun(
  schedule: ScheduledTaskSchedule,
  now: Date,
  opts: ComputeNextRunOptions = {},
): Date {
  if (schedule.kind === 'interval') {
    const base = opts.from ?? now;
    return new Date(base.getTime() + schedule.intervalMinutes * 60_000);
  }
  // Cron path. `Cron(...).nextRun(from)` returns the first firing
  // strictly after `from`; on null (e.g. a cron that has no future
  // firing — rare with 5-field syntax) we fall back to one day
  // ahead so the row does not loop on `next_run_at <= now` forever.
  const cron = new Cron(schedule.cronExpression, { timezone: schedule.cronTimezone });
  const anchor = opts.from ?? now;
  const next = cron.nextRun(anchor);
  if (next === null) {
    return new Date(anchor.getTime() + 24 * 60 * 60 * 1000);
  }
  return next;
}
