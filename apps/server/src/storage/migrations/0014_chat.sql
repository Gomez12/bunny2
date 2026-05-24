-- Phase 6.1 — Super Chat storage layer.
--
-- Five tables that together back the per-layer multi-turn chat:
--
--   - `chat_conversations`    : one row per conversation. Scoped to
--                               `(layer_id, user_id)`. Soft-deleted
--                               + audit-stamped per `overall.md` §5.
--   - `chat_messages`         : ordered turns inside a conversation.
--                               One row per user turn and one per
--                               assistant turn. Pipeline state lives
--                               on the message via `status`. Messages
--                               are NOT soft-deleted; a failed answer
--                               stays in the thread so the user sees
--                               what happened (the conversation is
--                               the deletion boundary).
--   - `chat_pipeline_runs`    : one row per assistant message
--                               attempting an answer. 1:1 with the
--                               assistant `chat_messages` row in v1;
--                               separate table keeps space open for
--                               retry-as-new-run later.
--   - `chat_pipeline_steps`   : per-step persistence for the four
--                               pipeline stages (intent, entities,
--                               retrieval, answer). One row per
--                               attempt — the orchestrator (phase
--                               6.3) writes inputs/outputs and the
--                               optional `llm_call_id` link into the
--                               `llm_calls` log (phase 1).
--   - `chat_message_feedback` : thumbs up/down per assistant
--                               message. UNIQUE on `message_id` —
--                               one feedback row per message, the
--                               repo upsert overwrites.
--
-- Phase 6 is `(layer_id, user_id)`-scoped; a shared-conversation
-- toggle is a phase-7+ follow-up candidate (see plan §11). LanceDB
-- writes (phase 6.2) and the pipeline orchestrator (phase 6.3) read
-- from these tables; they do not extend them.
--
-- Forward-only. Postgres-portable: TEXT primary keys, ISO
-- timestamps, no SQLite-only SQL. Mirrors the rules in ADR 0002.

CREATE TABLE chat_conversations (
  id          TEXT PRIMARY KEY,
  layer_id    TEXT NOT NULL REFERENCES layers(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  title       TEXT NOT NULL,
  locale      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  deleted_by  TEXT REFERENCES users(id)
);

-- Hot path: "list this user's conversations in this layer, newest
-- first". Filter on `deleted_at IS NULL` happens at query time;
-- including it in the index keeps the lookup an index range scan.
CREATE INDEX idx_chat_conversations_layer_user
  ON chat_conversations(layer_id, user_id, deleted_at);

CREATE TABLE chat_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content         TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
  model           TEXT,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  correlation_id  TEXT NOT NULL,
  flow_id         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  finished_at     TEXT
);

-- Hot path: "load this thread oldest-first". `created_at` ordering
-- is the canonical thread order — the orchestrator and the web UI
-- both rely on it.
CREATE INDEX idx_chat_messages_conv_created
  ON chat_messages(conversation_id, created_at);

CREATE TABLE chat_pipeline_runs (
  id          TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL REFERENCES chat_messages(id),
  status      TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed')),
  started_at  TEXT NOT NULL,
  ended_at    TEXT
);

CREATE TABLE chat_pipeline_steps (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES chat_pipeline_runs(id),
  kind          TEXT NOT NULL CHECK (kind IN ('intent','entities','retrieval','answer')),
  status        TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','skipped')),
  attempt       INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  input_json    TEXT,
  output_json   TEXT,
  llm_call_id   TEXT REFERENCES llm_calls(id),
  error_code    TEXT
);

-- Supports the "show me the steps for this run, in order" query the
-- Kanban (phase 6.6) and integration tests rely on. Compound on
-- `(run_id, kind)` mirrors the plan §4.2 sketch.
CREATE INDEX idx_chat_pipeline_steps_run_kind
  ON chat_pipeline_steps(run_id, kind);

CREATE TABLE chat_message_feedback (
  id          TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL UNIQUE REFERENCES chat_messages(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  value       TEXT NOT NULL CHECK (value IN ('up','down')),
  reason      TEXT,
  created_at  TEXT NOT NULL
);
