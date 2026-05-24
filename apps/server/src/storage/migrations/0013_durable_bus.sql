-- Phase 5.1 — durable SQLite-backed message bus.
--
-- Second half of the phase-5 storage layer. Companion migration
-- 0012_scheduled_tasks.sql (phase 5.0) added the scheduled-task
-- definition + run-history tables. This migration adds the three
-- tables the `DurableSqliteMessageBus` needs to ship the bus as a
-- crash-safe, claim-based, cross-process transport (per ADR 0019,
-- landing in phase 5.7):
--
--   - `bus_outbox`   : the delivery ledger. One row per published
--                      event. The canonical event log lives in
--                      the existing `events` table (see migration
--                      0001_init.sql); the outbox is purely about
--                      "has every subscriber processed this row?".
--                      `publish()` writes to BOTH tables in the
--                      same SQLite transaction so a crash between
--                      the two writes is impossible.
--   - `bus_offsets`  : per-subscriber "last delivered id" pointer.
--                      Each subscriber (identified by a stable
--                      `subscriber_key` configured at bus
--                      construction time) keeps its own offset so
--                      a slow subscriber cannot block a fast one.
--   - `bus_dlq`      : dead-letter queue. One row per
--                      (subscriber_key, outbox_id) pair where the
--                      handler failed past `maxAttempts`. The
--                      admin DLQ page (phase 5.4) reads from here.
--
-- Outbox lifecycle:
--
--   pending      -- freshly published, ready to claim
--   in_flight    -- claimed by a consumer, handler running
--   delivered    -- handler returned without throwing
--   dead         -- failed past `maxAttempts`, see matching
--                   `bus_dlq` row for error history
--   abandoned    -- consumer process died while `in_flight`, and
--                   the subscriber declared itself NOT idempotent,
--                   so we will not redeliver automatically
--
-- Forward-only. Postgres-portable: TEXT primary keys, ISO
-- timestamps, no SQLite-only SQL. Mirrors the rules in ADR 0002.

CREATE TABLE bus_outbox (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  metadata_json   TEXT,
  correlation_id  TEXT,
  flow_id         TEXT,
  occurred_at     TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN
                     ('pending','in_flight','delivered','dead','abandoned')),
  attempt         INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  claimed_at      TEXT,
  claimed_by_pid  INTEGER,
  delivered_at    TEXT,
  error           TEXT
);

-- Hot path: "what's still to deliver?". Filtered partial index keeps
-- the index hot even after millions of `delivered` rows accumulate
-- (the prune job that will drop those ships in phase 5.5 as
-- `bus.outbox.prune`).
CREATE INDEX idx_bus_outbox_pending
  ON bus_outbox(status, occurred_at)
  WHERE status IN ('pending','in_flight');

CREATE TABLE bus_offsets (
  subscriber_key  TEXT PRIMARY KEY,
  last_id         TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE bus_dlq (
  id              TEXT PRIMARY KEY,
  outbox_id       TEXT NOT NULL REFERENCES bus_outbox(id),
  subscriber_key  TEXT NOT NULL,
  error           TEXT NOT NULL,
  attempts        INTEGER NOT NULL CHECK (attempts > 0),
  failed_at       TEXT NOT NULL
);

CREATE INDEX idx_bus_dlq_subscriber
  ON bus_dlq(subscriber_key, failed_at DESC);
