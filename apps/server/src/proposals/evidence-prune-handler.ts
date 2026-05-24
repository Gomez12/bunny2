/**
 * Phase 7.6 — `proposals.evidence.prune` scheduled-task handler.
 *
 * Retention for the proposal-evidence + proposal-artifact tables.
 * Mirrors the shape of `chat.runs.prune` (`apps/server/src/chat/runs-prune-handler.ts`)
 * and the plan §2 "two new scheduled-task kinds" bullet.
 *
 *  - Default cutoff: proposals older than 90 days.
 *  - Only operates on proposals in a TERMINAL status
 *    (`rejected | superseded | activated-then-deactivated`). The
 *    `'new'`, `'approved'`, and `'activated'` statuses keep their
 *    evidence + artifacts so admins can still consult them.
 *  - The proposal row itself is NEVER deleted — only the heavy
 *    child rows (evidence + artifacts). The audit trail on
 *    `improvement_proposals` survives indefinitely.
 *  - Wrapped in a single `db.transaction(...)` so a partial prune
 *    mid-crash never leaves orphans behind.
 *
 * "activated-then-deactivated" is recognised as a proposal whose
 * `status='activated'` AND whose `activated_at IS NOT NULL` AND
 * whose backing capability row (`origin = 'proposal:<id>'`) has
 * `deactivated_at IS NOT NULL`. The deactivation cuts the proposal
 * loose from the live registry; the evidence is then archival only.
 */

import type { Database } from 'bun:sqlite';
import type { ScheduledTaskHandler, ScheduledTaskRunContext } from '../scheduled';

export const PROPOSALS_EVIDENCE_PRUNE_KIND = 'proposals.evidence.prune';

const DEFAULT_MAX_AGE_DAYS = 90;
const DEFAULT_INTERVAL_MINUTES = 60 * 24;

export interface ProposalsEvidencePruneConfig {
  readonly maxAgeDays: number;
}

export interface ProposalsEvidencePruneResult {
  readonly evidenceDeleted: number;
  readonly artifactsDeleted: number;
  readonly proposalsTouched: number;
}

function readConfig(raw: Readonly<Record<string, unknown>>): ProposalsEvidencePruneConfig {
  return { maxAgeDays: pickPositiveInt(raw['maxAgeDays'], DEFAULT_MAX_AGE_DAYS) };
}

function pickPositiveInt(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0 && Number.isInteger(v)) {
    return v;
  }
  return fallback;
}

/**
 * SELECT proposals that are older than the cutoff and in a terminal
 * status; for each, delete its evidence + artifact rows. Returns the
 * per-row counts so the handler can emit telemetry + log them.
 *
 * Terminal predicate (matches plan §2):
 *   - `status IN ('rejected', 'superseded')` — bus-event-driven
 *     terminal states.
 *   - "activated-then-deactivated": status='activated' AND every
 *     `layer_capabilities` row whose `origin = 'proposal:<id>'` has
 *     `deactivated_at IS NOT NULL`. SQL captures this via NOT EXISTS
 *     on an active row.
 *
 * Pure function so ad-hoc maintenance scripts + tests can drive it.
 */
export function pruneProposalEvidence(
  db: Database,
  opts: ProposalsEvidencePruneConfig,
  now: Date,
): ProposalsEvidencePruneResult {
  const cutoffIso = new Date(now.getTime() - opts.maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

  // Match every proposal that is terminal AND older than the cutoff.
  // The OR splits the "rejected/superseded" rows (where minted_at is
  // the only timestamp we have) from "activated-then-deactivated"
  // rows (where the deactivation timestamp is the right age anchor).
  const selectProposalsSql = `
    SELECT id FROM improvement_proposals p
     WHERE deleted_at IS NULL
       AND (
         (p.status IN ('rejected','superseded') AND p.minted_at < ?)
         OR (
           p.status = 'activated'
           AND p.activated_at IS NOT NULL
           AND p.activated_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM layer_capabilities c
              WHERE c.origin = 'proposal:' || p.id
                AND c.deactivated_at IS NULL
           )
           AND EXISTS (
             SELECT 1 FROM layer_capabilities c
              WHERE c.origin = 'proposal:' || p.id
                AND c.deactivated_at IS NOT NULL
           )
         )
       )
  `;

  const tx = db.transaction((cutoff: string): ProposalsEvidencePruneResult => {
    const proposalRows = db
      .query<{ id: string }, [string, string]>(selectProposalsSql)
      .all(cutoff, cutoff);
    if (proposalRows.length === 0) {
      return { evidenceDeleted: 0, artifactsDeleted: 0, proposalsTouched: 0 };
    }
    let evidenceDeleted = 0;
    let artifactsDeleted = 0;
    const deleteEvidence = db.query<unknown, [string]>(
      `DELETE FROM improvement_proposal_evidence WHERE proposal_id = ?`,
    );
    const deleteArtifacts = db.query<unknown, [string]>(
      `DELETE FROM improvement_proposal_artifacts WHERE proposal_id = ?`,
    );
    for (const row of proposalRows) {
      evidenceDeleted += deleteEvidence.run(row.id).changes;
      artifactsDeleted += deleteArtifacts.run(row.id).changes;
    }
    return {
      evidenceDeleted,
      artifactsDeleted,
      proposalsTouched: proposalRows.length,
    };
  });
  return tx(cutoffIso);
}

export const proposalsEvidencePruneHandler: ScheduledTaskHandler = {
  kind: PROPOSALS_EVIDENCE_PRUNE_KIND,
  defaultSchedule: { kind: 'interval', intervalMinutes: DEFAULT_INTERVAL_MINUTES },
  async run(ctx: ScheduledTaskRunContext): Promise<void> {
    const config = readConfig(ctx.task.config);
    const now = new Date(ctx.now());
    const result = pruneProposalEvidence(ctx.db, config, now);
    if (result.proposalsTouched > 0 || result.evidenceDeleted > 0 || result.artifactsDeleted > 0) {
      ctx.logger.info('proposals.evidence-prune deleted', {
        event: 'proposals.evidence-prune.deleted',
        proposalsTouched: result.proposalsTouched,
        evidenceDeleted: result.evidenceDeleted,
        artifactsDeleted: result.artifactsDeleted,
        maxAgeDays: config.maxAgeDays,
      });
    }
  },
};
