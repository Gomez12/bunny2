-- Phase follow-up — Per-layer chat LLM model + embedding budget.
--
-- Three additive changes in a single forward-only migration
-- (`docs/dev/plans/chat-per-layer-settings.md`):
--
--   - New table `layer_chat_settings` — 1:1 with `layers(id)` holding
--     the per-layer chat model override and embedding-budget caps.
--     NULL on any tunable means "inherit the system default". Absent
--     row = inherit all defaults. The chat pipeline (router /
--     resolver / answerer) joins on this table per call; the
--     embedding subscriber consults it before encoding.
--
--   - New table `layer_embedding_spend` — daily token counters keyed
--     by `(layer_id, day)`. `day` is `YYYY-MM-DD` UTC. The subscriber
--     upserts after each successful encode. The cap evaluator reads
--     `tokens_spent` for `day = today` and `SUM(...)` over the last
--     30 days for the monthly cap.
--
--   - `llm_calls.model_source` column — `'system'` or `'layer'`,
--     stamped by the telemetry wrapper from `metadata.modelSource`
--     so the chat pipeline can record where the model decision came
--     from. Backfilled to `'system'` for existing rows: until this
--     follow-up there was no per-layer override path, so every row
--     was system-default.
--
-- Forward-only. Postgres-portable: TEXT primary keys, INTEGER with
-- CHECK constraints, ISO 8601 timestamps, no SQLite-only SQL.

CREATE TABLE layer_chat_settings (
  layer_id              TEXT PRIMARY KEY REFERENCES layers(id) ON DELETE CASCADE,
  model                 TEXT,
  embedding_daily_cap   INTEGER
    CHECK (embedding_daily_cap IS NULL OR embedding_daily_cap >= 0),
  embedding_monthly_cap INTEGER
    CHECK (embedding_monthly_cap IS NULL OR embedding_monthly_cap >= 0),
  created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE layer_embedding_spend (
  layer_id     TEXT NOT NULL REFERENCES layers(id) ON DELETE CASCADE,
  day          TEXT NOT NULL,
  tokens_spent INTEGER NOT NULL DEFAULT 0 CHECK (tokens_spent >= 0),
  PRIMARY KEY (layer_id, day)
);

-- Hot path: cap check + spend aggregation always filter by
-- `(layer_id, day)`; the PRIMARY KEY covers it. No extra index.

ALTER TABLE llm_calls ADD COLUMN model_source TEXT;

-- Backfill every existing row to 'system' — the per-layer override
-- path did not exist before this migration, so every historical
-- call was system-default by definition.
UPDATE llm_calls SET model_source = 'system' WHERE model_source IS NULL;
