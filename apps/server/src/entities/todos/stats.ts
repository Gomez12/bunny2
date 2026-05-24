import type { EntityStatsContext, EntityStatsProvider } from '../module';

/**
 * Phase 4d.4 — pure-SQL aggregate provider for the todos dashboard
 * widget. Fourth consumer of the §4a.4 `EntityModule.statsProvider`
 * slot; deliberately mirrors `apps/server/src/entities/companies/stats.ts`,
 * `apps/server/src/entities/contacts/stats.ts`, and
 * `apps/server/src/entities/calendar/stats.ts` so the foundation absorbs
 * the new widget with ZERO contract changes — the fourth empirical
 * validation in a row.
 *
 * Returns four counts. Every counter excludes soft-deleted rows
 * (`deleted_at IS NULL`) and, where applicable, the terminal todo
 * statuses `'done'` and `'cancelled'` — i.e. only "open-ish" work is
 * surfaced on the dashboard. All four counters read the indexed
 * `status`, `priority`, and `due_at` columns the 4d.1 migration added,
 * so the queries are one-line single-table scans against indexes.
 *
 *  - `totalOpen` — non-deleted todos where
 *    `status NOT IN ('done', 'cancelled')`.
 *  - `dueToday` — same status filter PLUS `date(due_at) = date('now')`.
 *    `due_at` accepts either a date-only string (`YYYY-MM-DD`) or a
 *    full ISO-8601 timestamp; `date(...)` extracts the date portion
 *    from both shapes (returns NULL for NULL inputs, which falls out
 *    of the equality). SQLite's `date('now')` returns the current UTC
 *    date — phase-4 timezone behaviour is "v1 local-to-user" per the
 *    4c.5 follow-up; using UTC at the SQL layer is the documented v1
 *    behaviour. A timezone-aware variant is a phase-5 follow-up once
 *    we ship per-user timezone preferences.
 *  - `overdue` — same status filter PLUS `date(due_at) < date(now)`.
 *    Date-only comparison so a date-only `dueAt = today` is NOT
 *    flagged as overdue (lexicographic raw-string comparison would
 *    incorrectly count it because `'YYYY-MM-DD' < 'YYYY-MM-DDT...'`).
 *    The "overdue" semantic is "due date is strictly before today" —
 *    a todo whose `dueAt` is today (timestamped or date-only) belongs
 *    in `dueToday`, not `overdue`. A timestamped `dueAt` that fell
 *    earlier today (e.g. `08:00` when now is `13:00`) stays in
 *    `dueToday` for v1; an hour-aware "overdue" cutoff is a
 *    phase-5 follow-up once per-user timezone preferences ship.
 *  - `highPriorityOpen` — same status filter PLUS `priority <= 2`.
 *    The schema range is 1..5 with 3 as the default ("normal"); 1 and
 *    2 are the "needs attention now" band the dashboard surfaces.
 *
 * No event-bus subscription, no live state — every call is a fresh
 * read. `ctx.now` is injected so tests can pin the day window without
 * manipulating wall-clock.
 */
export interface TodoStats {
  readonly totalOpen: number;
  readonly dueToday: number;
  readonly overdue: number;
  readonly highPriorityOpen: number;
}

export const todoStatsProvider: EntityStatsProvider = {
  compute(ctx: EntityStatsContext): Record<string, unknown> {
    // The injected clock controls both the "today" window and the
    // overdue cutoff. Resolve to a single date-only string and feed
    // it into both date-based queries (`dueToday`, `overdue`). The
    // SQL `date(...)` strip applies the same projection to the
    // `due_at` column so both date-only and full-ISO `dueAt` shapes
    // compare identically. UTC at the SQL layer is the documented
    // v1 behaviour — phase-5 timezone work owns the per-user variant.
    const todayDate = ctx.now().toISOString().slice(0, 10);

    const totalOpenRow = ctx.db
      .query<
        { n: number },
        [string]
      >(`SELECT COUNT(*) AS n FROM todos WHERE layer_id = ? AND deleted_at IS NULL AND status NOT IN ('done', 'cancelled')`)
      .get(ctx.layerId);
    const totalOpen = totalOpenRow?.n ?? 0;

    // `date(due_at)` extracts the date portion from either a
    // `YYYY-MM-DD` string or a full ISO-8601 timestamp. The comparison
    // is against the injected `todayDate` so tests can pin the day
    // without relying on the SQLite process clock (`date('now')`).
    const dueTodayRow = ctx.db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) AS n FROM todos
          WHERE layer_id = ?
            AND deleted_at IS NULL
            AND status NOT IN ('done', 'cancelled')
            AND due_at IS NOT NULL
            AND date(due_at) = ?`,
      )
      .get(ctx.layerId, todayDate);
    const dueToday = dueTodayRow?.n ?? 0;

    // `date(due_at) < ?` against the injected UTC date. Date-only
    // comparison so a date-only `dueAt = today` is NOT also counted
    // as overdue (the raw `due_at < nowIso` lexicographic comparison
    // would mis-classify `'2026-05-24' < '2026-05-24T...'`). NULL
    // `due_at` rows do not contribute (NULL comparisons are NULL —
    // falsy in WHERE). The `date(...)` strip also keeps a "due at
    // 08:00 today, now is 13:00" todo OUT of `overdue` for v1; this
    // is the documented v1 behaviour per the plan and an hour-aware
    // cutoff is a phase-5 follow-up.
    const overdueRow = ctx.db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) AS n FROM todos
          WHERE layer_id = ?
            AND deleted_at IS NULL
            AND status NOT IN ('done', 'cancelled')
            AND due_at IS NOT NULL
            AND date(due_at) < ?`,
      )
      .get(ctx.layerId, todayDate);
    const overdue = overdueRow?.n ?? 0;

    const highPriorityRow = ctx.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM todos
          WHERE layer_id = ?
            AND deleted_at IS NULL
            AND status NOT IN ('done', 'cancelled')
            AND priority <= 2`,
      )
      .get(ctx.layerId);
    const highPriorityOpen = highPriorityRow?.n ?? 0;

    const result: TodoStats = { totalOpen, dueToday, overdue, highPriorityOpen };
    return result as unknown as Record<string, unknown>;
  },
};
