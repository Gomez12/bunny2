# Follow-up — Promote `<EntityExternalLinks>` to a fully shared component (incl. Companies)

- Status: open
- Created: 2026-05-25
- Created by: Phase 3 of `docs/dev/plans/ui-exposure-gaps.md`
- Phases referencing it: ui-exposure-gaps Phase 3 (origin)

## What remains

Migrate the Companies external-link block in
`apps/web/src/pages/CompanyDetailPage.tsx` onto the new
`apps/web/src/components/EntityExternalLinks.tsx` so all five entity
kinds share one renderer + one analytics + one telemetry call site.

The migration also subsumes the Companies-specific
`addCompanyExternalLink` / `removeCompanyExternalLink` helpers into the
generic `addEntityExternalLink` / `removeEntityExternalLink` pair
already introduced in Phase 3 (`apps/web/src/lib/api.ts`).

## Why not done now

Plan §2 non-goals: "do NOT extract a fully shared component as part of
this plan; copy faithfully and note the duplication in a follow-up."
Companies has one notable divergence from the four other kinds — a KvK-
specific input variant (8-digit numeric validation, single-field form,
KvK-only `connector: 'kvk'` literal) plus a "Refresh status" button
that re-polls without a full refresh. Folding those into the shared
component is a Normal Change of its own.

## What is identical across the five kinds today

After Phase 3 shipped the shared component for contact / calendar_event
/ todo / whiteboard, the following is identical between Companies and
the four new kinds:

| Concern                                                                | Same / different     |
| ---------------------------------------------------------------------- | -------------------- |
| Card chrome (`<Card>` + `<CardHeader>` + `<CardTitle>`)                | Same                 |
| Empty state copy structure (per-kind text in i18n, same shape)         | Same                 |
| Link row layout (label · sync badge · refresh + remove buttons)        | Same                 |
| Sync-state badge (`idle` / `syncing` / `error`)                        | Same (per-kind copy) |
| Remove flow (single `linkId`, optimistic pending state, toast)         | Same                 |
| Telemetry placeholder pattern (`[entity.<kind>.external-link.<verb>]`) | Same                 |
| Analytics events (`entity_external_link_added` / `_removed`)           | Same                 |
| Authz surface (UI piggybacks on `current.canEdit`)                     | Same                 |

## What is different (the actual extraction work)

| Concern              | Companies                                                                                                                                | Other four                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Add form             | Single 8-digit numeric field labelled "KvK number"; submit button "Link KvK"; client-side `^\d{8}$` regex; hard-coded `connector: 'kvk'` | Two fields (connector + external id); free-form add CTA         |
| Validation error key | `errors.entity.companies.kvkInvalid`                                                                                                     | `errors.entity.<ns>.externalLink{Connector,ExternalId}Required` |
| Refresh button       | Per-row "Refresh status" that re-polls the detail to surface the connector's async `sync_state` transition                               | Per-row "Refresh" wired to the parent `onChanged()`             |

## Next step

1. Add a `variant: 'free-form' | 'kvk'` prop (or compose two thin
   wrappers — `<EntityExternalLinksFreeForm>` + `<EntityExternalLinksKvk>`)
   to `EntityExternalLinks.tsx`.
2. Migrate `CompanyDetailPage.tsx` to consume the shared component.
3. Delete `addCompanyExternalLink` / `removeCompanyExternalLink` and
   the Companies-specific KvK i18n keys / state in
   `companies-page-state.ts::linkSyncStateBadgeKey` once nothing
   imports them.
4. Update `docs/dev/observability/analytics.md` call-sites table.
5. Run `bun run i18n:check` — Companies external-link keys
   (`entity.companies.externalLinksTitle`, `externalLinksEmpty`,
   `linkKvkNumberLabel`, `linkKvkAdd`, `linkConnectorLabel`,
   `linkRemove`, `linkAdded`, `linkRemoved`, `linkSyncIdle`/Syncing/Error,
   `linkSyncRefresh`) become unused; either delete from `en.json` +
   `nl.json` (preferred) or document the deprecation.

## Related files

- `apps/web/src/components/EntityExternalLinks.tsx`
- `apps/web/src/lib/entity-external-links.ts`
- `apps/web/src/lib/api.ts` (the existing Companies helpers + the new
  generic pair)
- `apps/web/src/pages/CompanyDetailPage.tsx`
- `apps/web/src/pages/companies-page-state.ts`
- `apps/web/src/i18n/locales/en.json` / `nl.json`
- `docs/dev/plans/ui-exposure-gaps.md` (Phase 3 origin)

## Status

open
