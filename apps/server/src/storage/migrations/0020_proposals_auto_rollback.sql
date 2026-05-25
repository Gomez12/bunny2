-- Phase 9 — Proposals auto-rollback watcher storage additions.
--
-- Closes follow-up `docs/dev/follow-ups/done/proposals-auto-rollback-watcher.md`
-- (ADR 0027 §4 deferral). Two additive changes:
--
--   - Two new columns on `layer_proposal_settings` (introduced by
--     migration `0017_proposals_phase8.sql`):
--       - `auto_rollback_window_days INTEGER NOT NULL DEFAULT 7`
--         CHECK clamps the window to [1, 90] (matches the upper
--         bound the settings UI allows; a sub-day window is unstable
--         and a >90-day window blurs together too many activations).
--       - `auto_rollback_min_thumbs_ratio REAL NOT NULL DEFAULT 0.4`
--         CHECK clamps to [0, 1] (same shape as the existing
--         `threshold_cutoff` knob).
--     Defaults mirror the follow-up doc's "window = 7d, floor = 0.4"
--     spec. Absent row still resolves to the defaults via the repo's
--     `getOrDefault(...)`.
--
--   - Two new columns on `improvement_proposals` (introduced by
--     migration `0015_proposals.sql`, extended by 0017):
--       - `auto_rolled_back_by TEXT` — the literal `'system'` when
--         set by the auto-rollback watcher; NULL otherwise. NOT an
--         FK (mirrors `auto_activated_by`; ADR 0026 §3 records why
--         the `'system'` literal does not get a `users(id)` row).
--       - `auto_rolled_back_at TEXT` — ISO timestamp the watcher
--         stamped after `capabilityRegistry.deactivate(...)` returned.
--
--     Manual rollback continues to use the existing `rolled_back_*`
--     columns (with the user FK on `rolled_back_by`). The repo's
--     `recordRollback(...)` gains an `actorKind: 'user' | 'system'`
--     discriminator so the FK column stays clean for system writes.
--     `rolled_back_at` + `rolled_back_reason` are written for both
--     actor kinds (the timestamp + reason are universal audit; only
--     the actor column differs).
--
-- No new index. The watcher's predicate filters by
-- `(status='activated' AND rolled_back_at IS NULL)` on
-- `improvement_proposals` and joins through
-- `chat_conversations.layer_id` — both columns already covered by
-- existing indexes (`idx_improvement_proposals_layer_status` from
-- 0015 + `idx_chat_conversations_layer_user` from 0014).
--
-- Forward-only. Postgres-portable: REAL/INTEGER with CHECK
-- constraints, ISO 8601 timestamps, no SQLite-only SQL. Mirrors
-- the rules in ADR 0002.

ALTER TABLE layer_proposal_settings
  ADD COLUMN auto_rollback_window_days INTEGER NOT NULL DEFAULT 7
    CHECK (auto_rollback_window_days >= 1 AND auto_rollback_window_days <= 90);

ALTER TABLE layer_proposal_settings
  ADD COLUMN auto_rollback_min_thumbs_ratio REAL NOT NULL DEFAULT 0.4
    CHECK (auto_rollback_min_thumbs_ratio >= 0 AND auto_rollback_min_thumbs_ratio <= 1);

ALTER TABLE improvement_proposals
  ADD COLUMN auto_rolled_back_by TEXT;

ALTER TABLE improvement_proposals
  ADD COLUMN auto_rolled_back_at TEXT;
