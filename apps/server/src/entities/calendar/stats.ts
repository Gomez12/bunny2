import type { EntityStatsContext, EntityStatsProvider } from '../module';
import { CALENDAR_EVENT_KIND } from './module';

/**
 * Phase 4c.4 — pure-SQL aggregate provider for the calendar dashboard
 * widget. Third consumer of the §4a.4 `EntityModule.statsProvider`
 * slot; deliberately mirrors `apps/server/src/entities/companies/stats.ts`
 * and `apps/server/src/entities/contacts/stats.ts` so the foundation
 * absorbs the new widget with ZERO contract changes.
 *
 * Returns four counts:
 *
 *  - `total` — non-soft-deleted calendar events in the layer.
 *  - `upcomingNext7d` — non-soft-deleted events where
 *    `starts_at >= now AND starts_at < now+7d`. Reads the indexed
 *    `starts_at` column from 4c.1 directly so the lookup is one bounded
 *    range scan. Both bounds are ISO-8601 strings; SQLite compares
 *    `YYYY-MM-DDTHH:MM:SS.sssZ` strings lexicographically the same way it
 *    would compare timestamps because the format is fixed-width and
 *    timezone-stable.
 *  - `withAttendeesLinked` — events whose `payload.attendees[]` has at
 *    least one entry with `contactEntityId` set. The `attendees` array
 *    lives inside `payload_json`; SQLite's JSON1 extension (available in
 *    `bun:sqlite`) lets us walk the array via `json_each` and check the
 *    `contactEntityId` member. `json_each` over a NULL / missing array
 *    yields zero rows (verified empirically) so the `EXISTS (...)`
 *    subquery degrades to `false` for events without attendees, with no
 *    error path.
 *  - `recentlyEnriched` — events whose `entity_souls.updated_at` is
 *    newer than `now - 24h`. Mirrors the companies / contacts shape
 *    exactly — the enrichment runner writes that timestamp on every
 *    successful job via `recordLastEnriched` in
 *    `apps/server/src/entities/enrichment-runner.ts`.
 *
 * No event-bus subscription, no live state — every call is a fresh
 * read. `ctx.now` is injected so tests can pin both the upcoming window
 * AND the 24h "recently enriched" window without manipulating wall-clock.
 */
export interface CalendarEventStats {
  readonly total: number;
  readonly upcomingNext7d: number;
  readonly withAttendeesLinked: number;
  readonly recentlyEnriched: number;
}

const UPCOMING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RECENTLY_ENRICHED_WINDOW_MS = 24 * 60 * 60 * 1000;

export const calendarEventStatsProvider: EntityStatsProvider = {
  compute(ctx: EntityStatsContext): Record<string, unknown> {
    const totalRow = ctx.db
      .query<
        { n: number },
        [string]
      >(`SELECT COUNT(*) AS n FROM calendar_events WHERE layer_id = ? AND deleted_at IS NULL`)
      .get(ctx.layerId);
    const total = totalRow?.n ?? 0;

    // `starts_at` is an indexed TEXT column from 4c.1; both ISO strings
    // are fixed-width so SQLite's string comparison matches a real
    // timestamp comparison. The +7d boundary is computed in JS (per
    // plan) and passed in as a fully-formed ISO string.
    const nowIso = ctx.now().toISOString();
    const upcomingUntilIso = new Date(ctx.now().getTime() + UPCOMING_WINDOW_MS).toISOString();
    const upcomingRow = ctx.db
      .query<{ n: number }, [string, string, string]>(
        `SELECT COUNT(*) AS n FROM calendar_events
          WHERE layer_id = ?
            AND deleted_at IS NULL
            AND starts_at >= ?
            AND starts_at < ?`,
      )
      .get(ctx.layerId, nowIso, upcomingUntilIso);
    const upcomingNext7d = upcomingRow?.n ?? 0;

    // `json_each(json_extract(...))` walks the per-event attendees array
    // and lets us count "at least one attendee with contactEntityId
    // set". When `$.attendees` is missing or NULL the inner `json_each`
    // yields zero rows and `EXISTS` returns false — no error. See the
    // stats.ts docstring above.
    const linkedRow = ctx.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM calendar_events
          WHERE layer_id = ?
            AND deleted_at IS NULL
            AND EXISTS (
              SELECT 1 FROM json_each(json_extract(payload_json, '$.attendees')) je
               WHERE json_extract(je.value, '$.contactEntityId') IS NOT NULL
            )`,
      )
      .get(ctx.layerId);
    const withAttendeesLinked = linkedRow?.n ?? 0;

    const cutoff = new Date(ctx.now().getTime() - RECENTLY_ENRICHED_WINDOW_MS).toISOString();
    const recentRow = ctx.db
      .query<{ n: number }, [string, string, string]>(
        `SELECT COUNT(*) AS n
           FROM calendar_events c
           JOIN entity_souls s ON s.entity_id = c.id
          WHERE c.layer_id = ?
            AND c.deleted_at IS NULL
            AND s.entity_kind = ?
            AND s.updated_at > ?`,
      )
      .get(ctx.layerId, CALENDAR_EVENT_KIND, cutoff);
    const recentlyEnriched = recentRow?.n ?? 0;

    const result: CalendarEventStats = {
      total,
      upcomingNext7d,
      withAttendeesLinked,
      recentlyEnriched,
    };
    return result as unknown as Record<string, unknown>;
  },
};
