-- Phase 4b.1 — `contacts` per-kind table.
--
-- Second concrete consumer of the §4.0 entity-contract foundation.
-- Mirrors the §5 "per-kind table shape" exactly (id, layer_id, slug,
-- title, searchable_text, original_locale, payload_json, audit columns,
-- version) and adds the contact-specific indexed columns:
--
--   - `primary_email`    : derived projection from `payload.emails[]`
--                          (first entry whose `isPrimary` is true, or
--                          the first entry overall).
--   - `primary_phone`    : same derivation over `payload.phones[]`.
--   - `company_entity_id`: soft link to a `companies.id`. NOT a
--                          FOREIGN KEY: we want the link to survive
--                          a company's soft delete, and we want to
--                          allow cross-kind references generally (a
--                          future "department" / "team" kind might
--                          take the same slot). The 4b.3 route handler
--                          validates the link at write time; the SQL
--                          layer stays kind-agnostic.
--
-- Forward-only. Postgres-portable: TEXT UUIDs, ISO timestamps, no
-- SQLite-only SQL. Mirrors the rules in ADR 0002.

CREATE TABLE contacts (
  id                 TEXT PRIMARY KEY,
  layer_id           TEXT NOT NULL REFERENCES layers(id),
  slug               TEXT NOT NULL,
  title              TEXT NOT NULL,
  searchable_text    TEXT NOT NULL,
  original_locale    TEXT NOT NULL,
  payload_json       TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  created_by         TEXT NOT NULL REFERENCES users(id),
  updated_at         TEXT NOT NULL,
  updated_by         TEXT NOT NULL REFERENCES users(id),
  deleted_at         TEXT,
  deleted_by         TEXT REFERENCES users(id),
  version            INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  -- Contact-specific indexed columns. All three are nullable: a layer
  -- can own a "draft" contact (title only) that gets emails / phones /
  -- a company link filled in by the 4b.2 vCard import or the 4b.3 AI
  -- suggestion. The sparse indexes below skip NULL entries.
  primary_email      TEXT,
  primary_phone      TEXT,
  company_entity_id  TEXT,
  UNIQUE (layer_id, slug)
);

CREATE INDEX idx_contacts_layer         ON contacts(layer_id);
CREATE INDEX idx_contacts_deleted_at    ON contacts(deleted_at);
CREATE INDEX idx_contacts_primary_email ON contacts(primary_email);
CREATE INDEX idx_contacts_company       ON contacts(company_entity_id);
