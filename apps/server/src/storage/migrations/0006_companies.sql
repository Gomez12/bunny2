-- Phase 4a.1 — `companies` per-kind table.
--
-- First concrete consumer of the §4.0 entity-contract foundation. The
-- shared columns mirror the §5 "per-kind table shape" in
-- `docs/dev/plans/done/phase-04-first-entities.md`; the company-specific
-- indexed columns (`kvk_number`, `website`) are written by the generic
-- `EntityStore` via `companyModule.indexedColumns` (added in 4a.1 as a
-- minimal foundation tweak — see `docs/dev/architecture/entities.md` §2
-- and the §14 close-out entry).
--
-- Forward-only. Postgres-portable: TEXT UUIDs, ISO timestamps, no
-- SQLite-only SQL. Mirrors the rules in ADR 0002.

CREATE TABLE companies (
  id              TEXT PRIMARY KEY,
  layer_id        TEXT NOT NULL REFERENCES layers(id),
  slug            TEXT NOT NULL,
  title           TEXT NOT NULL,
  searchable_text TEXT NOT NULL,
  original_locale TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL REFERENCES users(id),
  updated_at      TEXT NOT NULL,
  updated_by      TEXT NOT NULL REFERENCES users(id),
  deleted_at      TEXT,
  deleted_by      TEXT REFERENCES users(id),
  version         INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  -- Company-specific indexed columns. Both are nullable: a layer can
  -- own a "draft" company with neither a KvK number nor a website yet
  -- (e.g. seeded by AI from a free-text note before enrichment runs in
  -- 4a.3). The KvK index is sparse — SQLite skips NULL entries.
  kvk_number      TEXT,
  website         TEXT,
  UNIQUE (layer_id, slug)
);

CREATE INDEX idx_companies_layer       ON companies(layer_id);
CREATE INDEX idx_companies_deleted_at  ON companies(deleted_at);
CREATE INDEX idx_companies_kvk         ON companies(kvk_number);
