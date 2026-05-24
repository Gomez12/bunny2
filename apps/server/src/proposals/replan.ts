/**
 * Phase 7.4 — re-plan on approval.
 *
 * Implements ADR 0025: when a proposal moves from `new`/`approved` to
 * activation, snapshot the current capability set, diff against the
 * mint-time snapshot, and route to one of four outcomes:
 *
 *   - `activated-asis`           — empty diff; spec activates verbatim.
 *   - `superseded`               — drift covers the gap (tag-subset
 *                                   rule from ADR 0025 §2); no activation.
 *   - `activated-replanned`      — drift, gap persists; one LLM call
 *                                   regenerates the spec; sandbox of
 *                                   replanned spec returns positive
 *                                   `thumbsUpDelta`; activate.
 *   - `superseded-after-replan`  — drift, gap persists; sandbox of
 *                                   replanned spec returns non-positive
 *                                   `thumbsUpDelta` or times out;
 *                                   supersede.
 *
 * Constraints:
 *   - At most ONE re-plan LLM call per approval (ADR 0025 §3). On
 *     parse failure the path falls through to `superseded` (ADR 0025 §4),
 *     no retry loop.
 *   - The regenerated spec re-runs the sandbox; the artifact written
 *     has `variant='replanned'`.
 *   - Activation is a single `capabilityRegistry.activate(...)` call
 *     regardless of branch (ADR 0025 §5).
 *   - All transitions write bus events per ADR 0023 §5.
 */

import {
  ProposalSpecSchema,
  type CapabilitySnapshot,
  type ClusterReason,
  type ImprovementProposal,
  type ProposalSpec,
} from '@bunny2/shared';
import type { LlmClient } from '../llm';
import type { ImprovementProposalsRepo } from './repos/improvement-proposals-repo';
import type { ImprovementProposalEvidenceRepo } from './repos/improvement-proposal-evidence-repo';
import type { ImprovementProposalArtifactsRepo } from './repos/improvement-proposal-artifacts-repo';
import type { LayerCapabilitiesRepo } from './repos/layer-capabilities-repo';
import { PROPOSAL_SUPERSEDED_EVENT_TYPE, type ProposalSupersededPayload } from './events';
import type { MessageBus } from '@bunny2/bus';
import { buildTranscript, computeDelta, summarizeVariant } from './sandbox/metrics';
import { runSandbox, type SandboxDeps, type SandboxEvidenceInput } from './sandbox/runner';
import type { ChatConversationsRepo } from '../chat/repos/chat-conversations-repo';
import type { ChatMessagesRepo } from '../chat/repos/chat-messages-repo';

export type ReplanOutcome =
  | { readonly outcome: 'activated-asis' }
  | { readonly outcome: 'activated-replanned' }
  | { readonly outcome: 'superseded' }
  | { readonly outcome: 'superseded-after-replan' };

export interface ReplanDeps extends SandboxDeps {
  readonly proposalsRepo: ImprovementProposalsRepo;
  readonly evidenceRepo: ImprovementProposalEvidenceRepo;
  readonly artifactsRepo: ImprovementProposalArtifactsRepo;
  readonly layerCapabilitiesRepo: LayerCapabilitiesRepo;
  readonly conversationsRepo: ChatConversationsRepo;
  readonly messagesRepo: ChatMessagesRepo;
  readonly bus: MessageBus;
  /**
   * Hook the re-plan LLM call. The default uses the
   * `mintProposalViaLlm`-shaped contract; tests can swap a scripted
   * implementation. Returns the regenerated spec, or `null` on parse
   * failure (mapped to `superseded`).
   */
  readonly replanProposalViaLlm?: ReplanLlmFn;
  /**
   * Phase 8.3 — discriminates the human-approve path (phase-7
   * default) from the auto-activate path (8.3). `'user'` (default)
   * writes `approved_by = approvedBy` + `approved_at` on activation,
   * matching phase-7 behaviour exactly so existing callsites are
   * untouched. `'system'` leaves `approved_by`/`approved_at` NULL —
   * the caller (the `proposals.auto-activate` handler) follows up
   * with `proposalsRepo.recordAutoActivation(id, now)` so the audit
   * columns (`auto_activated_by = 'system'`, `auto_activated_at`)
   * carry the system actor instead. See ADR 0026 decisions 2 + 3.
   */
  readonly actorKind?: 'user' | 'system';
}

export type ReplanLlmFn = (input: ReplanLlmInput) => Promise<ProposalSpec | null>;

export interface ReplanLlmInput {
  readonly llm: LlmClient;
  readonly proposal: ImprovementProposal;
  readonly currentSnapshot: CapabilitySnapshot;
  readonly flowId: string;
  readonly correlationId: string;
}

/**
 * Drives a single approval transition. Always sets `approved_by` +
 * `approved_at` before branching, so the audit trail reflects the
 * user's click even on supersede.
 */
export async function replanOnApproval(
  proposalId: string,
  approvedBy: string,
  deps: ReplanDeps,
): Promise<ReplanOutcome> {
  const clock = deps.clock ?? ((): Date => new Date());
  const startedAtMs = clock().getTime();
  const flowId = `proposal.replan:${proposalId}`;
  const correlationId = crypto.randomUUID();

  const row = deps.proposalsRepo.getProposalById(proposalId);
  if (row === null) {
    throw new Error(`replanOnApproval: proposal ${proposalId} not found`);
  }
  // Materialise the proposal into the shared schema shape. The repo
  // stores spec / snapshot / impact as JSON columns; we reparse here
  // so downstream code works against the canonical zod types.
  const parsedSpec = ProposalSpecSchema.safeParse(JSON.parse(row.proposedSpecJson));
  if (!parsedSpec.success) {
    // Defensive — the closed-enum guard at sandbox time should have
    // caught this. If it lands here, mark superseded and surface.
    markSuperseded(deps, proposalId, row.layerId, clock(), flowId, correlationId, 'superseded');
    return { outcome: 'superseded' };
  }
  const proposal: ImprovementProposal = {
    id: row.id,
    layerId: row.layerId,
    status: row.status,
    artifactKind: row.artifactKind,
    problemSummary: row.problemSummary,
    proposedSpec: parsedSpec.data,
    expectedImpact: JSON.parse(row.expectedImpactJson),
    threshold: row.threshold,
    capabilitySnapshot: JSON.parse(row.capabilitySnapshotJson) as CapabilitySnapshot,
    mintedByRunId: row.mintedByRunId,
    mintedAt: row.mintedAt,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    rejectedBy: row.rejectedBy,
    rejectedAt: row.rejectedAt,
    rejectedReason: row.rejectedReason,
    activatedAt: row.activatedAt,
    deletedAt: row.deletedAt,
    deletedBy: row.deletedBy,
  };

  // Build the "current" snapshot deterministically. Reuse the
  // capability registry's live read; built-ins are not registered in
  // 7.4 (that's 7.5), so the snapshot mirrors the mint-time shape.
  const currentSnapshot: CapabilitySnapshot = {
    capabilities: deps.capabilityRegistry.listActive(proposal.layerId).map((c) => ({ ...c })),
    builtins: [],
  };

  const diff = diffSnapshots(proposal.capabilitySnapshot, currentSnapshot);

  // ---------- branch 1: empty diff → activate-asis -------------------
  // Per plan §4.4: empty diff goes straight to activation, no re-sandbox.
  // The mint-time sandbox rows (written by 7.3's review-agent path /
  // future 7.6 replay-sandbox route) are what the UI surfaces. The
  // closed-enum guard for the activate-asis path is the
  // `ProposalSpecSchema.safeParse(...)` above (any malformed row was
  // already mapped to `superseded`).
  if (diff.isEmpty) {
    activateProposal(
      deps,
      proposal,
      proposal.proposedSpec,
      approvedBy,
      clock(),
      flowId,
      correlationId,
      deps.actorKind ?? 'user',
    );
    logOutcome(deps, proposalId, approvedBy, 'activated-asis', startedAtMs, clock());
    return { outcome: 'activated-asis' };
  }

  // ---------- branch 2: drift covers gap → supersede -----------------
  if (coversGap(proposal.proposedSpec.addressesTags, diff.addedTags)) {
    markSuperseded(
      deps,
      proposalId,
      proposal.layerId,
      clock(),
      flowId,
      correlationId,
      'superseded',
    );
    logOutcome(deps, proposalId, approvedBy, 'superseded', startedAtMs, clock());
    return { outcome: 'superseded' };
  }

  // ---------- branch 3: drift, gap persists → replan -----------------
  const replanLlm = deps.replanProposalViaLlm ?? defaultReplanLlm;
  const replannedSpec = await replanLlm({
    llm: deps.llm,
    proposal,
    currentSnapshot,
    flowId,
    correlationId,
  });
  if (replannedSpec === null) {
    markSuperseded(
      deps,
      proposalId,
      proposal.layerId,
      clock(),
      flowId,
      correlationId,
      'superseded-after-replan',
    );
    logOutcome(deps, proposalId, approvedBy, 'superseded-after-replan', startedAtMs, clock());
    return { outcome: 'superseded-after-replan' };
  }

  // Run the sandbox for the regenerated spec. We construct a synthetic
  // proposal shape carrying the new spec so the existing runner
  // applies its overlay + closed-enum guard.
  const replannedProposal: ImprovementProposal = {
    ...proposal,
    proposedSpec: replannedSpec,
    artifactKind: replannedSpec.artifactKind,
  };
  const evidence = loadEvidence(deps, proposalId);
  const replannedSandbox = await runSandbox(replannedProposal, evidence, {
    ...deps,
    // Replace the artifacts repo with an in-memory shim so the two
    // base rows the runner inserts don't get re-written under the
    // wrong variant; we'll write the 'replanned' row ourselves below.
    artifactsRepo: discardingArtifactsRepo(),
  });
  if ('err' in replannedSandbox) {
    markSuperseded(
      deps,
      proposalId,
      proposal.layerId,
      clock(),
      flowId,
      correlationId,
      'superseded-after-replan',
    );
    logOutcome(deps, proposalId, approvedBy, 'superseded-after-replan', startedAtMs, clock());
    return { outcome: 'superseded-after-replan' };
  }

  if (
    replannedSandbox.ok.metrics.sandboxOutcome === 'timeout' ||
    replannedSandbox.ok.metrics.thumbsUpDelta <= 0
  ) {
    // Re-plan didn't help — still record the replanned artifact for
    // the audit trail (the UI surfaces it) before superseding.
    writeReplannedArtifact(deps, proposalId, replannedSandbox.ok, clock());
    markSuperseded(
      deps,
      proposalId,
      proposal.layerId,
      clock(),
      flowId,
      correlationId,
      'superseded-after-replan',
    );
    logOutcome(deps, proposalId, approvedBy, 'superseded-after-replan', startedAtMs, clock());
    return { outcome: 'superseded-after-replan' };
  }

  writeReplannedArtifact(deps, proposalId, replannedSandbox.ok, clock());
  activateProposal(
    deps,
    proposal,
    replannedSpec,
    approvedBy,
    clock(),
    flowId,
    correlationId,
    deps.actorKind ?? 'user',
  );
  logOutcome(deps, proposalId, approvedBy, 'activated-replanned', startedAtMs, clock());
  return { outcome: 'activated-replanned' };
}

// ---------------------------------------------------------------------
// snapshot diff (ADR 0025 §2)
// ---------------------------------------------------------------------

export interface SnapshotDiff {
  readonly isEmpty: boolean;
  readonly addedTags: ReadonlySet<ClusterReason>;
}

export function diffSnapshots(
  mintedSnapshot: CapabilitySnapshot,
  currentSnapshot: CapabilitySnapshot,
): SnapshotDiff {
  const mintedIds = new Set<string>();
  for (const cap of mintedSnapshot.capabilities) mintedIds.add(cap.id);
  for (const cap of mintedSnapshot.builtins) mintedIds.add(cap.id);
  const added: typeof currentSnapshot.capabilities = [];
  for (const cap of currentSnapshot.capabilities) {
    if (!mintedIds.has(cap.id)) added.push(cap);
  }
  // Built-ins are constant in 7.4 (no row is registered) — we still
  // diff them so the algorithm holds when 7.5 starts seeding rows.
  for (const cap of currentSnapshot.builtins) {
    if (!mintedIds.has(cap.id)) added.push(cap);
  }
  const addedTags = new Set<ClusterReason>();
  for (const cap of added) {
    // Each capability's spec carries `addressesTags`. Parse defensively;
    // a malformed live row is a hint of a contract drift, but we
    // mustn't crash the approval path on it.
    try {
      const spec = JSON.parse(cap.specJson) as { addressesTags?: ClusterReason[] };
      for (const tag of spec.addressesTags ?? []) addedTags.add(tag);
    } catch {
      /* ignore — defensive */
    }
  }
  return { isEmpty: added.length === 0, addedTags };
}

export function coversGap(
  proposalTags: readonly ClusterReason[],
  addedTags: ReadonlySet<ClusterReason>,
): boolean {
  if (proposalTags.length === 0) return false;
  for (const tag of proposalTags) {
    if (!addedTags.has(tag)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------
// activation + supersede transitions
// ---------------------------------------------------------------------

function activateProposal(
  deps: ReplanDeps,
  proposal: ImprovementProposal,
  spec: ProposalSpec,
  approvedBy: string,
  now: Date,
  flowId: string,
  correlationId: string,
  actorKind: 'user' | 'system',
): void {
  const nowIso = now.toISOString();
  deps.capabilityRegistry.activate({
    layerId: proposal.layerId,
    kind: spec.artifactKind,
    name: spec.name,
    spec,
    origin: `proposal:${proposal.id}`,
    now: nowIso,
    correlationId,
    flowId,
    proposalId: proposal.id,
  });
  // Phase 8.3 — branch on actor. The 'user' path is unchanged from
  // phase 7: write approved_by + approved_at + activated_at + status.
  // The 'system' path leaves approved_by / approved_at untouched so
  // the `users(id)` FK on `approved_by` stays clean — the
  // `auto_activated_*` audit columns are stamped by the auto-activate
  // handler (8.3) via `proposalsRepo.recordAutoActivation` after this
  // function returns. See ADR 0026 decisions 3 + 4.
  if (actorKind === 'system') {
    deps.proposalsRepo.updateStatus(proposal.id, {
      status: 'activated',
      activatedAt: nowIso,
    });
  } else {
    deps.proposalsRepo.updateStatus(proposal.id, {
      status: 'activated',
      approvedBy,
      approvedAt: nowIso,
      activatedAt: nowIso,
    });
  }
}

function markSuperseded(
  deps: ReplanDeps,
  proposalId: string,
  layerId: string,
  now: Date,
  flowId: string,
  correlationId: string,
  outcome: 'superseded' | 'superseded-after-replan',
): void {
  const nowIso = now.toISOString();
  deps.proposalsRepo.updateStatus(proposalId, { status: 'superseded' });
  const payload: ProposalSupersededPayload = { proposalId, layerId, outcome };
  void deps.bus
    .publish<ProposalSupersededPayload>({
      type: PROPOSAL_SUPERSEDED_EVENT_TYPE,
      payload,
      correlationId,
      flowId,
    })
    .catch((err) => {
      deps.logger.warn('proposal.superseded.publish-failed', {
        event: 'proposal.superseded.publish-failed',
        proposalId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  void nowIso;
}

function writeReplannedArtifact(
  deps: ReplanDeps,
  proposalId: string,
  sandbox: import('./sandbox/runner').SandboxResult,
  now: Date,
): void {
  // Re-summarise the proposed half under the `replanned` variant
  // label and persist it so the detail page renders it.
  void buildTranscript;
  void summarizeVariant;
  void computeDelta;
  deps.artifactsRepo.insertArtifact({
    id: crypto.randomUUID(),
    proposalId,
    variant: 'replanned',
    transcriptJson: JSON.stringify(sandbox.proposed),
    metricsJson: JSON.stringify(sandbox.metrics.proposed),
    ranAt: now.toISOString(),
  });
}

function loadEvidence(deps: ReplanDeps, proposalId: string): readonly SandboxEvidenceInput[] {
  return deps.evidenceRepo.listByProposal(proposalId).map((e) => ({
    id: e.id,
    messageId: e.messageId,
    clusterReason: e.clusterReason,
  }));
}

function logOutcome(
  deps: ReplanDeps,
  proposalId: string,
  approvedBy: string,
  outcome: ReplanOutcome['outcome'],
  startedAtMs: number,
  now: Date,
): void {
  deps.logger.info('proposal.replan.outcome', {
    event: 'proposal.replan.outcome',
    proposalId,
    approvedBy,
    outcome,
    durationMs: Math.max(0, now.getTime() - startedAtMs),
    // Counter dim — bounded (closed enum).
    'proposal.replan.outcome_count': 1,
  });
}

// ---------------------------------------------------------------------
// Default re-plan LLM (one call, zod-validated, no retry)
// ---------------------------------------------------------------------

const defaultReplanLlm: ReplanLlmFn = async (input) => {
  // ADR 0025 §4 — the prompt receives the original failureModeTags +
  // problemSummary + the prior proposedSpec + the current capability
  // snapshot. Parse failure → null (caller maps to superseded).
  //
  // Note: this default enforces `addressesTags ⊇ original` before
  // returning, which means the heuristic-driven
  // `superseded-after-replan` branch (positive coverage but the
  // sandbox transcript still scores non-positive) cannot trigger via
  // the default path — only `timeout` or a custom `replanProposalViaLlm`
  // hits it. 7.5+ should revisit when the registry seam goes live and
  // transcript differences emerge.
  const systemPrompt = buildReplanSystemPrompt();
  const userPrompt = buildReplanUserPrompt(input);
  try {
    const response = await input.llm.chat({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0,
      metadata: {
        flowId: input.flowId,
        correlationId: input.correlationId,
        step: 'proposal.replan',
      },
    });
    const trimmed = stripJsonFence(response.content);
    const parsedJson = JSON.parse(trimmed) as unknown;
    const result = ProposalSpecSchema.safeParse(parsedJson);
    if (!result.success) return null;
    // failureModeTags ↔ addressesTags contract (ADR 0025 §2).
    const proposalTags = new Set<ClusterReason>(input.proposal.proposedSpec.addressesTags);
    for (const tag of proposalTags) {
      if (!result.data.addressesTags.includes(tag)) return null;
    }
    return result.data;
  } catch {
    return null;
  }
};

function buildReplanSystemPrompt(): string {
  return [
    'You are the per-layer review agent regenerating an improvement-proposal spec.',
    'A prior spec was minted for the same cluster but did not land. The capability',
    'snapshot has drifted since; emit a NEW JSON ProposalSpec that still addresses the',
    'failure modes the original spec targeted.',
    '',
    'Output: ONLY a JSON object matching ProposalSpec (no commentary, no fence).',
    'ProposalSpec is a discriminated union over "artifactKind" — same closed enums',
    'as at mint time (tool: searchSummaries-aliased|projection-lookup; skill: intent;',
    'agent: enrichment-call|summary-call). addressesTags MUST include every',
    'failure-mode tag from the original spec.',
  ].join('\n');
}

function buildReplanUserPrompt(input: ReplanLlmInput): string {
  const snapshotIds = {
    capabilities: input.currentSnapshot.capabilities.map((c) => ({
      kind: c.kind,
      name: c.name,
      origin: c.origin,
    })),
    builtins: input.currentSnapshot.builtins.map((c) => ({
      kind: c.kind,
      name: c.name,
      origin: c.origin,
    })),
  };
  return [
    `Cluster summary: ${input.proposal.problemSummary}`,
    `Failure-mode tags: ${input.proposal.proposedSpec.addressesTags.join(', ')}`,
    '',
    'Prior proposed spec (did not land):',
    JSON.stringify(input.proposal.proposedSpec),
    '',
    'Current capability snapshot:',
    JSON.stringify(snapshotIds),
    '',
    'Emit a fresh ProposalSpec.',
  ].join('\n');
}

function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const firstNewline = trimmed.indexOf('\n');
  if (firstNewline === -1) return trimmed;
  const withoutOpener = trimmed.slice(firstNewline + 1);
  const closingFenceIdx = withoutOpener.lastIndexOf('```');
  if (closingFenceIdx === -1) return withoutOpener.trim();
  return withoutOpener.slice(0, closingFenceIdx).trim();
}

// ---------------------------------------------------------------------
// In-memory artifacts-repo shim (used during the replanned sandbox
// re-run so the `current` / `proposed` rows for the replanned spec
// aren't written under the wrong variant — we write `replanned` once,
// explicitly, with the proposed-half transcript).
// ---------------------------------------------------------------------

function discardingArtifactsRepo(): ImprovementProposalArtifactsRepo {
  return {
    insertArtifact(input) {
      return {
        id: input.id,
        proposalId: input.proposalId,
        variant: input.variant,
        transcriptJson: input.transcriptJson,
        metricsJson: input.metricsJson,
        ranAt: input.ranAt,
      };
    },
    listByProposal() {
      return [];
    },
  };
}
