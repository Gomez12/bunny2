import type { Database } from 'bun:sqlite';
import type { ClusterReason } from '@bunny2/shared';

/**
 * Phase 7.2 — repository over `improvement_proposal_evidence`.
 *
 * N rows per proposal, each linking to the `chat_messages.id` that
 * supports the cluster (ADR 0023 §1). `detail_json` is opaque to this
 * repo — call sites store additional context (e.g. retrieval-step
 * input/output, feedback reason) as JSON.
 *
 * Evidence rows live and die with the proposal; the repo exposes
 * `deleteByProposal` so the soft-delete machinery in the proposals
 * repo can cascade when needed.
 */

export interface ProposalEvidenceRow {
  readonly id: string;
  readonly proposalId: string;
  readonly messageId: string;
  readonly clusterReason: ClusterReason;
  readonly detailJson: string | null;
}

interface SqlRow {
  id: string;
  proposal_id: string;
  message_id: string;
  cluster_reason: ClusterReason;
  detail_json: string | null;
}

export interface InsertProposalEvidenceInput {
  readonly id: string;
  readonly proposalId: string;
  readonly messageId: string;
  readonly clusterReason: ClusterReason;
  readonly detailJson?: string | null;
}

export interface ImprovementProposalEvidenceRepo {
  insertMany(rows: readonly InsertProposalEvidenceInput[]): ProposalEvidenceRow[];
  listByProposal(proposalId: string): ProposalEvidenceRow[];
  deleteByProposal(proposalId: string): void;
}

const COLS = 'id, proposal_id, message_id, cluster_reason, detail_json';

function rowToEvidence(row: SqlRow): ProposalEvidenceRow {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    messageId: row.message_id,
    clusterReason: row.cluster_reason,
    detailJson: row.detail_json,
  };
}

export function createImprovementProposalEvidenceRepo(
  db: Database,
): ImprovementProposalEvidenceRepo {
  const insert = db.query<unknown, [string, string, string, ClusterReason, string | null]>(
    `INSERT INTO improvement_proposal_evidence
       (id, proposal_id, message_id, cluster_reason, detail_json)
     VALUES (?, ?, ?, ?, ?)`,
  );

  const findById = db.query<SqlRow, [string]>(
    `SELECT ${COLS} FROM improvement_proposal_evidence WHERE id = ?`,
  );

  const listByProposalStmt = db.query<SqlRow, [string]>(
    `SELECT ${COLS} FROM improvement_proposal_evidence
       WHERE proposal_id = ?
       ORDER BY id ASC`,
  );

  const deleteByProposalStmt = db.query<unknown, [string]>(
    `DELETE FROM improvement_proposal_evidence WHERE proposal_id = ?`,
  );

  return {
    insertMany(rows) {
      const inserted: ProposalEvidenceRow[] = [];
      // Wrap the batch in a transaction so partial writes don't
      // leave half a cluster's evidence behind on error.
      const tx = db.transaction((batch: readonly InsertProposalEvidenceInput[]) => {
        for (const input of batch) {
          insert.run(
            input.id,
            input.proposalId,
            input.messageId,
            input.clusterReason,
            input.detailJson ?? null,
          );
          const row = findById.get(input.id);
          if (row === null) {
            throw new Error(
              `improvement-proposal-evidence-repo: failed to read back evidence ${input.id} after insert`,
            );
          }
          inserted.push(rowToEvidence(row));
        }
      });
      tx(rows);
      return inserted;
    },

    listByProposal(proposalId) {
      return listByProposalStmt.all(proposalId).map(rowToEvidence);
    },

    deleteByProposal(proposalId) {
      deleteByProposalStmt.run(proposalId);
    },
  };
}
