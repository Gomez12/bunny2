-- Phase 4a.2 — extend `layer_attachments.kind` CHECK to accept
-- `'connector'`.
--
-- The 0003_layers.sql CHECK enumerates `('agent','skill','mcp_server')`
-- inline on the column; SQLite cannot ALTER a column CHECK in place, so
-- the canonical workaround is the "table-rebuild dance": create a new
-- table with the extended CHECK, copy rows, drop the old one, rename.
--
-- Why this can't be additive: the constraint lives in the table DDL,
-- not in a separate object we could drop and recreate. A future Postgres
-- port (overall.md §8 "Later") would use `ALTER TABLE ... DROP CONSTRAINT
-- + ADD CONSTRAINT`; on SQLite we have to do this.
--
-- Safety:
--  - `PRAGMA defer_foreign_keys = ON` lets us rename a referenced table
--    inside a transaction. The applyMigrations runner wraps every
--    migration in `db.transaction(() => db.exec(sql))`; `PRAGMA
--    foreign_keys = OFF` does not take effect inside a transaction
--    (SQLite docs §FK Off Inside Tx), but `defer_foreign_keys` does.
--  - No other table references `layer_attachments(id)` (only
--    `layer_attachments.layer_id` references `layers(id)`), so the
--    rebuild is contained.
--  - The 0003 schema has no indexes on `layer_attachments`; the only
--    constraint to preserve is `UNIQUE (layer_id, kind, ref_id)` which
--    we re-declare on the new table.
--  - The rebuild preserves the original `id`s — repositories that
--    cache them across the migration boundary keep working.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE layer_attachments_new (
  id          TEXT PRIMARY KEY,
  layer_id    TEXT NOT NULL REFERENCES layers(id),
  kind        TEXT NOT NULL CHECK (kind IN ('agent','skill','mcp_server','connector')),
  ref_id      TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  UNIQUE (layer_id, kind, ref_id)
);

INSERT INTO layer_attachments_new (id, layer_id, kind, ref_id, config_json, created_at)
  SELECT id, layer_id, kind, ref_id, config_json, created_at FROM layer_attachments;

DROP TABLE layer_attachments;
ALTER TABLE layer_attachments_new RENAME TO layer_attachments;
