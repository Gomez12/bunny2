import type { EntityStatsContext, EntityStatsProvider } from '../module';
import { CONTACT_KIND } from './module';

/**
 * Phase 4b.4 — pure-SQL aggregate provider for the contacts dashboard
 * widget. Second consumer of the §4a.4 `EntityModule.statsProvider`
 * slot; deliberately mirrors `apps/server/src/entities/companies/stats.ts`
 * so the foundation absorbs the new widget with ZERO contract changes.
 *
 * Returns four counts:
 *
 *  - `total` — non-soft-deleted contacts in the layer.
 *  - `withCompanyLink` — contacts with `company_entity_id` set. Reads
 *    the indexed column from 4b.1 (sparse `idx_contacts_company`).
 *  - `missingEmail` — contacts whose `primary_email` column is NULL
 *    (the 4b.1 derivation writes NULL when the payload has no email,
 *    and `idx_contacts_primary_email` covers the lookup).
 *  - `recentlyEnriched` — contacts whose `entity_souls.updated_at` is
 *    newer than `now - 24h`. The enrichment runner writes that timestamp
 *    on every successful job (`recordLastEnriched` in
 *    `apps/server/src/entities/enrichment-runner.ts`).
 *
 * No event-bus subscription, no live state — every call is a fresh
 * read. `ctx.now` is injected so tests can pin the 24h window without
 * manipulating wall-clock.
 */
export interface ContactStats {
  readonly total: number;
  readonly withCompanyLink: number;
  readonly missingEmail: number;
  readonly recentlyEnriched: number;
}

const RECENTLY_ENRICHED_WINDOW_MS = 24 * 60 * 60 * 1000;

export const contactStatsProvider: EntityStatsProvider = {
  compute(ctx: EntityStatsContext): Record<string, unknown> {
    const totalRow = ctx.db
      .query<
        { n: number },
        [string]
      >(`SELECT COUNT(*) AS n FROM contacts WHERE layer_id = ? AND deleted_at IS NULL`)
      .get(ctx.layerId);
    const total = totalRow?.n ?? 0;

    const withCompanyRow = ctx.db
      .query<
        { n: number },
        [string]
      >(`SELECT COUNT(*) AS n FROM contacts WHERE layer_id = ? AND deleted_at IS NULL AND company_entity_id IS NOT NULL`)
      .get(ctx.layerId);
    const withCompanyLink = withCompanyRow?.n ?? 0;

    const missingEmailRow = ctx.db
      .query<
        { n: number },
        [string]
      >(`SELECT COUNT(*) AS n FROM contacts WHERE layer_id = ? AND deleted_at IS NULL AND primary_email IS NULL`)
      .get(ctx.layerId);
    const missingEmail = missingEmailRow?.n ?? 0;

    const cutoff = new Date(ctx.now().getTime() - RECENTLY_ENRICHED_WINDOW_MS).toISOString();
    const recentRow = ctx.db
      .query<{ n: number }, [string, string, string]>(
        `SELECT COUNT(*) AS n
           FROM contacts c
           JOIN entity_souls s ON s.entity_id = c.id
          WHERE c.layer_id = ?
            AND c.deleted_at IS NULL
            AND s.entity_kind = ?
            AND s.updated_at > ?`,
      )
      .get(ctx.layerId, CONTACT_KIND, cutoff);
    const recentlyEnriched = recentRow?.n ?? 0;

    const result: ContactStats = { total, withCompanyLink, missingEmail, recentlyEnriched };
    return result as unknown as Record<string, unknown>;
  },
};
