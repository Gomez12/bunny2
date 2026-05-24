/**
 * Phase 7.3 — `proposal.*` bus event taxonomy.
 *
 * Mirrors the shape used by `chat/events.ts` and
 * `scheduled/events.ts`: a closed const tuple of event-type strings
 * plus one typed payload interface per row. The per-layer review
 * agent (`chat.review-layer`) publishes `proposal.minted` once per
 * proposal it inserts; later sub-phases (7.4 sandbox, 7.5
 * activation) extend this taxonomy with `proposal.activated` /
 * `proposal.superseded` / `proposal.rejected`.
 *
 * Anti-leak invariants (per `phase-07-self-learning.md` §10):
 *  - Payloads carry IDs only — `proposalId`, `layerId`, `artifactKind`,
 *    `threshold`, `mintedByRunId`. They MUST NOT carry the cluster
 *    summary, the proposed-spec body, or any chat message content;
 *    those live in `improvement_proposals` rows behind the
 *    authenticated proposals routes (phase 7.6).
 *  - `artifactKind` is the closed enum from
 *    `packages/shared/src/proposals.ts` so subscribers can fan-out
 *    on the value without joining the proposals table.
 *  - The event is published through the in-process bus (the chat
 *    pipeline + scheduled-task subscriber model), not the durable
 *    outbox; UI widgets and the future tool-calling answerer
 *    subscribe in-process.
 */

import type { ArtifactKind } from '@bunny2/shared';

export const PROPOSAL_EVENT_TYPES = [
  'proposal.minted',
  'proposal.activated',
  'proposal.superseded',
  'proposal.deactivated',
  'proposal.rejected',
  'proposal.auto-activated',
] as const;

export type ProposalEventType = (typeof PROPOSAL_EVENT_TYPES)[number];

/**
 * Fired once per proposal inserted by the per-layer review agent.
 * The subscriber-side `ProposalsWidget` (phase 7.6) and the future
 * threshold-gated activation path (phase 8) both consume it.
 */
export interface ProposalMintedPayload {
  readonly proposalId: string;
  readonly layerId: string;
  readonly artifactKind: ArtifactKind;
  readonly threshold: number;
  readonly mintedByRunId: string;
}

export const PROPOSAL_MINTED_EVENT_TYPE: ProposalEventType = 'proposal.minted';

/**
 * Fired once per `layer_capabilities` insert from the activation path
 * (phase 7.4 `replanOnApproval` or future phase-8 threshold-gated
 * automation). Carries IDs only (anti-leak invariant — no spec body).
 *
 * `proposalId` is optional because the activation surface accepts
 * `origin='builtin'` rows too (phase 7.5 + boot path will use it).
 * For proposal-driven activations the field is always set.
 */
export interface ProposalActivatedPayload {
  readonly layerId: string;
  readonly artifactKind: ArtifactKind;
  readonly capabilityId: string;
  readonly origin: string;
  readonly proposalId?: string;
}

export const PROPOSAL_ACTIVATED_EVENT_TYPE: ProposalEventType = 'proposal.activated';

/**
 * Fired when the re-plan path determines that the gap is already
 * covered by a newer capability (drift, gap covered) OR the
 * re-planned spec didn't help (superseded-after-replan).
 * `outcome` lets subscribers distinguish without re-reading the
 * proposal row.
 */
export interface ProposalSupersededPayload {
  readonly proposalId: string;
  readonly layerId: string;
  readonly outcome: 'superseded' | 'superseded-after-replan';
}

export const PROPOSAL_SUPERSEDED_EVENT_TYPE: ProposalEventType = 'proposal.superseded';

/**
 * Fired when an active capability is admin-deactivated (phase 7.5
 * `capabilityRegistry.deactivate(...)`). Carries the capability's id
 * + the actor's user id so subscribers (Kanban badge cleanup, the
 * future audit-log surface) can react without re-reading the row.
 *
 * `capabilityId` references `layer_capabilities.id`; for proposal-
 * backed capabilities the origin string carries the proposal id.
 */
export interface ProposalDeactivatedPayload {
  readonly layerId: string;
  readonly artifactKind: ArtifactKind;
  readonly capabilityId: string;
  readonly name: string;
  readonly deactivatedBy: string;
}

export const PROPOSAL_DEACTIVATED_EVENT_TYPE: ProposalEventType = 'proposal.deactivated';

/**
 * Fired when an admin rejects a proposal (phase 7.6 HTTP route).
 * Carries IDs + the actor only; the reason text stays in the
 * `improvement_proposals.rejected_reason` column, behind the
 * authenticated detail route. Subscribers (audit log, future
 * dashboard summaries) react without joining the proposals table.
 */
export interface ProposalRejectedPayload {
  readonly proposalId: string;
  readonly layerId: string;
  readonly rejectedBy: string;
}

export const PROPOSAL_REJECTED_EVENT_TYPE: ProposalEventType = 'proposal.rejected';

/**
 * Phase 8.3 — fired by the `proposals.auto-activate` scheduled-task
 * handler on every proposal that passes all seven gates (ADR 0026 §1)
 * and lands one of the four `replanOnApproval` outcome labels. The
 * `outcome` carries the four-outcome verdict so subscribers can
 * distinguish "system activated this skill" from "system tried but
 * was superseded by drift" without re-reading the proposal row.
 *
 * Anti-leak: IDs + closed enums only. The `auto_activation_decision_json`
 * is NOT carried on the wire — it lives on the proposal row behind
 * the authenticated detail route (the UI fetches it there).
 * `threshold` is the LLM-minted 0..1 number (already public via
 * `proposal.minted`); no new sensitive surface.
 */
export interface ProposalAutoActivatedPayload {
  readonly proposalId: string;
  readonly layerId: string;
  readonly artifactKind: ArtifactKind;
  readonly outcome:
    | 'activated-asis'
    | 'activated-replanned'
    | 'superseded'
    | 'superseded-after-replan';
  readonly threshold: number;
}

export const PROPOSAL_AUTO_ACTIVATED_EVENT_TYPE: ProposalEventType = 'proposal.auto-activated';
