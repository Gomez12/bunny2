import type { EntityStatsContext, EntityStatsProvider } from '../module';
import { COMPANY_KIND } from './module';

/**
 * Phase 4a.4 — pure-SQL aggregate provider for the companies dashboard
 * widget.
 *
 * Returns four counts:
 *
 *  - `total` — non-soft-deleted rows in the layer.
 *  - `withKvk` — rows with `kvk_number` set (NOT null and NOT '').
 *  - `missingDescription` — rows whose `payload_json.description` is
 *    NULL, missing, or empty.
 *  - `recentlyEnriched` — rows whose `entity_souls.updated_at` is newer
 *    than `now - 24h`. The enrichment runner writes that timestamp on
 *    every successful job (see `recordLastEnriched` in
 *    `apps/server/src/entities/enrichment-runner.ts`), so the row count
 *    answers "how many companies had at least one enrichment run inside
 *    the past 24 hours?".
 *
 * No event-bus subscription, no live state — every call is a fresh
 * read. The router passes a `now()` callback so tests can pin the
 * window without manipulating wall-clock.
 */
export interface CompanyStats {
  readonly total: number;
  readonly withKvk: number;
  readonly missingDescription: number;
  readonly recentlyEnriched: number;
}

const RECENTLY_ENRICHED_WINDOW_MS = 24 * 60 * 60 * 1000;

export const companyStatsProvider: EntityStatsProvider = {
  compute(ctx: EntityStatsContext): Record<string, unknown> {
    const totalRow = ctx.db
      .query<
        { n: number },
        [string]
      >(`SELECT COUNT(*) AS n FROM companies WHERE layer_id = ? AND deleted_at IS NULL`)
      .get(ctx.layerId);
    const total = totalRow?.n ?? 0;

    const withKvkRow = ctx.db
      .query<
        { n: number },
        [string]
      >(`SELECT COUNT(*) AS n FROM companies WHERE layer_id = ? AND deleted_at IS NULL AND kvk_number IS NOT NULL AND kvk_number != ''`)
      .get(ctx.layerId);
    const withKvk = withKvkRow?.n ?? 0;

    // `description` lives inside `payload_json`. SQLite's JSON1
    // extension is available in `bun:sqlite`; `json_extract` returns
    // NULL for missing keys, which matches our "missing" definition.
    const missingDescRow = ctx.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM companies
         WHERE layer_id = ?
           AND deleted_at IS NULL
           AND (
             json_extract(payload_json, '$.description') IS NULL
             OR json_extract(payload_json, '$.description') = ''
           )`,
      )
      .get(ctx.layerId);
    const missingDescription = missingDescRow?.n ?? 0;

    const cutoff = new Date(ctx.now().getTime() - RECENTLY_ENRICHED_WINDOW_MS).toISOString();
    const recentRow = ctx.db
      .query<{ n: number }, [string, string, string]>(
        `SELECT COUNT(*) AS n
           FROM companies c
           JOIN entity_souls s ON s.entity_id = c.id
          WHERE c.layer_id = ?
            AND c.deleted_at IS NULL
            AND s.entity_kind = ?
            AND s.updated_at > ?`,
      )
      .get(ctx.layerId, COMPANY_KIND, cutoff);
    const recentlyEnriched = recentRow?.n ?? 0;

    const result: CompanyStats = { total, withKvk, missingDescription, recentlyEnriched };
    return result as unknown as Record<string, unknown>;
  },
};
