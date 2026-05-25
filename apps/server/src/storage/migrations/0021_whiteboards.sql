-- Phase 11.1 — `whiteboards` per-kind table.
--
-- Fifth concrete consumer of the §4.0 entity-contract foundation
-- (after companies, contacts, calendar_events, todos). Mirrors the §5
-- "per-kind table shape" exactly (id, layer_id, slug, title,
-- searchable_text, original_locale, payload_json, audit columns,
-- version) and adds the whiteboard-specific indexed columns per the
-- phase-11 plan §4.1 "Schema" cell and ADRs 0028 / 0030:
--
--   - `last_checkpoint_at`  : nullable TEXT (ISO-8601). Stamped by the
--                            11.5 "Save version" checkpoint flow when a
--                            new `entity_versions` snapshot is taken.
--                            Owned out-of-band by the PATCH handler in
--                            11.5 — NOT a payload projection (i.e. NOT
--                            written by the module's `indexedColumns`
--                            extract). NULL until the first explicit
--                            checkpoint.
--   - `thumbnail_blob`      : nullable BLOB. PNG bytes rendered by the
--                            web build via Excalidraw's `exportToBlob`
--                            (ADR 0029, plan §9 open-question 1) and
--                            POSTed alongside the scene in 11.5. Server
--                            stores the blob; the dashboard widget
--                            (11.4) reads it back as a base64 inline
--                            image. NULL until the first render.
--   - `thumbnail_etag`      : nullable TEXT. Stable identifier the web
--                            client uses to skip re-rendering on each
--                            save when the scene hasn't changed.
--                            Server-managed; never derived from the
--                            payload by `indexedColumns`.
--   - `scene_byte_size`     : INTEGER NOT NULL DEFAULT 0. Byte size of
--                            the serialised payload (`JSON.stringify(...)
--                            .length` — UTF-16 code units, an
--                            approximation). Written by the module's
--                            `indexedColumns` extract on every save so
--                            11.5's per-file size cap and the §7
--                            "large files blow row size" mitigation
--                            have an indexed signal to query.
--
-- Indexes: `(layer_id)` for layer-scoped listing, `(layer_id, updated_at
-- DESC)` for the dashboard widget's "recent whiteboards" query (§11.4),
-- `(deleted_at)` for the soft-delete sweep.
--
-- Forward-only. Postgres-portable: TEXT UUIDs, ISO timestamps, BLOB
-- (maps to BYTEA in Postgres), INTEGER. No SQLite-only SQL. Mirrors
-- the rules in ADR 0002.

CREATE TABLE whiteboards (
  id                   TEXT PRIMARY KEY,
  layer_id             TEXT NOT NULL REFERENCES layers(id),
  slug                 TEXT NOT NULL,
  title                TEXT NOT NULL,
  searchable_text      TEXT NOT NULL,
  original_locale      TEXT NOT NULL,
  payload_json         TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  created_by           TEXT NOT NULL REFERENCES users(id),
  updated_at           TEXT NOT NULL,
  updated_by           TEXT NOT NULL REFERENCES users(id),
  deleted_at           TEXT,
  deleted_by           TEXT REFERENCES users(id),
  version              INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  -- Whiteboard-specific columns.
  last_checkpoint_at   TEXT,
  thumbnail_blob       BLOB,
  thumbnail_etag       TEXT,
  scene_byte_size      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (layer_id, slug)
);

CREATE INDEX idx_whiteboards_layer            ON whiteboards(layer_id);
CREATE INDEX idx_whiteboards_layer_updated_at ON whiteboards(layer_id, updated_at DESC);
CREATE INDEX idx_whiteboards_deleted_at       ON whiteboards(deleted_at);
