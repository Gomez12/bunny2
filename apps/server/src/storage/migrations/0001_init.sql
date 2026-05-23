-- Phase 1.2 initial schema.

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  correlation_id TEXT,
  flow_id TEXT,
  payload TEXT NOT NULL,
  metadata TEXT
);
CREATE INDEX idx_events_type_occurred ON events(type, occurred_at);
CREATE INDEX idx_events_correlation ON events(correlation_id);
CREATE INDEX idx_events_flow ON events(flow_id);

CREATE TABLE llm_calls (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  model TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  request TEXT NOT NULL,
  response TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  latency_ms INTEGER,
  correlation_id TEXT,
  flow_id TEXT,
  layer_id TEXT,
  user_id TEXT,
  error TEXT
);
CREATE INDEX idx_llm_calls_started ON llm_calls(started_at);
CREATE INDEX idx_llm_calls_correlation ON llm_calls(correlation_id);

CREATE TABLE kv_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
