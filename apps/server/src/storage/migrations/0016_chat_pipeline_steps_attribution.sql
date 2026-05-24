-- Phase 7.6 — capability-attribution column on `chat_pipeline_steps`.
--
-- The answerer step (`apps/server/src/chat/pipeline/answer-step.ts`)
-- writes a small JSON object listing the activated capabilities that
-- contributed to the answer. The Kanban board (phase 7.6 UI) reads it
-- to render `[skill:<name>]` / `[tool:<name>]` / `[agent:<name>]`
-- chips on the card.
--
-- Shape (defined by the writer, opaque to the schema):
--   { "skills": [{ "capabilityId": "...", "name": "..." }],
--     "tools":  [...],
--     "agents": [...] }
--
-- NULL when no capabilities contributed — keeps the phase-6 byte path
-- alive for every test that doesn't wire a registry. Nullable on
-- purpose; never backfilled. `ADD COLUMN ... DEFAULT NULL` is safe in
-- SQLite (instant; no table rewrite).

ALTER TABLE chat_pipeline_steps ADD COLUMN attribution_json TEXT;
