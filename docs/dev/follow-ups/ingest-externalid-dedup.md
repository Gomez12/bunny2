# Follow-up — Ingest dispatcher does not auto-write `entity_external_links`

## What remains

`ConnectorDispatcher.ingest(...)` resolves dedup against
`entity_external_links` for `matchKey.kind === 'externalId'` (see
`findExistingByMatchKey` in
`apps/server/src/entities/connector-dispatcher.ts`). But the dispatcher
does NOT insert a row into `entity_external_links` when it creates a
fresh entity from an ingest payload. The result: the first ingest
always creates, the second ingest cannot match the externalId of any
row, and the second ingest also creates duplicates.

The 4b.2 vCard contract works around this because it uses
`matchKey.kind === 'email'`, which resolves against the per-kind
`primary_email` indexed column — not `entity_external_links`. The
Google Calendar connector (4c.2) emits
`matchKey: { kind: 'externalId', value: googleEventId }`, so it does
hit this gap.

The 4c.6 smoke step 14.4 documents the gap by manually inserting
external-link rows between the first and second ingest call to make
the dedup assertion exercise the intended contract.

## Why not done now

4c.6 is scoped to smoke + i18n + close-out. Fixing the dispatcher to
auto-write `entity_external_links` is a contract change with three
unanswered design questions:

1. The connector's `ConnectorIngestEntity.externalId` field is the
   natural source for the link's `external_id` column. Today it is
   optional (`externalId?: string`) and unused; the dispatcher should
   require it whenever `matchKey.kind === 'externalId'`. Touching the
   interface needs the same "5 foundation extensions" treatment as
   `EntityConnector.ingest` (4b.2).
2. What goes into `payload_json` on the new link row? Empty `{}` is
   safe (the connector can stamp its own metadata via a future
   `onLinkCreate` hook, mirroring 4a.3's `onPayloadPatch`).
3. The link's `connector` column should be the same `connectorId` the
   dispatcher resolved — no ambiguity.

## Next step

1. Tighten the contract: when `matchKey.kind === 'externalId'`,
   `ConnectorIngestEntity.externalId` must be set.
2. Make the dispatcher insert a row into `entity_external_links`
   immediately after a successful `store.create` from ingest,
   mirroring the 4c.2 pull path which already creates the link via
   `POST /external-links` before publishing `sync.requested`.
3. Drop the manual back-fill in the 4c.6 smoke step 14.4 and switch
   the assertion to expect `{ created: 0, updated: 3 }` directly.

## Related files or docs

- `apps/server/src/entities/connector-dispatcher.ts` — the ingest
  path that needs the new write.
- `apps/server/src/entities/connectors/base.ts` — the
  `ConnectorIngestEntity` interface that needs the tightening.
- `apps/server/src/entities/calendar/google-connector.ts` — the
  first consumer that benefits.
- `apps/server/tests/smoke.test.ts` step 14.4 — the documenting
  workaround.

## Status

open
