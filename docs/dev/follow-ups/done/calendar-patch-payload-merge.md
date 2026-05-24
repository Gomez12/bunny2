# Follow-up — PATCH wipes runner-owned calendar payload fields

## What remains

`PATCH /l/:slug/calendar_event/:entitySlug` wholesale-replaces the
stored payload with whatever the client sent. The handler in
`apps/server/src/entities/router.ts` calls
`module.payloadSchema.safeParse(body.payload)` and passes the parsed
value straight into `store.update({ payload })` — no merge, no
preservation of unspecified fields.

`CalendarEventPayloadSchema` makes `meetingSummaryNote` optional, so a
UI-style partial PATCH that omits the field silently wipes the
AI-generated summary. The 4c.3 enrichment runner declares
`enrichmentOverwriteFields: ['attendees', 'meetingSummaryNote']` so it
will eventually re-fill the field, but the next user save before the
runner ticks will appear to "lose" the AI work.

The 4c.6 smoke step 14.8 pre-asserts this exact behaviour with a
comment pointing at this follow-up.

## Why not done now

Fixing the merge semantics is a router-level contract change that
affects every entity kind, not just calendar. The proper fix is a
single piece of logic — load the existing payload, merge the request
into it, validate the merged result — but it has knock-on effects:

- vCard ingest currently relies on `store.update(...)` being able to
  replace the full payload. The dispatcher would still call
  `store.update` directly (no merge), only the HTTP PATCH path would
  merge.
- The companies / contacts PATCH endpoints work today because their
  schemas have no runner-owned fields with the same wipe failure mode
  (companies' `description` is allowed to be overwritten by the
  runner; contacts has no runner-owned writable field).
- The "merge" rule needs a clear answer for arrays: does PATCH
  `attendees: [...]` replace the whole array, or merge per-attendee by
  `value`? The 4c.5 detail page editor sends the full array, so the
  current "replace" semantics are right for it. Merging only the
  fields whose key is absent from the request body is the safest
  default.

4c.6 is scoped to smoke + i18n + close-out; the merge fix belongs in
its own commit so the contract change can be reviewed against every
entity kind.

## Next step

1. Add a router-level helper `mergeWithExistingPayload(existing,
incoming)` that takes the existing payload and replaces only the
   keys present in `incoming`. Keep top-level wholesale-replace for
   array fields (so PATCH `attendees: [...]` still replaces the
   array; PATCH without the key preserves the stored attendees).
2. Apply the helper in `apps/server/src/entities/router.ts` PATCH
   handler before `module.payloadSchema.safeParse(...)`.
3. Update the 4c.6 smoke step 14.8 to assert
   `.not.toBeUndefined()` on `meetingSummaryNote`.
4. Confirm no other test relies on the wholesale-replace behaviour
   (the contract suite's PATCH assertions check version bump and
   payload round-trip; both stay green if the incoming body is the
   full payload).

## Related files or docs

- `apps/server/src/entities/router.ts` — the PATCH handler.
- `packages/shared/src/calendar.ts` — `meetingSummaryNote` schema.
- `apps/server/src/entities/calendar/enrichment.ts` — the runner
  owner.
- `apps/server/tests/smoke.test.ts` step 14.8 — the documenting
  assertion.

## Status

done

## Resolution (2026-05-24)

Fixed in the router-level PATCH handler
(`apps/server/src/entities/router.ts`). The handler now builds
`merged = { ...existingPayload, ...incomingPayload }` at the
top-level key layer using the existing entity already loaded for the
not-found check, validates the merged result with
`module.payloadSchema.safeParse(...)`, and passes `parsed.data` to
`store.update`. Top-level wholesale-replace per key — no deep merge,
no per-array merge. Keys absent from the body preserve the stored
value; keys present in the body replace the stored value verbatim.

The contract suite
(`apps/server/tests/entity-contract/suite.ts`) gained a regression
test "PATCH preserves payload keys not present in the request body"
that mounts the real `mountEntityRoutes` against the per-kind fixture
and asserts the merge invariant. Companies, contacts, calendar, and
the fixture module all inherit the assertion through the existing
`runEntityContractSuite(...)` wiring.

The 4c.6 smoke step 14.8 flipped from `.toBeUndefined()` to
`.not.toBeUndefined()` and now also asserts the preserved
`meetingSummaryNote` equals the runner-written value captured before
the PATCH.

The vCard ingest dispatcher
(`apps/server/src/entities/connector-dispatcher.ts`) keeps calling
`store.update` directly — wholesale-replace stays the contract at the
store layer; only the HTTP PATCH path merges.

Schemas use `.optional()` (not `.nullable()`), so explicit `null` to
clear an optional field is not yet supported on any kind. The
"send null to clear" convention is the v1 escape hatch when a schema
later accepts null; no `$delete` sentinel was introduced.
