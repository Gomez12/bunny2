# ADR 0017 — Todo → calendar projection: stored subscriber-driven projection, separate read endpoint, boot-time rebuild

- Status: accepted
- Date: 2026-05-24
- Phase: 4 (4d.6 — cross-entity bridge on top of the §4.0 entity contract and the 4d.1 todos kind)
- Related: `docs/dev/plans/phase-04-first-entities.md` §4.1 4d.6, §4.3 Q3;
  ADR [`0011`](./0011-entity-contract.md) — entity contract;
  `apps/server/src/storage/migrations/0011_calendar_projection_todos.sql`;
  `apps/server/src/entities/todos/calendar-projection.ts`;
  `apps/server/src/entities/todos/calendar-projection-routes.ts`;
  `apps/web/src/pages/calendar-page-state.ts` (`mapTodoProjectionsToCalendarItems` + `mergeCalendarFeed`).

---

## Context

The phase-4 plan calls for a **cross-entity bridge**: a todo with a
non-null `dueAt` should appear on the calendar UI as a read-only
event. The user demo for phase 4 is "create a todo due Friday, then
switch to the calendar and see it on Friday" (§1 of the plan). The
calendar surface must keep the projection clearly distinct from a
real calendar event so the user does not try to drag-edit it on the
grid.

§4.3 Q3 of the plan settled the high-level shape: **projection via
subscriber, read-only on the calendar, no duplicate storage** — the
canonical row stays in `todos`, and the projection is a derived view
the bridge maintains.

This ADR records the three smaller decisions that follow from that
shape but are not obvious from the plan alone.

---

## Decisions

### 1. Stored projection (materialized table), NOT a bus-event-only stream and NOT a query-time join

Three implementations were on the table:

- **Bus-event-only stream.** The subscriber re-publishes a
  `calendar.projection.todo.*` event the UI consumes via SSE. Pure
  event stream, no DB writes. Survives nothing — a cold reload of
  the calendar grid sees no projections until each todo updates
  again.
- **Stored projection (this ADR).** The subscriber maintains
  `calendar_projection_todos`. Survives reloads, integrates with the
  phase-6 chat retrieval surface (a "what's on Friday?" question can
  hit one materialized table), and keeps the SQL simple.
- **Query-time join.** The calendar list endpoint UNIONs `todos
WHERE due_at IS NOT NULL` with `calendar_events` on every call. No
  subscriber, no projection table. Lower code path; higher latency
  on every calendar load.

The plan's wording — "emit a read-only `calendar.projection.todo`
row" — strongly implies a stored row. The phase-6 chat retrieval
case (the agent enumerates one projection table instead of joining
two) is the decisive long-term win. The "no duplicate storage" rule
is honored because the projection is a **derived index**: the only
source of truth is `todos`, and the bridge wipes the projection row
the moment the todo is soft-deleted or its `dueAt` is cleared.

### 2. Separate read endpoint at `/calendar/_projections/todos`, NOT a discriminator on the existing calendar event list

Two options:

- **A — extend the existing list endpoint.** `GET
/l/:slug/calendar_event` would return real events alongside
  projections, each carrying a `kind` discriminator. Saves one fetch
  on the UI side; pollutes the real entity surface with cross-entity
  data.
- **B — separate endpoint** (this ADR). `GET
/l/:slug/calendar/_projections/todos` returns only the projection
  rows. The UI fetches both endpoints in parallel and merges
  client-side via `mergeCalendarFeed(...)`.

Option B keeps every entity route clean of cross-entity concerns.
Real `calendar_event` rows have a connector, an enrichment job, a
detail page, soft-delete + restore — none of which projection rows
have. Mixing the two on one HTTP shape would bleed concerns. The
parallel-fetch cost is one extra round-trip; the projection
endpoint is a flat indexed scan and finishes well inside the
calendar event list's request budget.

URL placement under `/calendar/` (not `/todo/`) makes the consumer
visible from the URL: the calendar UI is the only caller. The
underscore prefix (`_projections`) matches the `/_stats` and
`/_ingest` conventions on the §4.0 router — a non-entity subroute
on a kind prefix.

### 3. Boot-time `rebuild()` is the recovery contract

The subscriber processes events. If the server is offline when a
todo is updated (e.g. crash, deploy), the bridge misses the
`entity.todo.updated` event and the projection table drifts.

Three recovery options:

- **Replay the bus event log on boot.** The 4.0 event log is a
  source of truth that already persists every event. Replay would
  pick up every missed mutation. Cost: O(every todo event ever).
- **Listen forever and accept drift.** The bridge eventually
  converges when each todo mutates again. Cost: until then,
  projections are wrong.
- **`rebuild()` on boot** (this ADR). Truncate the projection table
  and re-project every non-deleted todo with a non-null `due_at` via
  one SQL scan. Cost: O(active todos with dueAt).

Rebuild is the simplest correct path. It assumes the source of
truth (`todos`) is correct (which is what the §4.0 store
guarantees) and rebuilds the derived index from scratch. The cost
is bounded by the number of dueAt-bearing todos in the database, NOT
the event log size — orders of magnitude smaller.

Production wiring calls `start()` then `rebuild()` exactly once at
boot. Order does not matter: the rebuild's upserts are idempotent
against any in-flight events the subscriber may also be processing,
because the upsert key is `todo_id`.

---

## Consequences

- The bridge is **subscriber-only on the write side**: it consumes
  `entity.todo.{created,updated,deleted,restored}` and writes only
  to `calendar_projection_todos`. It NEVER publishes
  `entity.todo.*` events back to the bus — a feedback loop would
  be a regression.

- The bridge never reads the bus event payload's `searchableText` or
  `version`. It re-reads the source todo row via direct SQL on every
  trigger because `EntityUpdatedPayload` does not carry the payload.
  This collapses every state transition (dueAt added, dueAt cleared,
  soft-delete, restore) into one read-modify-write path with no diff
  tracking.

- The projection table lives **outside the `entity_*` namespace**.
  It has no version chain, no translation row, no soul. It is a
  flat derived index. The migration name uses the descriptive
  prefix `calendar_projection_todos` instead of an `entity_*` name
  so future readers do not mistake it for an entity kind.

- The calendar UI uses a discriminated `resource.kind` on every grid
  item: `'calendar_event'` for real events, `'todo_projection'` for
  bridge rows. Click handlers branch on the discriminator: real
  events open the calendar event detail page; projections open the
  source todo detail page. The calendar event detail page is NEVER
  reached for projections.

- The HTTP PATCH path on `/l/:slug/todo/:slug` merges top-level
  payload keys (see `docs/dev/follow-ups/done/calendar-patch-payload-merge.md`).
  A client wanting to clear `dueAt` must drop the field via an
  internal `store.update` call, NOT via PATCH. The bridge handles
  both paths identically — it re-reads the current todo row on
  every event.

- The bridge writes idempotently. A second `entity.todo.updated`
  event for the same todo within milliseconds simply rewrites the
  same projection row.

---

## Non-decisions (intentional)

- **No projection of soft-deleted todos.** Restore is supported
  (the bridge re-projects via `entity.todo.restored`), but the
  projection table never holds a "deleted" sentinel — the row is
  physically gone until the todo is restored or its dueAt is
  re-set.

- **No editing on the calendar surface.** Drag-and-drop, inline
  rename, status change — none of these are exposed on the
  calendar grid for projection rows. The user edits the source todo
  via its detail page. The brief is explicit: "the projection is
  read-only on the calendar; the user edits the underlying todo via
  its detail page". No exception.

- **No deep-linking from a todo detail page back to its calendar
  projection.** The bridge is one-way: todo → calendar projection.
  A future quality-of-life improvement could add a "view on
  calendar" affordance on the todo detail page, but it's out of
  4d.6 scope.

- **No cache.** The projection table is the cache. Future range
  queries (a 4d.7+ "due this week" widget) can query the same
  table; the `idx_calendar_projection_todos_due_at` index is in
  place for that.

- **No bus event for projection writes.** The bridge writes
  directly to SQLite without publishing a "projection updated"
  event. Adding one is a phase-6 concern (chat agent
  invalidation); none of the phase-4 surfaces need it.
