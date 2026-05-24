# Follow-up — `EntityConnector.ingest` delete semantics

- Status: open
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
