-- Phase 4c.1 — `calendar_events` per-kind table.
--
-- Third concrete consumer of the §4.0 entity-contract foundation.
-- Mirrors the §5 "per-kind table shape" exactly (id, layer_id, slug,
-- title, searchable_text, original_locale, payload_json, audit
-- columns, version) and adds the calendar-specific indexed columns:
--
--   - `starts_at`            : ISO-8601 UTC timestamp OR date-only
--                              (`YYYY-MM-DD`) when `payload.allDay`.
--                              NOT NULL — every event must have a
--                              start. Load-bearing index for week /
--                              month views and the dashboard widget's
--                              "next 7 days" query (4c.4).
--   - `ends_at`              : optional end. Nullable for all-day /
--                              zero-duration events; if present, the
--                              zod schema enforces `endsAt >= startsAt`
--                              at the application layer (SQL string
--                              compare on ISO is fine but the
--                              constraint is application-layer per the
--                              4c.1 spec).
--   - `all_day`              : INTEGER 0/1. Note this is the first
--                              non-TEXT indexed column the §4.0
--                              foundation accepts — the
--                              `IndexedValue = string | number | null`
--                              type space already covers it, so 4c.1
--                              needs ZERO foundation tweaks. See
--                              `docs/dev/architecture/entities.md`
--                              §10g for the empirical confirmation.
--   - `rrule_string`         : opaque RRULE string. We store it; v1
--                              does NOT expand recurrence — the web
--                              UI in 4c.5 renders only the master
--                              occurrence. See §2 of
--                              `docs/dev/plans/done/phase-04-first-entities.md`.
--   - `external_calendar_id` : nullable; set by the Google Calendar
--                              connector in 4c.2 so events can be
--                              linked back to their source calendar
--                              even before the connector lands. The
--                              sparse index keeps the column cheap
--                              when most events have no source
--                              calendar.
--
-- Forward-only. Postgres-portable: TEXT UUIDs, ISO timestamps, no
-- SQLite-only SQL. Mirrors the rules in ADR 0002.

CREATE TABLE calendar_events (
  id                   TEXT PRIMARY KEY,
  layer_id             TEXT NOT NULL REFERENCES layers(id),
  slug                 TEXT NOT NULL,
  title                TEXT NOT NULL,
  searchable_text      TEXT NOT NULL,
  original_locale      TEXT NOT NULL,
  payload_json         TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  created_by           TEXT NOT NULL REFERENCES users(id),
  updated_at           TEXT NOT NULL,
  updated_by           TEXT NOT NULL REFERENCES users(id),
  deleted_at           TEXT,
  deleted_by           TEXT REFERENCES users(id),
  version              INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  -- Calendar-specific indexed columns. `starts_at` is NOT NULL because
  -- every event must have a start; the other four are nullable so a
  -- layer can own a draft event (title + starts_at only) before the
  -- 4c.2 connector or the 4c.5 UI fills the remaining fields.
  starts_at            TEXT NOT NULL,
  ends_at              TEXT,
  all_day              INTEGER NOT NULL DEFAULT 0,
  rrule_string         TEXT,
  external_calendar_id TEXT,
  UNIQUE (layer_id, slug)
);

CREATE INDEX idx_calendar_events_layer        ON calendar_events(layer_id);
CREATE INDEX idx_calendar_events_deleted_at   ON calendar_events(deleted_at);
CREATE INDEX idx_calendar_events_starts_at    ON calendar_events(starts_at);
CREATE INDEX idx_calendar_events_external_cal ON calendar_events(external_calendar_id);
