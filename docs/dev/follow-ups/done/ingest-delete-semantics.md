# Follow-up — `EntityConnector.ingest` delete semantics

- Status: done
- Created: 2026-05-24 (phase 4c.2 close-out)
- Phases referencing it: 4c.2

## What remains

The phase-4b.2 `EntityConnector.ingest` contract has create + update
paths only. The dispatcher's `findExistingByMatchKey` either inserts via
`store.create` or updates via `store.update` — there is no path that
soft-deletes a row in response to an upstream delete.

Google Calendar's bulk-sync surfaces deleted events as
`status: 'cancelled'`. The phase-4c.2 connector currently swallows them
into the `warnings[]` array (one warning per cancelled id) and lets
operators see them. That is acceptable as a stop-gap but is NOT correct
behavior — a calendar row whose Google twin has been deleted should
soft-delete locally too.

## Why not done now

Adding a soft-delete result type to `ConnectorIngestResult` is a
foundation change that touches:

- `apps/server/src/entities/connectors/base.ts` (new
  `ConnectorIngestDelete` variant or a `deleted: string[]` field).
- `apps/server/src/entities/connector-dispatcher.ts` (new path that
  resolves the existing entity by `matchKey` and calls
  `store.softDelete`).
- The vCard import test surface — needs to confirm it still passes
  unchanged.
- A contract test in the §4.0 reusable suite asserting the new path.

Phase 4c.2's "one focused commit" budget did not have room for that
expansion. Calling out the deferral here keeps the gap honest.

## Next step

When 4c.3 (calendar enrichment) lands — likely the next time a
calendar developer is in the code — extend the ingest contract:

```ts
interface ConnectorIngestResult<P> {
  entities: ReadonlyArray<ConnectorIngestEntity<P>>;
  deletes: ReadonlyArray<{ matchKey: ConnectorIngestMatchKey }>;
  warnings: readonly string[];
}
```

Dispatcher applies each `delete` via `store.softDelete` after the
create / update loop. Google Calendar connector emits
`{ matchKey: { kind: 'externalId', value: id } }` for every
`status='cancelled'` event instead of a warning. Test the round-trip
in both `calendar-google-connector.test.ts` AND a §4.0 contract test.

## Related files / docs

- `apps/server/src/entities/connector-dispatcher.ts` (lines 415-446)
- `apps/server/src/entities/calendar/google-connector.ts` (cancelled
  events → warnings)
- `docs/dev/decisions/0014-connector-ingest.md`
- `docs/dev/decisions/0016-google-calendar-connector.md` (§MVP scope)

## Resolution

Closed by extending the ingest contract with a `deletes?:
ReadonlyArray<ConnectorIngestDelete>` field on
`ConnectorIngestResult`. `ConnectorIngestDelete` carries the same
`ConnectorIngestMatchKey` discriminated union used by
`entities[].matchKey`, so the dispatcher resolves a delete the same
way it resolves a create / update.

`apps/server/src/entities/connector-dispatcher.ts` walks
`result.deletes ?? []` after the create / update loop. For each
entry it calls `findExistingByMatchKey` against the per-kind table;
when a row is found it calls `store.softDelete` (which emits the
normal `entity.<kind>.deleted` event the per-entity subscribers
already see). When no row is found it logs a structured warning
(`event: 'connector.ingest.deleteMissed'`) and skips — a missed
delete is not a failure (the upstream may be removing a record the
local layer never imported). Successful soft-deletes also log
structurally (`event: 'connector.ingest.softDeleted'`). The
dispatcher does NOT remove the `entity_external_links` row on the
delete path — the link is the dedup index and link auto-cleanup is a
separate concern.

`apps/server/src/entities/calendar/google-connector.ts` now emits
`deletes: [{ matchKey: { kind: 'externalId', value: id } }]` for
every `status === 'cancelled'` event in the `events.list` window.
The genuinely unparseable cases keep using `warnings[]`. The
`CancelledIgnored` error-key constant and its
`errors.connectors.google.calendar.cancelledIgnored` i18n entries
(en + nl) became dead and were removed.

`deletes` is OPTIONAL on the result type — connectors that never
emit deletes (vCard) can omit the field entirely; the dispatcher
normalises a missing `deletes` to `[]`. This avoids forcing every
connector to spell `deletes: []`.

Tests added in
`apps/server/tests/entities/calendar-google-connector.test.ts`:

- The existing "list with confirmed, recurring, and cancelled
  events" test now asserts the cancelled event is emitted as a
  delete (no warning surfaces; the dispatcher logs a
  `deleteMissed` because no local row matches in that fixture).
- A new test `soft-deletes the matched local row when an upstream
  event is cancelled, preserving the link row` exercises the
  round-trip: first ingest creates the row + link, second ingest
  returns the same id as `cancelled`, and the entity's `deleted_at`
  column is set while the `entity_external_links` row is preserved.
  An `entity.calendar_event.deleted` event is observed on the bus.

The vCard test surface (`contacts-vcard-connector.test.ts`,
`contacts-vcard-parser.test.ts`) continues to pass unchanged —
vCard's `ingest` returns `{ entities, warnings }` without a
`deletes` field; the dispatcher normalises that to an empty array.

ADR 0014 §3 + §4 updated to document the `deletes` field. ADR 0016
§MVP scope's "Cancelled events are warnings, not deletes" line
updated to reflect the new behaviour.
