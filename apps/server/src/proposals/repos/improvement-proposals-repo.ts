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
  /**
   * Phase 8.1 — auto-activation audit columns. Set by the
   * auto-activate job (8.3); always NULL on rows created before
   * 8.3 ships and on rows the auto-path skipped. See migration
   * `0017_proposals_phase8.sql` and ADR 0026.
   */
  readonly autoActivatedBy: string | null;
  readonly autoActivatedAt: string | null;
  readonly autoActivationDecisionJson: string | null;
  /**
   * Phase 8.1 — manual rollback columns. Set by the rollback
   * route (8.5) in the same transaction the capability is
   * soft-deactivated. See ADR 0027.
   */
  readonly rolledBackAt: string | null;
  readonly rolledBackBy: string | null;
  readonly rolledBackReason: string | null;
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
  auto_activated_by: string | null;
  auto_activated_at: string | null;
  auto_activation_decision_json: string | null;
  rolled_back_at: string | null;
  rolled_back_by: string | null;
  rolled_back_reason: string | null;
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

export type ProposalSortBy = 'mintedAt' | 'threshold' | 'impact';

export interface ListImprovementProposalsFilter {
  readonly layerId: string;
  readonly status?: ProposalStatus;
  readonly sortBy?: ProposalSortBy;
  readonly includeDeleted?: boolean;
  /** Phase 7.6 — page size for the HTTP list route. */
  readonly limit?: number;
  /** Phase 7.6 — page offset for the HTTP list route. */
  readonly offset?: number;
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
  /** Phase 7.6 — total row count for pagination envelopes. */
  countProposals(
    filter: Pick<ListImprovementProposalsFilter, 'layerId' | 'status' | 'includeDeleted'>,
  ): number;
  updateStatus(id: string, patch: UpdateProposalStatusPatch): ImprovementProposalRow;
  softDeleteProposal(id: string, deletedBy: string, now: string): void;
  restoreProposal(id: string): void;
  /**
   * Phase 8.1 — writes `auto_activation_decision_json` only. Called
   * by the auto-activate job (8.3) *before* `replanOnApproval`, so
   * a mid-flight failure still leaves a forensic trail
   * (ADR 0026 §4). No status guard — callers own the status.
   */
  recordAutoActivationDecision(id: string, decisionJson: string): void;
  /**
   * Phase 8.1 — writes `auto_activated_by = 'system'` and
   * `auto_activated_at`. Status is left as the caller set it via
   * the normal activate path; this method only stamps the
   * audit columns (ADR 0026 §4).
   */
  recordAutoActivation(id: string, now: string): void;
  /**
   * Phase 8.1 — writes the three rollback columns
   * (`rolled_back_at`, `rolled_back_by`, `rolled_back_reason`).
   * Capability deactivation is handled by the rollback route via
   * `capabilityRegistry.deactivate(...)`; this repo only owns the
   * audit row (ADR 0027 §2).
   */
  recordRollback(
    id: string,
    opts: { readonly rolledBackBy: string; readonly reason: string; readonly now: string },
  ): void;
}

const COLS =
  'id, layer_id, status, artifact_kind, problem_summary, ' +
  'proposed_spec_json, expected_impact_json, threshold, ' +
  'capability_snapshot_json, minted_by_run_id, minted_at, ' +
  'approved_by, approved_at, rejected_by, rejected_at, rejected_reason, ' +
  'activated_at, deleted_at, deleted_by, ' +
  'auto_activated_by, auto_activated_at, auto_activation_decision_json, ' +
  'rolled_back_at, rolled_back_by, rolled_back_reason';

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
    autoActivatedBy: row.auto_activated_by,
    autoActivatedAt: row.auto_activated_at,
    autoActivationDecisionJson: row.auto_activation_decision_json,
    rolledBackAt: row.rolled_back_at,
    rolledBackBy: row.rolled_back_by,
    rolledBackReason: row.rolled_back_reason,
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

  // Phase 8.1 — auto-activation + rollback audit writes. Each
  // statement updates only the columns it owns; the caller (the
  // auto-activate job in 8.3 / the rollback route in 8.5) sequences
  // the writes around the existing `updateStatus` and the
  // capability-registry side-effects.
  const writeAutoDecision = db.query<unknown, [string, string]>(
    `UPDATE improvement_proposals
        SET auto_activation_decision_json = ?
      WHERE id = ?`,
  );

  const writeAutoActivation = db.query<unknown, [string, string, string]>(
    `UPDATE improvement_proposals
        SET auto_activated_by = ?, auto_activated_at = ?
      WHERE id = ?`,
  );

  const writeRollback = db.query<unknown, [string, string, string, string]>(
    `UPDATE improvement_proposals
        SET rolled_back_at = ?, rolled_back_by = ?, rolled_back_reason = ?
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
      let orderBy = 'minted_at DESC';
      if (filter.sortBy === 'threshold') orderBy = 'threshold DESC, minted_at DESC';
      // Phase 7.6 — `impact` sorts by the JSON `thumbsUpDelta` field.
      // SQLite's `json_extract` is fine here; the column carries a
      // small object and we only use it for ordering, never indexing.
      if (filter.sortBy === 'impact')
        orderBy =
          "CAST(COALESCE(json_extract(expected_impact_json, '$.thumbsUpDelta'), 0) AS REAL) DESC, minted_at DESC";
      let sql =
        `SELECT ${COLS} FROM improvement_proposals ` +
        `WHERE ${where.join(' AND ')} ORDER BY ${orderBy}`;
      if (typeof filter.limit === 'number' && filter.limit > 0) {
        sql += ` LIMIT ?`;
        params.push(filter.limit);
        if (typeof filter.offset === 'number' && filter.offset > 0) {
          sql += ` OFFSET ?`;
          params.push(filter.offset);
        }
      }
      const rows = db.query<SqlRow, typeof params>(sql).all(...params);
      return rows.map(rowToProposal);
    },

    /**
     * Phase 7.6 — total count for the list-route pagination
     * envelope. Mirrors `listProposals`'s filter shape (minus
     * sort/limit/offset).
     */
    countProposals(filter) {
      const where: string[] = ['layer_id = ?'];
      const params: (string | number)[] = [filter.layerId];
      if (filter.includeDeleted !== true) {
        where.push('deleted_at IS NULL');
      }
      if (filter.status !== undefined) {
        where.push('status = ?');
        params.push(filter.status);
      }
      const sql = `SELECT COUNT(*) AS n FROM improvement_proposals WHERE ${where.join(' AND ')}`;
      const row = db.query<{ n: number }, typeof params>(sql).get(...params);
      return row?.n ?? 0;
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

    recordAutoActivationDecision(id, decisionJson) {
      writeAutoDecision.run(decisionJson, id);
    },

    recordAutoActivation(id, now) {
      // ADR 0026 §3 — `'system'` is a fixed literal here, never a
      // `users.id`. The user FK columns (`approved_by`,
      // `rolled_back_by`) stay clean because no `system` user row
      // is ever inserted.
      writeAutoActivation.run('system', now, id);
    },

    recordRollback(id, opts) {
      writeRollback.run(opts.now, opts.rolledBackBy, opts.reason, id);
    },
  };
}
