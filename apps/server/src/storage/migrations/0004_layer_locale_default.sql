-- Phase 3.4 — defense-in-depth partial unique index for layer_locales.
--
-- The 3.4 route handler validates that at most one row per layer has
-- `is_default = 1`, but a direct repo writer (today or in a future
-- migration) could still insert a second default. This index makes the
-- guarantee enforceable at the SQLite layer.
--
-- Additive migration; no data movement. Existing rows already conform
-- because the 3.2 seed and 3.4 routes are the only writers and both
-- respect the "one default per layer" rule.

CREATE UNIQUE INDEX IF NOT EXISTS idx_layer_locales_one_default
  ON layer_locales(layer_id) WHERE is_default = 1;
