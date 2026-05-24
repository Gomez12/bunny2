-- Phase 4d.1 — `todos` per-kind table.
--
-- Fourth concrete consumer of the §4.0 entity-contract foundation.
-- Mirrors the §5 "per-kind table shape" exactly (id, layer_id, slug,
-- title, searchable_text, original_locale, payload_json, audit
-- columns, version) and adds the todo-specific indexed columns:
--
--   - `status`             : TEXT NOT NULL DEFAULT 'open'. Enum-shaped
--                            string with five values: 'open',
--                            'in_progress', 'blocked', 'done',
--                            'cancelled'. Load-bearing for the 4d.5
--                            kanban grouping and the 4d.4 "open
--                            todos" widget count. The zod
--                            `TodoStatusSchema` is the single source
--                            of truth — SQL stores the projection.
--   - `priority`           : INTEGER NOT NULL DEFAULT 3. 1 (highest)
--                            through 5 (lowest); 3 = "normal". Second
--                            non-TEXT indexed projection (after
--                            calendar's `all_day` in 4c.1). Used by
--                            the future 4d.4 "high priority open"
--                            widget.
--   - `due_at`             : nullable TEXT. ISO-8601 timestamp OR
--                            date-only (`YYYY-MM-DD`). The zod
--                            payload accepts both shapes; the SQL
--                            layer stores them verbatim (sortable on
--                            either shape — ISO is sortable
--                            lexicographically and `YYYY-MM-DD` is a
--                            prefix of the ISO timestamp form).
--                            Load-bearing for "due today / due this
--                            week" queries (4d.4 widget) and the
--                            4d.6 calendar projection subscriber.
--   - `linked_entity_id`   : nullable TEXT. Soft FK to a contact or
--                            company in the same layer; the kind
--                            sits next to it. The zod
--                            `linkedEntityRef` field is the canonical
--                            home for the (kind, id) pair; the
--                            indexed columns mirror it so a future
--                            "todos linked to this contact" reverse
--                            lookup (4d.5) stays an indexed seek.
--   - `linked_entity_kind` : nullable TEXT. Matches `linked_entity_id`
--                            via the CHECK below: either both set or
--                            both null. Sparse-indexed alongside
--                            `linked_entity_id`.
--
-- The CHECK constraint enforces the "both or neither" invariant at the
-- SQL layer so a stray indexed-column projection (e.g. a bug in the
-- module's `extract` callback writing only one side) is caught at
-- write time. The migrations test exercises the CHECK with an
-- INSERT probe, mirroring the 0007 connector-kind probe.
--
-- Forward-only. Postgres-portable: TEXT UUIDs, ISO timestamps, no
-- SQLite-only SQL. Mirrors the rules in ADR 0002.

CREATE TABLE todos (
  id                  TEXT PRIMARY KEY,
  layer_id            TEXT NOT NULL REFERENCES layers(id),
  slug                TEXT NOT NULL,
  title               TEXT NOT NULL,
  searchable_text     TEXT NOT NULL,
  original_locale     TEXT NOT NULL,
  payload_json        TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  created_by          TEXT NOT NULL REFERENCES users(id),
  updated_at          TEXT NOT NULL,
  updated_by          TEXT NOT NULL REFERENCES users(id),
  deleted_at          TEXT,
  deleted_by          TEXT REFERENCES users(id),
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  -- Todo-specific indexed columns.
  status              TEXT    NOT NULL DEFAULT 'open',
  priority            INTEGER NOT NULL DEFAULT 3,
  due_at              TEXT,
  linked_entity_id    TEXT,
  linked_entity_kind  TEXT,
  UNIQUE (layer_id, slug),
  CHECK (
    (linked_entity_id IS NULL AND linked_entity_kind IS NULL)
    OR
    (linked_entity_id IS NOT NULL AND linked_entity_kind IS NOT NULL)
  )
);

CREATE INDEX idx_todos_layer        ON todos(layer_id);
CREATE INDEX idx_todos_deleted_at   ON todos(deleted_at);
CREATE INDEX idx_todos_status       ON todos(status);
CREATE INDEX idx_todos_due_at       ON todos(due_at);
CREATE INDEX idx_todos_priority     ON todos(priority);
CREATE INDEX idx_todos_linked       ON todos(linked_entity_id);
