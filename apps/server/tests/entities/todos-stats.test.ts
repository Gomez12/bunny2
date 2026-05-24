/**
 * Phase 4d.4 — HTTP-level checks for `GET /l/:slug/todo/_stats`.
 *
 * Asserts the four counts the todos dashboard widget consumes:
 *
 *   - `totalOpen` — non-soft-deleted todos with
 *     `status NOT IN ('done', 'cancelled')`.
 *   - `dueToday` — open-ish todos with `date(due_at) = date('now')`.
 *   - `overdue` — open-ish todos with `due_at < now`.
 *   - `highPriorityOpen` — open-ish todos with `priority <= 2`.
 *
 * Also exercises layer isolation so a todo in a sibling layer never
 * pollutes the requesting layer's counts.
 *
 * Mirrors `apps/server/tests/entities/calendar-stats.test.ts` — the
 * fourth consumer of the §4a.4 `statsProvider` slot deliberately
 * follows the third one's HTTP smoke pattern.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { seedUserAndSession } from '../_helpers/auth';
import { makeTestApp, type TestApp } from '../_helpers/app';
import { seedLayersIfNeeded } from '../../src/layers/seed';

let fx: TestApp | null = null;
afterEach(() => {
  if (fx !== null) {
    fx.cleanup();
    fx = null;
  }
});

interface TodoStats {
  readonly totalOpen: number;
  readonly dueToday: number;
  readonly overdue: number;
  readonly highPriorityOpen: number;
}

async function postJson(
  app: TestApp,
  url: string,
  token: string,
  body: unknown,
  method: 'POST' | 'PATCH' | 'DELETE' = 'POST',
): Promise<Response> {
  return app.app.fetch(
    new Request(`http://localhost${url}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function getJson(app: TestApp, url: string, token: string): Promise<Response> {
  return app.app.fetch(
    new Request(`http://localhost${url}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

/**
 * Helper — today / tomorrow / yesterday as date-only strings the
 * todos zod schema accepts. The stats provider reads `date(due_at)`
 * which strips down both date-only and full-ISO `dueAt` to the same
 * shape, so the test stays simple by sticking to date-only strings.
 */
function isoDateOffsetDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

describe('GET /l/:slug/todo/_stats', () => {
  async function seed(prefix: string): Promise<{ token: string; slug: string; otherSlug: string }> {
    if (fx === null) throw new Error('fixture not initialised');
    const { token } = seedUserAndSession(fx.db, { username: prefix });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    await postJson(fx, '/layers', token, { type: 'project', slug: 'stats', name: 'Stats' });
    await postJson(fx, '/layers', token, { type: 'project', slug: 'stats2', name: 'Other' });
    return { token, slug: 'stats', otherSlug: 'stats2' };
  }

  it('returns 200 with zero counts on an empty layer', async () => {
    fx = makeTestApp('bunny2-todos-stats-empty-');
    const { token } = await seed('tse');
    const res = await getJson(fx, '/l/stats/todo/_stats', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stats: TodoStats };
    expect(body.stats).toEqual({
      totalOpen: 0,
      dueToday: 0,
      overdue: 0,
      highPriorityOpen: 0,
    });
  });

  it('counts totalOpen, dueToday, overdue, and highPriorityOpen correctly', async () => {
    fx = makeTestApp('bunny2-todos-stats-happy-');
    const { token } = await seed('tsh');

    // T1 — open, due today. Counts in `totalOpen` and `dueToday`.
    let res = await postJson(fx, '/l/stats/todo', token, {
      title: 'Call AMI BV',
      originalLocale: 'en',
      slug: 't-due-today',
      payload: { dueAt: isoDateOffsetDays(0) },
    });
    expect(res.status).toBe(201);

    // T2 — open, due tomorrow. Counts only in `totalOpen` — proves
    // `totalOpen > dueToday` on a layer with at least one "later"
    // open todo. Status defaults to 'open' via the zod schema.
    res = await postJson(fx, '/l/stats/todo', token, {
      title: 'Pay invoice',
      originalLocale: 'en',
      slug: 't-due-tomorrow',
      payload: { dueAt: isoDateOffsetDays(1) },
    });
    expect(res.status).toBe(201);

    // T3 — open, overdue (due yesterday). Counts in `totalOpen` and
    // `overdue`. Demonstrates the lexicographic-vs-ISO comparison
    // path on the indexed `due_at` column.
    res = await postJson(fx, '/l/stats/todo', token, {
      title: 'Reply to Bob',
      originalLocale: 'en',
      slug: 't-overdue',
      payload: { dueAt: isoDateOffsetDays(-1) },
    });
    expect(res.status).toBe(201);

    // T4 — open, priority 1, no due date. Counts in `totalOpen` and
    // `highPriorityOpen`. Decoy for both date-based counters (no
    // `dueAt` → NULL → does NOT contribute to `dueToday` / `overdue`).
    res = await postJson(fx, '/l/stats/todo', token, {
      title: 'Urgent strategic review',
      originalLocale: 'en',
      slug: 't-high-priority',
      payload: { priority: 1 },
    });
    expect(res.status).toBe(201);

    // T5 — done. EXCLUDED from every counter because the open-ish
    // gate (`status NOT IN ('done', 'cancelled')`) drops it. Has a
    // `dueAt` of today to prove the gate dominates the date filter.
    res = await postJson(fx, '/l/stats/todo', token, {
      title: 'Already finished',
      originalLocale: 'en',
      slug: 't-done',
      payload: { status: 'done', dueAt: isoDateOffsetDays(0), priority: 1 },
    });
    expect(res.status).toBe(201);

    // T6 — cancelled. EXCLUDED from every counter for the same
    // reason as T5. Also priority 1 to prove `highPriorityOpen`
    // respects the status gate.
    res = await postJson(fx, '/l/stats/todo', token, {
      title: 'Never mind',
      originalLocale: 'en',
      slug: 't-cancelled',
      payload: { status: 'cancelled', priority: 1, dueAt: isoDateOffsetDays(-2) },
    });
    expect(res.status).toBe(201);

    res = await getJson(fx, '/l/stats/todo/_stats', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stats: TodoStats };
    expect(body.stats).toEqual({
      // 4 open-ish todos: T1, T2, T3, T4. T5 and T6 are dropped by
      // the status gate.
      totalOpen: 4,
      // Only T1.
      dueToday: 1,
      // Only T3 (T6 has `dueAt: -2d` BUT is cancelled, so the status
      // gate excludes it).
      overdue: 1,
      // Only T4 (T5 and T6 are priority 1 but done / cancelled).
      highPriorityOpen: 1,
    });
  });

  it('does not include todos from sibling layers', async () => {
    fx = makeTestApp('bunny2-todos-stats-isolation-');
    const { token, slug, otherSlug } = await seed('tsi');

    // Two todos in `stats`, three in `stats2`. Each layer's counts
    // must stay independent — a todo in the other layer never
    // contributes to the requested layer's counters.
    await postJson(fx, `/l/${slug}/todo`, token, {
      title: 'Self One',
      originalLocale: 'en',
      slug: 's1',
      payload: { dueAt: isoDateOffsetDays(0) },
    });
    await postJson(fx, `/l/${slug}/todo`, token, {
      title: 'Self Two',
      originalLocale: 'en',
      slug: 's2',
      payload: { priority: 1 },
    });
    for (const s of ['o1', 'o2', 'o3']) {
      await postJson(fx, `/l/${otherSlug}/todo`, token, {
        title: s.toUpperCase(),
        originalLocale: 'en',
        slug: s,
        payload: { dueAt: isoDateOffsetDays(0), priority: 1 },
      });
    }

    const res = await getJson(fx, `/l/${slug}/todo/_stats`, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stats: TodoStats };
    expect(body.stats).toEqual({
      totalOpen: 2,
      dueToday: 1,
      overdue: 0,
      highPriorityOpen: 1,
    });

    const other = await getJson(fx, `/l/${otherSlug}/todo/_stats`, token);
    expect(other.status).toBe(200);
    const otherBody = (await other.json()) as { stats: TodoStats };
    expect(otherBody.stats).toEqual({
      totalOpen: 3,
      dueToday: 3,
      overdue: 0,
      highPriorityOpen: 3,
    });
  });
});
