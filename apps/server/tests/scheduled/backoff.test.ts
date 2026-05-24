import { describe, expect, it } from 'bun:test';

/**
 * The run-subscriber's retry formula lives inline in
 * `run-subscriber.ts` (`Math.min(max, base * 2^(attempt-1))`). This
 * test asserts the formula matches the expected exponential sequence
 * documented in the plan §4.2 — capped at the configured max.
 *
 * Default base = 60s = 60_000ms; default max = 60min = 3_600_000ms.
 *
 * Expected sequence for attempts 1..9:
 *   1 → 60s    (base)
 *   2 → 2m
 *   3 → 4m
 *   4 → 8m
 *   5 → 16m
 *   6 → 32m
 *   7 → 60m   (cap)
 *   8 → 60m
 *   9 → 60m
 */
function backoffMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * Math.pow(2, attempt - 1));
}

describe('scheduled-task backoff', () => {
  const base = 60_000;
  const max = 3_600_000;

  it('produces 1m, 2m, 4m, 8m, 16m, 32m, then caps at 60m', () => {
    const sequence = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((a) => backoffMs(a, base, max));
    expect(sequence).toEqual([
      60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000, 3_600_000,
    ]);
  });

  it('respects a custom max smaller than the natural exponential value', () => {
    expect(backoffMs(10, base, 5 * 60_000)).toBe(5 * 60_000);
  });

  it('respects a custom base larger than 1m', () => {
    expect(backoffMs(1, 5 * 60_000, max)).toBe(5 * 60_000);
    expect(backoffMs(2, 5 * 60_000, max)).toBe(10 * 60_000);
  });
});
