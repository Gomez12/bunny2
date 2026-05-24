-- Phase 8.1 — Threshold-automation storage foundation.
--
-- Two additive changes in a single forward-only migration
-- ([`plan §4.1`](../../../../../docs/dev/plans/phase-08-threshold-automation.md);
--  [ADR 0026](../../../../../docs/dev/decisions/0026-auto-activation-gating.md)
--  for the auto-activation columns;
--  [ADR 0027](../../../../../docs/dev/decisions/0027-manual-rollback.md)
--  for the rollback columns):
--
--   - New table `layer_proposal_settings` — 1:1 with `layers(id)`,
--     holding the four tunable knobs the auto-activate gate
--     consumes (`auto_activation_enabled`, `threshold_cutoff`,
--     `cooldown_hours`, `require_thumbs_up_delta_positive`,
--     `max_tokens_delta`) plus audit (`updated_at`, `updated_by`).
--     Absent row = "auto-activation disabled, cutoff 1.0,
--     cooldown 24h, thumbs-up-delta required, no token cap" —
--     the repo's `getOrDefault` resolves the defaults so callers
--     never see NULL pollution upstream. CHECK constraints clamp
--     the numeric knobs to the same ranges the zod schema enforces.
--
--   - Six additive ALTERs on `improvement_proposals`:
--       - `auto_activated_by`              — `'system'` literal
--         when set by the auto-activate job; NULL otherwise. Not
--         an FK; ADR 0026 §3 records why `'system'` is not a
--         `users(id)` row.
--       - `auto_activated_at`              — ISO timestamp the
--         auto-path stamped after `replanOnApproval` returned.
--       - `auto_activation_decision_json` — full gate evaluation
--         (seven records ordered cheapest-first) written before
--         `replanOnApproval` runs, so a mid-flight failure leaves
--         the forensic trail intact (ADR 0026 §4).
--       - `rolled_back_at`                 — ISO timestamp the
--         rollback route wrote in the same transaction the
--         capability was soft-deactivated (ADR 0027 §2).
--       - `rolled_back_by`                 — `users(id)` FK; the
--         admin who clicked rollback.
--       - `rolled_back_reason`             — free-form text;
--         required at the route boundary (`>= 5 chars`), never
--         logged to telemetry or analytics (ADR 0027 §3).
--
-- No new index is added: the auto-path's
-- `WHERE layer_id = ? AND status = 'new'` query is already covered
-- by the existing `idx_improvement_proposals_layer_status` from
-- migration `0015_proposals.sql` (plan §4.1).
--
-- Forward-only. Postgres-portable: TEXT primary keys, REAL/INTEGER
-- with CHECK constraints, ISO 8601 timestamps, no SQLite-only SQL.
-- Mirrors the rules in ADR 0002.

CREATE TABLE layer_proposal_settings (
  layer_id                         TEXT PRIMARY KEY REFERENCES layers(id),
  auto_activation_enabled          INTEGER NOT NULL DEFAULT 0,
  threshold_cutoff                 REAL NOT NULL DEFAULT 1.0
    CHECK (threshold_cutoff >= 0 AND threshold_cutoff <= 1),
  cooldown_hours                   INTEGER NOT NULL DEFAULT 24
    CHECK (cooldown_hours >= 0 AND cooldown_hours <= 720),
  require_thumbs_up_delta_positive INTEGER NOT NULL DEFAULT 1,
  max_tokens_delta                 INTEGER
    CHECK (max_tokens_delta IS NULL OR max_tokens_delta >= 0),
  updated_at                       TEXT NOT NULL,
  updated_by                       TEXT NOT NULL REFERENCES users(id)
);

ALTER TABLE improvement_proposals
  ADD COLUMN auto_activated_by TEXT;
ALTER TABLE improvement_proposals
  ADD COLUMN auto_activated_at TEXT;
ALTER TABLE improvement_proposals
  ADD COLUMN auto_activation_decision_json TEXT;
ALTER TABLE improvement_proposals
  ADD COLUMN rolled_back_at TEXT;
ALTER TABLE improvement_proposals
  ADD COLUMN rolled_back_by TEXT REFERENCES users(id);
ALTER TABLE improvement_proposals
  ADD COLUMN rolled_back_reason TEXT;
