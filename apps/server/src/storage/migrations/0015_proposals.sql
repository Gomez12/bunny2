-- Phase 7.2 — Improvement-proposal storage layer.
--
-- Four tables that together back the self-learning review loop
-- ([`plan §4.2`](../../../../../docs/dev/plans/phase-07-self-learning.md);
--  [ADR 0023](../../../../../docs/dev/decisions/0023-improvement-proposal-contract.md)):
--
--   - `improvement_proposals`           : one row per minted proposal.
--                                         `status` drives the UI; carries the
--                                         capability snapshot at mint time so
--                                         the re-plan path (phase 7.4 / ADR
--                                         0025) is a pure function. Soft-
--                                         deletable + audit-stamped per
--                                         `overall.md` §5. `threshold` is
--                                         recorded but never read in phase 7
--                                         — phase 8 will consume it without a
--                                         migration (ADR 0023 §3).
--   - `improvement_proposal_evidence`   : N rows per proposal, each pointing
--                                         at a `chat_messages.id` the cluster
--                                         grouper picked. No copying of
--                                         message content — the FK is the
--                                         canonical reference.
--   - `improvement_proposal_artifacts`  : N rows per proposal
--                                         (variant ∈ current | proposed |
--                                         replanned), each a sandbox replay
--                                         transcript + delta metrics. Lets
--                                         the UI render the side-by-side
--                                         comparison without re-running the
--                                         sandbox.
--   - `layer_capabilities`              : the per-layer registry of activated
--                                         tools / skills / agents (the
--                                         phase-3 §invariant-4 attachment
--                                         point, finally filled). `origin` is
--                                         `builtin` or `proposal:<uuid>`.
--                                         UNIQUE `(layer_id, kind, name)`.
--                                         Deactivation flips
--                                         `deactivated_at`; rows survive so
--                                         history is preserved.
--
-- Forward-only. Postgres-portable: TEXT primary keys, ISO 8601
-- timestamps, no SQLite-only SQL. Mirrors the rules in ADR 0002.

CREATE TABLE improvement_proposals (
  id                       TEXT PRIMARY KEY,
  layer_id                 TEXT NOT NULL REFERENCES layers(id),
  status                   TEXT NOT NULL
    CHECK (status IN ('new','approved','rejected','superseded','activated','deactivated')),
  artifact_kind            TEXT NOT NULL
    CHECK (artifact_kind IN ('tool','skill','agent')),
  problem_summary          TEXT NOT NULL,
  proposed_spec_json       TEXT NOT NULL,
  expected_impact_json     TEXT NOT NULL,
  threshold                REAL NOT NULL CHECK (threshold >= 0 AND threshold <= 1),
  capability_snapshot_json TEXT NOT NULL,
  minted_by_run_id         TEXT NOT NULL,
  minted_at                TEXT NOT NULL,
  approved_by              TEXT REFERENCES users(id),
  approved_at              TEXT,
  rejected_by              TEXT REFERENCES users(id),
  rejected_at              TEXT,
  rejected_reason          TEXT,
  activated_at             TEXT,
  deleted_at               TEXT,
  deleted_by               TEXT REFERENCES users(id)
);

-- Hot path: "list this layer's proposals filtered by status, newest first".
-- Soft-deletion filter happens at query time; the index is enough to keep
-- the lookup an index range scan.
CREATE INDEX idx_improvement_proposals_layer_status
  ON improvement_proposals(layer_id, status, minted_at);

CREATE TABLE improvement_proposal_evidence (
  id              TEXT PRIMARY KEY,
  proposal_id     TEXT NOT NULL REFERENCES improvement_proposals(id),
  message_id      TEXT NOT NULL REFERENCES chat_messages(id),
  cluster_reason  TEXT NOT NULL,
  detail_json     TEXT
);

CREATE INDEX idx_improvement_proposal_evidence_proposal
  ON improvement_proposal_evidence(proposal_id);

CREATE TABLE improvement_proposal_artifacts (
  id              TEXT PRIMARY KEY,
  proposal_id     TEXT NOT NULL REFERENCES improvement_proposals(id),
  variant         TEXT NOT NULL
    CHECK (variant IN ('current','proposed','replanned')),
  transcript_json TEXT NOT NULL,
  metrics_json    TEXT NOT NULL,
  ran_at          TEXT NOT NULL
);

CREATE INDEX idx_improvement_proposal_artifacts_proposal
  ON improvement_proposal_artifacts(proposal_id);

CREATE TABLE layer_capabilities (
  id              TEXT PRIMARY KEY,
  layer_id        TEXT NOT NULL REFERENCES layers(id),
  kind            TEXT NOT NULL
    CHECK (kind IN ('tool','skill','agent')),
  name            TEXT NOT NULL,
  spec_json       TEXT NOT NULL,
  origin          TEXT NOT NULL,
  activated_at    TEXT NOT NULL,
  deactivated_at  TEXT,
  UNIQUE(layer_id, kind, name)
);

CREATE INDEX idx_layer_capabilities_layer
  ON layer_capabilities(layer_id, deactivated_at);
