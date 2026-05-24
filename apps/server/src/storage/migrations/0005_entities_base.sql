-- Phase 4.0 — universal entity contract foundation.
--
-- This migration adds the FOUR shared cross-cutting tables every entity
-- kind reuses. Per-kind tables (companies, contacts, calendar_events,
-- todos) land in their own sub-phase migrations (0006..) and reference
-- these by `entity_id` / `entity_kind`.
--
-- See `docs/dev/plans/done/phase-04-first-entities.md` §5, ADR 0011
-- (`docs/dev/decisions/0011-entity-contract.md`), and
-- `docs/dev/architecture/entities.md`.
--
-- Forward-only. Postgres-portable: TEXT UUIDs, ISO timestamps,
-- explicit CHECKs, no SQLite-only SQL. Mirrors the rules in ADR 0002.

-- Per-entity version history. The per-kind tables (companies, contacts,
-- ...) write a row here on every mutation so the version chain is
-- uniform across kinds without forcing JSON in the indexable tables.
CREATE TABLE entity_versions (
  id            TEXT PRIMARY KEY,
  entity_id     TEXT NOT NULL,
  entity_kind   TEXT NOT NULL,
  version       INTEGER NOT NULL CHECK (version > 0),
  payload_json  TEXT NOT NULL,
  meta_json     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL REFERENCES users(id),
  UNIQUE (entity_id, version)
);
CREATE INDEX idx_entity_versions_lookup ON entity_versions(entity_kind, entity_id);

-- Per-locale translation of an entity's payload. The original-locale
-- payload always lives in the per-kind table; this table holds every
-- other locale. `source_version` records the entity version this
-- translation was built from so the translator can skip re-runs when
-- the source has not advanced.
CREATE TABLE entity_translations (
  entity_id      TEXT NOT NULL,
  entity_kind    TEXT NOT NULL,
  locale         TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  source_version INTEGER NOT NULL CHECK (source_version > 0),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (entity_id, locale)
);
CREATE INDEX idx_entity_translations_kind ON entity_translations(entity_kind, locale);

-- Connector-managed link to an external system. Encrypted tokens /
-- per-link payload (e.g. KvK number, Google event etag) live in
-- `payload_json`; secrets are scrubbed from every bus payload before
-- publish (see `apps/server/src/entities/connectors/base.ts`).
CREATE TABLE entity_external_links (
  id           TEXT PRIMARY KEY,
  entity_id    TEXT NOT NULL,
  entity_kind  TEXT NOT NULL,
  connector    TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  sync_state   TEXT NOT NULL CHECK (sync_state IN ('idle','syncing','error')),
  synced_at    TEXT,
  error        TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (connector, external_id)
);
CREATE INDEX idx_entity_external_links_entity
  ON entity_external_links(entity_kind, entity_id);

-- Phase-7 hook: per-entity memory slice. Empty in phase 4; populated by
-- the self-learning loop in phase 7. Kept here so per-kind code never
-- has to think about whether the table exists.
CREATE TABLE entity_souls (
  entity_id   TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  memory_json TEXT NOT NULL DEFAULT '{}',
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (entity_id)
);
