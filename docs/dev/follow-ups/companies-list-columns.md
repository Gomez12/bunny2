# Follow-up — Companies list page: richer columns + enrichment badge

- Status: open
- Created: 2026-05-24 (phase 4a.5 close-out)
- Phases referencing it: 4a.5 (gap acknowledged at sub-phase close-out)

## What remains

The phase-4a.5 spec asks the companies list page to show these
columns:

- title
- kvkNumber
- website
- city (from `payload.address.city`)
- updated_at (relative time)
- enrichment status badge

The §4.0 generic list endpoint `GET /l/:slug/<kind>` returns
`EntitySummary[]` only — `{id, kind, layerId, slug, title, subtitle,
searchableText, meta}`. `subtitle` is the `companyModule.subtitle`
projection (KvK number first, website second), so KvK / website
information surfaces compactly there. **But**:

- `payload.address.city` is NOT on the summary. There is no way for
  the web client to render a "City" column without a per-row detail
  fetch (N+1 — unacceptable) or a server-side projection extension.
- "Enrichment status" is a derived signal — today there is no per-row
  field that surfaces "this row was recently enriched / is being
  enriched / failed enrichment". The 4a.4 widget computes a per-layer
  aggregate via `entity_souls.updated_at`, but the list endpoint does
  not project a comparable per-row flag.
- The `meta.updatedAt` value is an ISO timestamp; the spec asks for
  relative time rendering ("2 hours ago"). The web app has no
  relative-time formatter wired in.

Per the advisor consult on 4a.5, the list page therefore ships with
the columns the summary actually contains: `title`, `subtitle`
(KvK-or-website), `meta.updatedAt` (ISO). The "City" and "Enrichment
status" columns are deferred to this follow-up.

## Why not done now

- **No new server endpoints** is an explicit phase-4a.5 constraint.
- **No new foundation extensions** is an explicit phase-4a.5
  constraint. Projecting `address.city` onto every entity kind would
  touch the §4.0 contract.
- Adding a per-summary-row projection for `address.city` is
  companies-specific — that argues for an `EntityModule`-level
  "summary columns" extension, which is its own design decision and
  out of 4a.5 scope.

## Next step

Pick one of:

1. Extend `EntityModule<P>` with an optional `summaryColumns?: readonly
EntitySummaryColumn<P>[]` (mirrors the 4a.1 `indexedColumns` slot).
   The generic store projects them into the summary row. Companies
   declares `city` and a small enrichment flag. Calendar / contacts
   declare their own when 4b.5 / 4c.5 land.

2. Or accept the current `title + subtitle + updatedAt` shape as the
   long-term list contract and surface the rest via filters /
   per-row chips fed by the detail endpoint.

A `(2)` decision keeps the contract minimal but limits the list page
forever. A `(1)` decision is what 4a.4 already did for stats and is
the more likely direction.

Also: wire a relative-time formatter into the web app (Intl
`RelativeTimeFormat`) and use it on `meta.updatedAt` everywhere.

## Related files / docs

- `apps/web/src/pages/CompaniesListPage.tsx` — current shipping list
  page that renders `title / subtitle / meta.updatedAt`.
- `apps/server/src/entities/store.ts` — `EntitySummary` projection
  builder.
- `apps/server/src/entities/companies/module.ts` — where a future
  `summaryColumns` declaration would live.
- `docs/dev/architecture/entities.md` §10a — companies module shape.
- `docs/dev/plans/phase-04-first-entities.md` §14 — 4a.5 close-out.
