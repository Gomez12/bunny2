# Follow-up — Calendar list `?from=&to=` server-side range filter

- Status: open
- Created: 2026-05-24 (phase 4c.5 close-out)
- Phases referencing it: 4c.5

## What remains

The calendar grid page (`apps/web/src/pages/CalendarPage.tsx`) currently
fetches the full layer summary list via `GET /l/:slug/calendar_event`
and then re-fetches every event individually to obtain the typed
payload (`startsAt`, `endsAt`, `allDay`, etc.). The §4.0 router does
not expose a `?from=&to=` query, and the `EntitySummary.subtitle`
projection only embeds a string approximation of `startsAt`, which is
not parseable enough to drive the grid.

For layers with hundreds of events this introduces an N+1 round-trip
on every grid view change. Phase 4c.5 explicitly deferred the
server-side filter ("`A ?from=&to=` server-side filter is a follow-up;
do NOT add the filter route in 4c.5").

## Why not done now

- 4c.5 is the first sub-phase that surfaces the gap. Without a real
  layer in the field carrying hundreds of events the cost is
  invisible.
- The §4.0 router takes a single contract; landing a query parameter
  needs a coordinated change across `mountEntityRoutes`, the
  `EntityStore.listSummaries(...)` repo helper, and the per-kind
  modules that want to opt in.

## Next step

Two paths to consider when this lands:

1. **Generic `?from=&to=`** on `EntityStore.listSummaries` driven by a
   per-kind `EntityModule.timeColumn?: string` declaration. Modules
   that opt in (calendar's `starts_at`) project to that indexed
   column; the rest of the contract is unchanged.
2. **Per-kind override** — calendar exposes its own
   `GET /l/:slug/calendar_event/_range?from=&to=` (sibling of
   `/_stats`) rather than threading the parameter through the generic
   router.

The 4a.5 close-out's `summaryColumns?` discussion is in the same
neighbourhood — both are candidates for the next foundation extension
slot.

## Related files / docs

- `apps/server/src/entities/router.ts`
- `apps/server/src/entities/store.ts`
- `apps/web/src/pages/CalendarPage.tsx`
- `docs/dev/plans/phase-04-first-entities.md` §4c.5 close-out
