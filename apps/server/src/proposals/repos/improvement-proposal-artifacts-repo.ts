import type { Database } from 'bun:sqlite';
import type { ArtifactVariant } from '@bunny2/shared';

/**
 * Phase 7.2 — repository over `improvement_proposal_artifacts`.
 *
 * N rows per proposal, each a sandbox replay transcript + delta
 * metrics (ADR 0023 §1). `transcript_json` and `metrics_json` are
 * opaque to the repo; the sandbox runner (phase 7.4) defines the
 * per-variant shapes.
 */

export interface ProposalArtifactRow {
  readonly id: string;
  readonly proposalId: string;
  readonly variant: ArtifactVariant;
  readonly transcriptJson: string;
  readonly metricsJson: string;
  readonly ranAt: string;
}

interface SqlRow {
  id: string;
  proposal_id: string;
  variant: ArtifactVariant;
  transcript_json: string;
  metrics_json: string;
  ran_at: string;
}

export interface InsertProposalArtifactInput {
  readonly id: string;
  readonly proposalId: string;
  readonly variant: ArtifactVariant;
  readonly transcriptJson: string;
  readonly metricsJson: string;
  readonly ranAt: string;
}

export interface ImprovementProposalArtifactsRepo {
  insertArtifact(input: InsertProposalArtifactInput): ProposalArtifactRow;
  listByProposal(proposalId: string): ProposalArtifactRow[];
}

const COLS = 'id, proposal_id, variant, transcript_json, metrics_json, ran_at';

function rowToArtifact(row: SqlRow): ProposalArtifactRow {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    variant: row.variant,
    transcriptJson: row.transcript_json,
    metricsJson: row.metrics_json,
    ranAt: row.ran_at,
  };
}

export function createImprovementProposalArtifactsRepo(
  db: Database,
): ImprovementProposalArtifactsRepo {
  const insert = db.query<unknown, [string, string, ArtifactVariant, string, string, string]>(
    `INSERT INTO improvement_proposal_artifacts
       (id, proposal_id, variant, transcript_json, metrics_json, ran_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const findById = db.query<SqlRow, [string]>(
    `SELECT ${COLS} FROM improvement_proposal_artifacts WHERE id = ?`,
  );

  const listByProposalStmt = db.query<SqlRow, [string]>(
    `SELECT ${COLS} FROM improvement_proposal_artifacts
       WHERE proposal_id = ?
       ORDER BY ran_at ASC, id ASC`,
  );

  return {
    insertArtifact(input) {
      insert.run(
        input.id,
        input.proposalId,
        input.variant,
        input.transcriptJson,
        input.metricsJson,
        input.ranAt,
      );
      const row = findById.get(input.id);
      if (row === null) {
        throw new Error(
          `improvement-proposal-artifacts-repo: failed to read back artifact ${input.id} after insert`,
        );
      }
      return rowToArtifact(row);
    },

    listByProposal(proposalId) {
      return listByProposalStmt.all(proposalId).map(rowToArtifact);
    },
  };
}
