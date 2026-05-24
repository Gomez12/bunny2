import type { Database } from 'bun:sqlite';
import type { ArtifactKind, ProposalStatus } from '@bunny2/shared';

/**
 * Phase 7.2 — repository over `improvement_proposals`.
 *
 * Pure persistence over the proposal row. Soft-deletable +
 * audit-stamped per `overall.md` §5. `proposed_spec_json`,
 * `expected_impact_json` and `capability_snapshot_json` are opaque to
 * this repo — the call sites (review agent in phase 7.3, sandbox /
 * replan in phase 7.4, HTTP routes in phase 7.6) own the per-shape
 * validation against the zod schemas in
 * `packages/shared/src/proposals.ts`.
 */

export interface ImprovementProposalRow {
  readonly id: string;
  readonly layerId: string;
  readonly status: ProposalStatus;
  readonly artifactKind: ArtifactKind;
  readonly problemSummary: string;
  readonly proposedSpecJson: string;
  readonly expectedImpactJson: string;
  readonly threshold: number;
  readonly capabilitySnapshotJson: string;
  readonly mintedByRunId: string;
  readonly mintedAt: string;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly rejectedBy: string | null;
  readonly rejectedAt: string | null;
  readonly rejectedReason: string | null;
  readonly activatedAt: string | null;
  readonly deletedAt: string | null;
  readonly deletedBy: string | null;
}

interface SqlRow {
  id: string;
  layer_id: string;
  status: ProposalStatus;
  artifact_kind: ArtifactKind;
  problem_summary: string;
  proposed_spec_json: string;
  expected_impact_json: string;
  threshold: number;
  capability_snapshot_json: string;
  minted_by_run_id: string;
  minted_at: string;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejected_reason: string | null;
  activated_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface InsertImprovementProposalInput {
  readonly id: string;
  readonly layerId: string;
  readonly status: ProposalStatus;
  readonly artifactKind: ArtifactKind;
  readonly problemSummary: string;
  readonly proposedSpecJson: string;
  readonly expectedImpactJson: string;
  readonly threshold: number;
  readonly capabilitySnapshotJson: string;
  readonly mintedByRunId: string;
  readonly mintedAt: string;
}

export type ProposalSortBy = 'mintedAt' | 'threshold';

export interface ListImprovementProposalsFilter {
  readonly layerId: string;
  readonly status?: ProposalStatus;
  readonly sortBy?: ProposalSortBy;
  readonly includeDeleted?: boolean;
}

export interface UpdateProposalStatusPatch {
  readonly status: ProposalStatus;
  readonly approvedBy?: string | null;
  readonly approvedAt?: string | null;
  readonly rejectedBy?: string | null;
  readonly rejectedAt?: string | null;
  readonly rejectedReason?: string | null;
  readonly activatedAt?: string | null;
}

export interface ImprovementProposalsRepo {
  insertProposal(input: InsertImprovementProposalInput): ImprovementProposalRow;
  getProposalById(id: string): ImprovementProposalRow | null;
  listProposals(filter: ListImprovementProposalsFilter): ImprovementProposalRow[];
  updateStatus(id: string, patch: UpdateProposalStatusPatch): ImprovementProposalRow;
  softDeleteProposal(id: string, deletedBy: string, now: string): void;
  restoreProposal(id: string): void;
}

const COLS =
  'id, layer_id, status, artifact_kind, problem_summary, ' +
  'proposed_spec_json, expected_impact_json, threshold, ' +
  'capability_snapshot_json, minted_by_run_id, minted_at, ' +
  'approved_by, approved_at, rejected_by, rejected_at, rejected_reason, ' +
  'activated_at, deleted_at, deleted_by';

function rowToProposal(row: SqlRow): ImprovementProposalRow {
  return {
    id: row.id,
    layerId: row.layer_id,
    status: row.status,
    artifactKind: row.artifact_kind,
    problemSummary: row.problem_summary,
    proposedSpecJson: row.proposed_spec_json,
    expectedImpactJson: row.expected_impact_json,
    threshold: row.threshold,
    capabilitySnapshotJson: row.capability_snapshot_json,
    mintedByRunId: row.minted_by_run_id,
    mintedAt: row.minted_at,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    rejectedBy: row.rejected_by,
    rejectedAt: row.rejected_at,
    rejectedReason: row.rejected_reason,
    activatedAt: row.activated_at,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
  };
}

export function createImprovementProposalsRepo(db: Database): ImprovementProposalsRepo {
  const insert = db.query<
    unknown,
    [
      string,
      string,
      ProposalStatus,
      ArtifactKind,
      string,
      string,
      string,
      number,
      string,
      string,
      string,
    ]
  >(
    `INSERT INTO improvement_proposals
       (id, layer_id, status, artifact_kind, problem_summary,
        proposed_spec_json, expected_impact_json, threshold,
        capability_snapshot_json, minted_by_run_id, minted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const findById = db.query<SqlRow, [string]>(
    `SELECT ${COLS} FROM improvement_proposals WHERE id = ?`,
  );

  const softDelete = db.query<unknown, [string, string, string]>(
    `UPDATE improvement_proposals
        SET deleted_at = ?, deleted_by = ?
      WHERE id = ? AND deleted_at IS NULL`,
  );

  const restore = db.query<unknown, [string]>(
    `UPDATE improvement_proposals
        SET deleted_at = NULL, deleted_by = NULL
      WHERE id = ?`,
  );

  return {
    insertProposal(input) {
      insert.run(
        input.id,
        input.layerId,
        input.status,
        input.artifactKind,
        input.problemSummary,
        input.proposedSpecJson,
        input.expectedImpactJson,
        input.threshold,
        input.capabilitySnapshotJson,
        input.mintedByRunId,
        input.mintedAt,
      );
      const row = findById.get(input.id);
      if (row === null) {
        throw new Error(
          `improvement-proposals-repo: failed to read back proposal ${input.id} after insert`,
        );
      }
      return rowToProposal(row);
    },

    getProposalById(id) {
      const row = findById.get(id);
      return row === null ? null : rowToProposal(row);
    },

    listProposals(filter) {
      const where: string[] = ['layer_id = ?'];
      const params: (string | number)[] = [filter.layerId];
      if (filter.includeDeleted !== true) {
        where.push('deleted_at IS NULL');
      }
      if (filter.status !== undefined) {
        where.push('status = ?');
        params.push(filter.status);
      }
      const orderBy =
        filter.sortBy === 'threshold' ? 'threshold DESC, minted_at DESC' : 'minted_at DESC';
      const sql =
        `SELECT ${COLS} FROM improvement_proposals ` +
        `WHERE ${where.join(' AND ')} ORDER BY ${orderBy}`;
      const rows = db.query<SqlRow, typeof params>(sql).all(...params);
      return rows.map(rowToProposal);
    },

    updateStatus(id, patch) {
      const sets: string[] = ['status = ?'];
      const params: (string | null)[] = [patch.status];
      if (patch.approvedBy !== undefined) {
        sets.push('approved_by = ?');
        params.push(patch.approvedBy);
      }
      if (patch.approvedAt !== undefined) {
        sets.push('approved_at = ?');
        params.push(patch.approvedAt);
      }
      if (patch.rejectedBy !== undefined) {
        sets.push('rejected_by = ?');
        params.push(patch.rejectedBy);
      }
      if (patch.rejectedAt !== undefined) {
        sets.push('rejected_at = ?');
        params.push(patch.rejectedAt);
      }
      if (patch.rejectedReason !== undefined) {
        sets.push('rejected_reason = ?');
        params.push(patch.rejectedReason);
      }
      if (patch.activatedAt !== undefined) {
        sets.push('activated_at = ?');
        params.push(patch.activatedAt);
      }
      const sql = `UPDATE improvement_proposals SET ${sets.join(', ')} WHERE id = ?`;
      params.push(id);
      db.query<unknown, typeof params>(sql).run(...params);
      const row = findById.get(id);
      if (row === null) {
        throw new Error(`improvement-proposals-repo: proposal ${id} not found after update`);
      }
      return rowToProposal(row);
    },

    softDeleteProposal(id, deletedBy, now) {
      softDelete.run(now, deletedBy, id);
    },

    restoreProposal(id) {
      restore.run(id);
    },
  };
}
