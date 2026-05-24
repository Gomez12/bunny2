/**
 * Phase 7.4 — sandbox runner.
 *
 * Replays a proposal's evidence messages against:
 *   - the current pipeline (no overlay),
 *   - the pipeline with the proposed artifact overlaid into the
 *     per-layer capability registry (in-memory only, ADR 0024 §1).
 *
 * Persists two `improvement_proposal_artifacts` rows per call
 * (`variant='current'` + `variant='proposed'`) and never writes
 * anywhere else (ADR 0024 §5). The orchestrator is consulted via
 * `runPipeline(...)` against a scratch in-memory DB inside
 * `replay.ts` so the sandbox cannot pollute production storage.
 *
 * The runner is also the place where the closed-enum guard fires
 * BEFORE any artifact rows land. ADR 0023 §2 plus reviewer feedback:
 * a spec the activation registry would reject must not produce
 * partial state.
 */

import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import {
  ProposalSpecSchema,
  type ClusterReason,
  type ImprovementProposal,
  type LayerCapability,
  type ProposalSpec,
} from '@bunny2/shared';
import type { LlmClient } from '../../llm';
import type { EntityKind, EntityStoreForRetrieval } from '../../chat/pipeline';
import type { CapabilityRegistry } from '../capability-registry';
import type { ImprovementProposalArtifactsRepo } from '../repos/improvement-proposal-artifacts-repo';
import type { ChatConversationsRepo } from '../../chat/repos/chat-conversations-repo';
import type { ChatMessagesRepo } from '../../chat/repos/chat-messages-repo';
import {
  HISTORY_TURN_CAP,
  replayMessage,
  type PriorTurn,
  type ReplayEvidenceMessage,
} from './replay';
import {
  buildTranscript,
  computeDelta,
  summarizeVariant,
  type DeltaMetrics,
  type VariantMetrics,
} from './metrics';
import type { MessageReplayResult, SandboxOutcome, Transcript } from './types';

/**
 * Max evidence messages per proposal (ADR 0024 §3). Cluster grouper
 * in phase 7.3 already caps the supporting-message list at 5; the
 * runner re-enforces defensively so a malformed proposal can't blow
 * the per-proposal wall-clock budget.
 */
export const MAX_EVIDENCE_MESSAGES = 5;

export interface SandboxLogger {
  info(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  error(msg: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface SandboxDeps {
  readonly llm: LlmClient;
  readonly db: Database;
  readonly bus: MessageBus;
  readonly capabilityRegistry: CapabilityRegistry;
  readonly artifactsRepo: ImprovementProposalArtifactsRepo;
  readonly conversationsRepo: ChatConversationsRepo;
  readonly messagesRepo: ChatMessagesRepo;
  readonly getEntityStore: (kind: EntityKind) => EntityStoreForRetrieval | null;
  readonly logger: SandboxLogger;
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
}

export interface SandboxEvidenceInput {
  readonly id: string;
  readonly messageId: string;
  readonly clusterReason: ClusterReason;
}

export interface SandboxResult {
  readonly current: Transcript;
  readonly proposed: Transcript;
  readonly metrics: DeltaMetrics;
  readonly outcome: SandboxOutcome;
  readonly variantArtifacts: {
    readonly currentArtifactId: string;
    readonly proposedArtifactId: string;
  };
}

export interface SandboxErrorResult {
  readonly error: 'unknown_handler_kind' | 'cross_layer_evidence' | 'invalid_spec';
  readonly message: string;
}

/**
 * Run the sandbox. Returns either:
 *   - `{ ok: SandboxResult }` on a complete run (including timeout —
 *     the artifact rows still land, with `sandboxOutcome='timeout'`),
 *   - `{ err: SandboxErrorResult }` when the closed-enum guard or
 *     the cross-layer evidence guard fires. No artifact rows are
 *     written in the `err` case.
 */
export async function runSandbox(
  proposal: ImprovementProposal,
  evidence: readonly SandboxEvidenceInput[],
  deps: SandboxDeps,
): Promise<{ readonly ok: SandboxResult } | { readonly err: SandboxErrorResult }> {
  const clock = deps.clock ?? ((): Date => new Date());
  const newId = deps.idFactory ?? ((): string => crypto.randomUUID());

  // ----- closed-enum guard (ADR 0023 §2) ---------------------------------
  const specParse = ProposalSpecSchema.safeParse(proposal.proposedSpec);
  if (!specParse.success) {
    const message = specParse.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    deps.logger.warn('proposal.sandbox.closed-enum-violation', {
      event: 'proposal.sandbox.closed-enum-violation',
      proposalId: proposal.id,
      layerId: proposal.layerId,
      error: message,
    });
    return { err: { error: 'unknown_handler_kind', message } };
  }
  const spec: ProposalSpec = specParse.data;

  // ----- evidence cap + materialisation ---------------------------------
  // Deterministic trim: keep the first N (the cluster grouper already
  // sorts by signal strength + recency; "first" is the strongest).
  const trimmedEvidence = evidence.slice(0, MAX_EVIDENCE_MESSAGES);

  // Materialise + cross-layer evidence guard (reviewer feedback). Each
  // evidence message's conversation MUST live in the proposal's layer;
  // anything else is an auth-boundary violation and would have been
  // surfaced by 7.3's per-layer query — we re-check here so a hand-
  // crafted proposal row can't bypass the boundary.
  const replayInputs: ReplayEvidenceMessage[] = [];
  const histories: { evidenceIdx: number; history: readonly PriorTurn[] }[] = [];
  let conversationTitle = '';
  let conversationLocale = 'en';
  for (let i = 0; i < trimmedEvidence.length; i += 1) {
    const ev = trimmedEvidence[i];
    if (ev === undefined) continue;
    const userMessage = deps.messagesRepo.getMessageById(ev.messageId);
    if (userMessage === null) {
      deps.logger.warn('proposal.sandbox.evidence-missing', {
        event: 'proposal.sandbox.evidence-missing',
        proposalId: proposal.id,
        messageId: ev.messageId,
      });
      continue;
    }
    const conversation = deps.conversationsRepo.getConversationById(userMessage.conversationId);
    if (conversation === null) {
      deps.logger.warn('proposal.sandbox.evidence-conversation-missing', {
        event: 'proposal.sandbox.evidence-conversation-missing',
        proposalId: proposal.id,
        messageId: ev.messageId,
      });
      continue;
    }
    if (conversation.layerId !== proposal.layerId) {
      const message = `evidence message ${ev.messageId} belongs to layer ${conversation.layerId}, not ${proposal.layerId}`;
      deps.logger.error('proposal.sandbox.cross-layer-evidence', {
        event: 'proposal.sandbox.cross-layer-evidence',
        proposalId: proposal.id,
        messageId: ev.messageId,
        proposalLayerId: proposal.layerId,
        evidenceLayerId: conversation.layerId,
      });
      return { err: { error: 'cross_layer_evidence', message } };
    }
    conversationTitle = conversation.title;
    conversationLocale = conversation.locale;
    replayInputs.push({
      messageId: ev.messageId,
      conversationId: conversation.id,
      layerId: conversation.layerId,
      userId: conversation.userId,
      userContent: userMessage.content,
      clusterReason: ev.clusterReason,
    });
    const history = deps.messagesRepo
      .listByConversation(conversation.id)
      .filter((m) => m.id !== userMessage.id && m.status !== 'failed')
      .slice(-HISTORY_TURN_CAP)
      .map(
        (m): PriorTurn => ({
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
        }),
      );
    histories.push({ evidenceIdx: i, history });
  }

  if (replayInputs.length === 0) {
    deps.logger.warn('proposal.sandbox.no-evidence', {
      event: 'proposal.sandbox.no-evidence',
      proposalId: proposal.id,
      layerId: proposal.layerId,
    });
    return { err: { error: 'invalid_spec', message: 'no replayable evidence messages found' } };
  }

  // ----- overlay (in-memory) --------------------------------------------
  const overlay: readonly LayerCapability[] = [
    {
      id: `sandbox-${proposal.id}`,
      layerId: proposal.layerId,
      kind: spec.artifactKind,
      name: spec.name,
      specJson: JSON.stringify(spec),
      origin: `proposal:${proposal.id}`,
      activatedAt: clock().toISOString(),
      deactivatedAt: null,
    },
  ];

  // ----- both replays ----------------------------------------------------
  const currentRegistry = deps.capabilityRegistry;
  const proposedRegistry = deps.capabilityRegistry.withOverlay(overlay);

  const currentReplays = await runVariant(proposal, replayInputs, 'current', currentRegistry, deps);
  const proposedReplays = await runVariant(
    proposal,
    replayInputs,
    'proposed',
    proposedRegistry,
    deps,
  );

  const evidenceClusterReasons: ClusterReason[] = trimmedEvidence
    .slice(0, replayInputs.length)
    .map((e) => e.clusterReason);

  const currentMetrics: VariantMetrics = summarizeVariant({
    replays: currentReplays.results,
    evidenceClusterReasons,
    variant: 'current',
    sandboxOutcome: currentReplays.aggregateOutcome,
  });
  const proposedMetrics: VariantMetrics = summarizeVariant({
    replays: proposedReplays.results,
    evidenceClusterReasons,
    variant: 'proposed',
    proposedSpec: spec,
    sandboxOutcome: proposedReplays.aggregateOutcome,
  });
  const delta = computeDelta(currentMetrics, proposedMetrics);

  const ranAt = clock().toISOString();
  const currentArtifactId = newId();
  const proposedArtifactId = newId();
  deps.artifactsRepo.insertArtifact({
    id: currentArtifactId,
    proposalId: proposal.id,
    variant: 'current',
    transcriptJson: JSON.stringify(buildTranscript(currentReplays.results)),
    metricsJson: JSON.stringify(currentMetrics),
    ranAt,
  });
  deps.artifactsRepo.insertArtifact({
    id: proposedArtifactId,
    proposalId: proposal.id,
    variant: 'proposed',
    transcriptJson: JSON.stringify(buildTranscript(proposedReplays.results)),
    metricsJson: JSON.stringify(proposedMetrics),
    ranAt,
  });

  deps.logger.info('proposal.sandbox.complete', {
    event: 'proposal.sandbox.complete',
    proposalId: proposal.id,
    layerId: proposal.layerId,
    totalMessages: replayInputs.length,
    sandboxOutcome: delta.sandboxOutcome,
    thumbsUpDelta: delta.thumbsUpDelta,
    tokensDelta: delta.tokensDelta,
    latencyDeltaMs: delta.latencyDeltaMs,
    // Counter dim — bounded.
    'proposal.sandbox.duration_ms': proposedMetrics.latencyMs + currentMetrics.latencyMs,
  });

  void conversationTitle;
  void conversationLocale;
  void histories;

  return {
    ok: {
      current: buildTranscript(currentReplays.results),
      proposed: buildTranscript(proposedReplays.results),
      metrics: delta,
      outcome: delta.sandboxOutcome,
      variantArtifacts: { currentArtifactId, proposedArtifactId },
    },
  };
}

async function runVariant(
  proposal: ImprovementProposal,
  replayInputs: readonly ReplayEvidenceMessage[],
  variant: 'current' | 'proposed',
  registry: CapabilityRegistry,
  deps: SandboxDeps,
): Promise<{
  readonly results: readonly MessageReplayResult[];
  readonly aggregateOutcome: SandboxOutcome;
}> {
  const results: MessageReplayResult[] = [];
  let worstOutcome: SandboxOutcome = 'ok';
  for (const ev of replayInputs) {
    const startedAtIso = (deps.clock ?? ((): Date => new Date()))().toISOString();
    const replay = await replayMessage(
      {
        evidence: ev,
        // History is read from production messagesRepo only — the
        // replay copies them into the scratch DB. The orchestrator's
        // history cap inside `replay.ts` mirrors ADR 0020.
        history: deps.messagesRepo
          .listByConversation(ev.conversationId)
          .filter((m) => m.id !== ev.messageId && m.status !== 'failed')
          .slice(-HISTORY_TURN_CAP)
          .map(
            (m): PriorTurn => ({
              id: m.id,
              role: m.role,
              content: m.content,
              createdAt: m.createdAt,
            }),
          ),
        conversationTitle:
          deps.conversationsRepo.getConversationById(ev.conversationId)?.title ?? '',
        conversationLocale:
          deps.conversationsRepo.getConversationById(ev.conversationId)?.locale ?? 'en',
      },
      {
        llm: deps.llm,
        getEntityStore: deps.getEntityStore,
        capabilityRegistry: registry,
        ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
        logger: deps.logger,
      },
    );
    results.push(replay.result);
    deps.logger.info('proposal.sandbox.replay', {
      event: 'proposal.sandbox.replay',
      proposalId: proposal.id,
      variant,
      messageId: ev.messageId,
      durationMs: replay.result.latencyMs,
      tokensIn: replay.result.tokensIn,
      tokensOut: replay.result.tokensOut,
      hitCount: replay.result.retrievalHitCount,
      sandboxOutcome: replay.outcome,
      startedAt: startedAtIso,
    });
    if (replay.outcome === 'timeout') worstOutcome = 'timeout';
    else if (replay.outcome === 'error' && worstOutcome !== 'timeout') worstOutcome = 'error';
  }
  return { results, aggregateOutcome: worstOutcome };
}
