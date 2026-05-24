import { CompanyPayloadSchema, type CompanyPayload } from '@bunny2/shared';
import type { EnrichmentJob, EntityModule } from '../module';
import type { EntityConnector } from '../connectors/base';
import { createKvkConnector } from './kvk-connector';
import { companyEnrichmentJobs } from './enrichment';
import { companyStatsProvider } from './stats';

/**
 * Phase 4a.1 — first concrete `EntityModule`.
 *
 * Wires:
 *  - `kind = 'company'` — the bus event prefix (`entity.company.*`) and
 *    the URL segment (`/l/:slug/company/...` — singular per the §4.0
 *    router naming; the web UI in 4a.5 surfaces a friendlier
 *    `/l/:slug/companies` page that calls this URL underneath).
 *  - `tableName = 'companies'` — the per-kind table created in
 *    `0006_companies.sql`.
 *  - `payloadSchema` — the cross-package zod schema from
 *    `packages/shared/src/companies.ts`.
 *  - `indexedColumns` — denormalized columns (`kvk_number`, `website`)
 *    written by the generic store on every insert/update. The §4.0
 *    foundation gained `EntityModule.indexedColumns` in 4a.1 to support
 *    this without per-kind hacks in the store. See
 *    `docs/dev/architecture/entities.md` §2 and the §14 close-out in
 *    `docs/dev/plans/done/phase-04-first-entities.md`.
 *  - `toSummary` — picks a sensible subtitle (KvK number first, website
 *    second) so the listing page is useful without opening detail view.
 *  - `searchableText` — lowercase, space-joined digest of the fields a
 *    user is most likely to search for. The §4.0 `searchSummaries`
 *    lowercases the query, so the digest is lowercased here too.
 *
 * No connectors / scheduled jobs / lifecycle hooks in 4a.1 — those land
 * in 4a.2 (KvK connector) and 4a.3 (AI enrichment).
 */
export const COMPANY_KIND = 'company';
export const COMPANY_TABLE = 'companies';

/**
 * Per-process default connector for production. Tests build their own
 * via `createCompanyModule({ kvkFetch: fakeFetch })` so they don't
 * accidentally hit the real KvK endpoint via the registered module.
 */
const defaultKvkConnector = createKvkConnector();

/**
 * Build a fresh `companyModule` variant. Production wiring calls this
 * once at boot (via `registerCompanyModule`); tests call it per-fixture
 * to inject a stub `fetch`. The default export `companyModule` uses
 * the default KvK connector (real `fetch`).
 */
export function createCompanyModule(
  opts: CreateCompanyModuleOptions = {},
): EntityModule<CompanyPayload> {
  const connectors: readonly EntityConnector<CompanyPayload>[] = opts.connectors ?? [
    defaultKvkConnector as EntityConnector<CompanyPayload>,
  ];
  const enrichmentJobs: readonly EnrichmentJob<CompanyPayload>[] =
    opts.enrichmentJobs ?? companyEnrichmentJobs;
  return {
    kind: COMPANY_KIND,
    tableName: COMPANY_TABLE,
    payloadSchema: CompanyPayloadSchema,
    indexedColumns: [
      {
        name: 'kvk_number',
        extract: (payload) => payload.kvkNumber ?? null,
      },
      {
        name: 'website',
        extract: (payload) => payload.website ?? null,
      },
    ],
    connectors,
    enrichmentJobs,
    // Phase 4c.3 — the runner's per-module `enrichmentOverwriteFields`
    // slot replaces the previously-hardcoded `description` exception.
    // Companies declares the field here so `companies.summary` continues
    // to overwrite an existing description on `updated` / `sync.succeeded`.
    enrichmentOverwriteFields: ['description'],
    statsProvider: companyStatsProvider,
    toSummary({ ref, meta, payload, title }) {
      const subtitle = payload.kvkNumber ?? payload.website ?? null;
      return {
        ...ref,
        meta,
        title,
        subtitle,
        searchableText: searchableTextFor(payload),
      };
    },
    searchableText(payload) {
      return searchableTextFor(payload);
    },
  };
}

export interface CreateCompanyModuleOptions {
  /**
   * Override the connector list. Defaults to `[defaultKvkConnector]`.
   * Tests inject a stub connector (with a fake `fetch`) so the
   * registered module never touches the real KvK API.
   */
  readonly connectors?: readonly EntityConnector<CompanyPayload>[];
  /**
   * Override the enrichment-job list. Defaults to
   * `companyEnrichmentJobs` (summary + fillFields). Tests inject
   * deterministic stubs to assert runner behavior without driving a
   * real LLM client.
   */
  readonly enrichmentJobs?: readonly EnrichmentJob<CompanyPayload>[];
}

export const companyModule: EntityModule<CompanyPayload> = createCompanyModule();

function searchableTextFor(payload: CompanyPayload): string {
  const parts: string[] = [];
  if (payload.legalName !== undefined) parts.push(payload.legalName);
  if (payload.tradeName !== undefined) parts.push(payload.tradeName);
  if (payload.kvkNumber !== undefined) parts.push(payload.kvkNumber);
  if (payload.website !== undefined) parts.push(payload.website);
  if (payload.address?.city !== undefined) parts.push(payload.address.city);
  if (payload.industry !== undefined) parts.push(payload.industry);
  if (payload.description !== undefined) parts.push(payload.description);
  // Lowercase the digest because the §4.0 store's `searchSummaries`
  // lowercases the query before substring-matching. Keeping both sides
  // lowercase is what makes "rotterdam" find a row with
  // `city: 'Rotterdam'`.
  return parts.join(' ').toLowerCase();
}
