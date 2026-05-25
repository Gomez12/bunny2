-- Phase 6 of `docs/dev/plans/admin-observability-viewer.md` —
-- `analytics_events` durable sink.
--
-- ADR `docs/dev/decisions/0031-analytics-local-sink.md` picks a local
-- SQLite table over PostHog / Plausible so the project's analytics
-- signal lives in the same database as logging (`events`), LLM telemetry
-- (`llm_calls`), and the bus ledger (`bus_outbox`). The shape mirrors
-- the ADR's D1 column list verbatim.
--
-- Column-level redaction (per
-- `docs/dev/audits/admin-observability-redaction-2026-05-25.md`
-- finding 2):
--   - `event_name` must match the closed catalogue documented in
--     `docs/dev/observability/analytics.md`; the ingest endpoint
--     rejects unknown names (ADR 0031 D2).
--   - `properties_json` keys are bounded by the per-event property
--     schema in the same catalogue; the ingest endpoint also rejects
--     unknown keys so the table never carries raw user content.
--   - `user_id` is hashed server-side BEFORE insert (ADR 0031 D3).
--     The raw id never lands on disk for this surface — deliberate
--     asymmetry with `llm_calls.user_id`.
--   - `layer_slug` is the public slug, not the layer UUID — the
--     analytics call sites already pass slugs and surfaces such as a
--     funnel dashboard read slugs naturally.
--
-- Indexes follow plan §14 R2 (every filter column indexed) so the
-- admin viewer's filters stay range-scanned even when the table grows
-- past a few million rows. Postgres-portable per ADR 0002: TEXT UUIDs,
-- ISO timestamps, no SQLite-only SQL.

CREATE TABLE analytics_events (
  id              TEXT PRIMARY KEY,
  occurred_at     TEXT NOT NULL,
  event_name      TEXT NOT NULL,
  layer_slug      TEXT,
  user_id_hash    TEXT,
  properties_json TEXT NOT NULL,
  ingested_at     TEXT NOT NULL
);

CREATE INDEX idx_analytics_events_occurred_at  ON analytics_events(occurred_at);
CREATE INDEX idx_analytics_events_event_name   ON analytics_events(event_name);
CREATE INDEX idx_analytics_events_layer_slug   ON analytics_events(layer_slug);
CREATE INDEX idx_analytics_events_user_id_hash ON analytics_events(user_id_hash);
