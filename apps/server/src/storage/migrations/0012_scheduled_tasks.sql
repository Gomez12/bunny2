-- Phase 5.0 — generic scheduled tasks + run history.
--
-- First half of the phase-5 storage layer. Companion migration
-- 0013_durable_bus.sql (phase 5.1) adds the outbox + offsets +
-- DLQ tables. The two halves are split because they ship as
-- separate sub-phases.
--
-- `scheduled_tasks` is the user-visible, layer-scoped definition of
-- a recurring job. Every row corresponds to one entry in the
-- `/l/:slug/scheduled-tasks` UI. Soft-deleted, version-counted,
-- and audit-stamped like every other §AGENTS-compliant table.
--
-- Two scheduling modes are accepted (mutually exclusive at the
-- zod boundary AND at the CHECK below):
--
--   - `cron`     : 5-field cron string evaluated in `cron_timezone`
--                  (IANA tz, e.g. 'Europe/Amsterdam'). The 5.3
--                  scheduler service uses `croner` to compute
--                  `next_run_at`.
--   - `interval` : every N minutes from `last_run_at` (or from
--                  `created_at` for the first run). `cron_*`
--                  columns are NULL.
--
-- Retry / backoff lives on the task row, not on the run row, so a
-- developer can tune limits without rewriting history. `attempt`
-- counts failed attempts since the last success and resets to 0
-- on success; once `attempt >= max_attempts` the runner flips the
-- task to `paused` (a separate `paused` row carries a `reason`
-- distinguishing manual-pause from auto-pause).
--
-- `claimed_at` + `claimed_by_pid` are the single-host claim that
-- prevents two scheduler ticks (in two processes, after the
-- 5.2 role split) from publishing the same run twice. The
-- scheduler `UPDATE … WHERE claimed_at IS NULL` is atomic in
-- SQLite WAL mode; the lease window is enforced in code (the
-- scheduler reclaims `claimed_at < now - <lease>` rows on the
-- next tick).
--
-- `scheduled_task_runs` is the history table. One row per
-- requested invocation, regardless of outcome. The row lifecycle
-- mirrors `scheduledtask.run.*` bus events (`requested` →
-- `started` → `succeeded` | `failed` | `skipped_*`). The
-- composite index supports the per-task "recent runs" UI query.
--
-- `correlation_id` carries the bus correlationId through to the
-- run row so the LLM call log + events table can be joined to a
-- single run if the handler called an LLM.
--
-- Forward-only. Postgres-portable: TEXT primary keys, ISO
-- timestamps, no SQLite-only SQL. Mirrors the rules in ADR 0002.

CREATE TABLE scheduled_tasks (
  id                TEXT PRIMARY KEY,
  layer_id          TEXT NOT NULL REFERENCES layers(id),
  slug              TEXT NOT NULL,
  kind              TEXT NOT NULL,
  name              TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('active','paused','canceled')),
  schedule_kind     TEXT NOT NULL CHECK (schedule_kind IN ('cron','interval')),
  cron_expression   TEXT,
  cron_timezone     TEXT,
  interval_minutes  INTEGER,
  config_json       TEXT NOT NULL DEFAULT '{}',
  max_attempts      INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  backoff_base_ms   INTEGER NOT NULL DEFAULT 60000 CHECK (backoff_base_ms > 0),
  backoff_max_ms    INTEGER NOT NULL DEFAULT 3600000 CHECK (backoff_max_ms >= backoff_base_ms),
  next_run_at       TEXT NOT NULL,
  last_run_at       TEXT,
  attempt           INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  pause_reason      TEXT,
  claimed_at        TEXT,
  claimed_by_pid    INTEGER,
  version           INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at        TEXT NOT NULL,
  created_by        TEXT NOT NULL REFERENCES users(id),
  updated_at        TEXT NOT NULL,
  updated_by        TEXT NOT NULL REFERENCES users(id),
  deleted_at        TEXT,
  deleted_by        TEXT REFERENCES users(id),
  UNIQUE (layer_id, slug),
  CHECK (
    (schedule_kind = 'cron' AND cron_expression IS NOT NULL
                            AND cron_timezone   IS NOT NULL
                            AND interval_minutes IS NULL)
    OR
    (schedule_kind = 'interval' AND interval_minutes IS NOT NULL
                                AND interval_minutes > 0
                                AND cron_expression IS NULL
                                AND cron_timezone   IS NULL)
  )
);

CREATE INDEX idx_scheduled_tasks_layer ON scheduled_tasks(layer_id);
CREATE INDEX idx_scheduled_tasks_kind  ON scheduled_tasks(kind);
-- Hot path: "what is due now?". Filtered on `status = 'active'` +
-- `deleted_at IS NULL` so the scheduler's claim query is a single
-- range seek instead of a table scan.
CREATE INDEX idx_scheduled_tasks_due
  ON scheduled_tasks(status, next_run_at)
  WHERE deleted_at IS NULL;

CREATE TABLE scheduled_task_runs (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES scheduled_tasks(id),
  status          TEXT NOT NULL CHECK (status IN (
                     'requested','started','succeeded','failed',
                     'skipped_offline','skipped_no_handler','skipped_crashed'
                   )),
  attempt         INTEGER NOT NULL CHECK (attempt >= 0),
  triggered_by    TEXT NOT NULL CHECK (triggered_by IN ('schedule','manual','retry')),
  requested_at    TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  duration_ms     INTEGER,
  error           TEXT,
  correlation_id  TEXT
);

CREATE INDEX idx_scheduled_task_runs_task
  ON scheduled_task_runs(task_id, requested_at DESC);
-- Supports the admin cross-layer "latest runs across all tasks" view
-- shipped in phase 5.4 and the dashboard widget shipped in phase 5.6.
CREATE INDEX idx_scheduled_task_runs_recent
  ON scheduled_task_runs(requested_at DESC);
