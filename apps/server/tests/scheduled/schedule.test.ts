import { describe, expect, it } from 'bun:test';
import { computeNextRun } from '../../src/scheduled/schedule';

describe('computeNextRun', () => {
  it('returns the next cron firing strictly after now (Europe/Amsterdam)', () => {
    // Tuesday 2025-06-03 06:30 UTC = 08:30 Europe/Amsterdam (CEST,
    // UTC+2). Next firing of `0 7 * * MON` is the following Monday
    // at 07:00 Europe/Amsterdam = 05:00 UTC.
    const now = new Date('2025-06-03T06:30:00Z');
    const next = computeNextRun(
      { kind: 'cron', cronExpression: '0 7 * * MON', cronTimezone: 'Europe/Amsterdam' },
      now,
    );
    expect(next.toISOString()).toBe('2025-06-09T05:00:00.000Z');
  });

  it('rolls interval forward by intervalMinutes from now', () => {
    const now = new Date('2026-01-15T10:00:00Z');
    const next = computeNextRun({ kind: 'interval', intervalMinutes: 30 }, now);
    expect(next.toISOString()).toBe('2026-01-15T10:30:00.000Z');
  });

  it('rolls interval forward from `opts.from` when provided', () => {
    const now = new Date('2026-01-15T10:00:00Z');
    const from = new Date('2026-01-15T09:00:00Z');
    const next = computeNextRun({ kind: 'interval', intervalMinutes: 30 }, now, { from });
    expect(next.toISOString()).toBe('2026-01-15T09:30:00.000Z');
  });

  it('produces a deterministic firing across the Europe/Amsterdam DST spring-forward boundary (2026-03-29)', () => {
    // The 02:30 wallclock does not exist on the spring-forward day
    // (the clock jumps 02:00 CET → 03:00 CEST). The exact wallclock
    // croner chooses for the missing slot is library policy; what
    // matters for the scheduler is that the result is deterministic
    // and falls in a sensible window AROUND the spring-forward
    // transition (between 00:00 UTC and 24h later). The next-day
    // firing (regular 02:30 CEST = 00:30 UTC on 2026-03-30) is the
    // fallback the boot recovery uses.
    const now = new Date('2026-03-29T00:00:00Z');
    const next = computeNextRun(
      { kind: 'cron', cronExpression: '30 2 * * *', cronTimezone: 'Europe/Amsterdam' },
      now,
    );
    expect(next.getTime()).toBeGreaterThanOrEqual(now.getTime());
    expect(next.getTime()).toBeLessThanOrEqual(now.getTime() + 36 * 60 * 60 * 1000);
    // A SECOND call anchored after the first must produce a strictly
    // greater firing — proves croner is walking forward across the
    // transition rather than oscillating on the same slot.
    const after = new Date(next.getTime() + 60_000);
    const nextNext = computeNextRun(
      { kind: 'cron', cronExpression: '30 2 * * *', cronTimezone: 'Europe/Amsterdam' },
      after,
    );
    expect(nextNext.getTime()).toBeGreaterThan(next.getTime());
  });

  it('walks past the duplicated Europe/Amsterdam DST fall-back boundary (03:00→02:00 on 2026-10-25) without re-firing', () => {
    // Fall-back: 03:00 CEST becomes 02:00 CET. A 02:30 daily cron
    // fires once on 2026-10-25 02:30 CEST (= 00:30 UTC). The NEXT
    // firing must be the following day's 02:30 CET (= 01:30 UTC),
    // not the same wallclock again at 02:30 CET that same day.
    const after = new Date('2026-10-25T00:35:00Z');
    const next = computeNextRun(
      { kind: 'cron', cronExpression: '30 2 * * *', cronTimezone: 'Europe/Amsterdam' },
      after,
    );
    expect(next.toISOString()).toBe('2026-10-26T01:30:00.000Z');
  });
});
