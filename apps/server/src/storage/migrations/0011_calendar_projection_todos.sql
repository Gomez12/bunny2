-- Phase 4d.6 — todo → calendar projection bridge.
--
-- The §4.1 phase-4 plan describes a subscriber-driven projection:
-- whenever a todo's `due_at` is non-null, a read-only entry should
-- appear on the calendar UI. The projection is a **derived index**,
-- not a duplicate source of truth — the canonical row lives in
-- `todos` and the projection is rebuilt on every relevant bus
-- event (and on boot via `rebuild()` to recover from missed events).
--
-- The table sits OUTSIDE the `entity_*` namespace because it's NOT
-- an entity kind. There is no entity router mounted on it, no
-- versioning, no translation table — it's a flat materialized view
-- the calendar UI fetches as a sibling list alongside real events.
-- Editing happens on the source todo; clicking a projection in the
-- calendar UI navigates to `/l/:slug/todos/:slug`.
--
-- Schema notes:
--   - `todo_id` is the primary key — one-to-one with the source todo.
--     Soft-delete of the todo causes the bridge to delete this row;
--     it is NOT cascaded by the DB because the bridge holds the
--     mutation discipline (the bus event is the trigger). We keep
--     the FK as documentation; SQLite enforces it at write time.
--   - `due_at NOT NULL` — the projection only exists when the source
--     todo has a `dueAt`. When `dueAt` becomes null the bridge
--     deletes the row.
--   - `layer_id` is denormalized so the calendar list endpoint can
--     answer "give me all projections for THIS layer" with a single
--     indexed scan, without joining `todos` (which would add a row
--     even when the todo is in a different layer in a multi-tenant
--     future).
--   - `todo_slug` is denormalized so the UI can deep-link to
--     `/l/:slug/todos/:slug` without re-fetching the todo. The slug
--     is stable within a layer (the §4.0 store enforces it).
--   - `priority`, `status` denormalized so the calendar UI can badge
--     the projection event ("blocked", "high priority") without a
--     second fetch.
--   - `updated_at` is the bridge's write timestamp, used by the
--     `rebuild()` smoke pass to verify rebuilds touch every row.
--
-- Indexes:
--   - `idx_calendar_projection_todos_layer` — supports the list
--     endpoint at `GET /l/:slug/calendar/_projections/todos`.
--   - `idx_calendar_projection_todos_due_at` — supports future
--     range-filtered queries (a calendar UI fetching "due in this
--     week" — phase-5 enhancement).
--
-- Forward-only. Postgres-portable: TEXT primary keys, ISO
-- timestamps, no SQLite-only SQL. Mirrors the rules in ADR 0002.

CREATE TABLE calendar_projection_todos (
  todo_id     TEXT PRIMARY KEY REFERENCES todos(id),
  layer_id    TEXT NOT NULL REFERENCES layers(id),
  todo_slug   TEXT NOT NULL,
  title       TEXT NOT NULL,
  due_at      TEXT NOT NULL,
  priority    INTEGER NOT NULL,
  status      TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX idx_calendar_projection_todos_layer
  ON calendar_projection_todos(layer_id);

CREATE INDEX idx_calendar_projection_todos_due_at
  ON calendar_projection_todos(due_at);
