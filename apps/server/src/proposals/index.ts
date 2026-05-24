/**
 * Phase 7.4 — `proposals/` public barrel.
 *
 * The boot path (`apps/server/src/index.ts`) imports from here to
 * construct the per-process capability registry and to wire the
 * sandbox / replan entry points into the worker + web roles. Phase 7.6
 * will add the HTTP routes that call these from request handlers.
 */

export {
  createCapabilityRegistry,
  type ActivateInput,
  type CapabilityRegistry,
  type CapabilityRegistryDeps,
  type CapabilityRegistryLogger,
  type DeactivateInput,
} from './capability-registry';

export {
  attachAgentSubscriber,
  detachAgentSubscriber,
  isAgentAttached,
  resetAttachedAgentsForTest,
  type AgentSubscriberDeps,
  type AgentSubscriberLogger,
} from './agents/subscribe';

export {
  runSandbox,
  MAX_EVIDENCE_MESSAGES,
  type SandboxDeps,
  type SandboxEvidenceInput,
  type SandboxErrorResult,
  type SandboxLogger,
  type SandboxResult,
} from './sandbox/runner';

export {
  HISTORY_TURN_CAP,
  REPLAY_TIMEOUT_MS,
  type PriorTurn,
  type ReplayDeps,
  type ReplayEvidenceMessage,
  type ReplayInput,
  replayMessage,
} from './sandbox/replay';

export {
  buildTranscript,
  computeDelta,
  summarizeVariant,
  PROMPT_GROWTH_BONUS_PER_MESSAGE,
  type DeltaMetrics,
  type ReplayMetricsInput,
  type VariantMetrics,
} from './sandbox/metrics';

export type { MessageReplayResult, SandboxOutcome, Transcript } from './sandbox/types';

export {
  coversGap,
  diffSnapshots,
  replanOnApproval,
  type ReplanDeps,
  type ReplanLlmFn,
  type ReplanLlmInput,
  type ReplanOutcome,
  type SnapshotDiff,
} from './replan';

export {
  PROPOSAL_EVENT_TYPES,
  PROPOSAL_MINTED_EVENT_TYPE,
  PROPOSAL_ACTIVATED_EVENT_TYPE,
  PROPOSAL_SUPERSEDED_EVENT_TYPE,
  PROPOSAL_DEACTIVATED_EVENT_TYPE,
  PROPOSAL_REJECTED_EVENT_TYPE,
  type ProposalActivatedPayload,
  type ProposalDeactivatedPayload,
  type ProposalEventType,
  type ProposalMintedPayload,
  type ProposalRejectedPayload,
  type ProposalSupersededPayload,
} from './events';

// Phase 7.6 — scheduled-task handlers + boot-time registration.
export {
  PROPOSALS_EVIDENCE_PRUNE_KIND,
  proposalsEvidencePruneHandler,
  pruneProposalEvidence,
  type ProposalsEvidencePruneConfig,
  type ProposalsEvidencePruneResult,
} from './evidence-prune-handler';

export {
  PROPOSALS_REPLAN_STALE_KIND,
  proposalsReplanStaleHandler,
  buildProposalsReplanStaleHandler,
  replanStaleProposals,
  type ProposalsReplanStaleConfig,
  type ProposalsReplanStaleDeps,
  type ProposalsReplanStaleResult,
} from './replan-stale-handler';

export {
  registerProposalsScheduledTaskHandlers,
  type RegisterProposalsScheduledTaskHandlersDeps,
} from './scheduled';

// Phase 8.2 — pure auto-activation gate function consumed by the
// hourly `proposals.auto-activate` job (lands in 8.3).
export {
  evaluateAutoActivation,
  AUTO_ACTIVATION_GATE_NAMES,
  type EvaluateAutoActivationInput,
} from './auto-activate';

// Phase 7.6 — repo factories surfaced for the HTTP routes.
export {
  createImprovementProposalsRepo,
  type ImprovementProposalsRepo,
  type ImprovementProposalRow,
} from './repos/improvement-proposals-repo';
export {
  createImprovementProposalEvidenceRepo,
  type ImprovementProposalEvidenceRepo,
  type ProposalEvidenceRow,
} from './repos/improvement-proposal-evidence-repo';
export {
  createImprovementProposalArtifactsRepo,
  type ImprovementProposalArtifactsRepo,
  type ProposalArtifactRow,
} from './repos/improvement-proposal-artifacts-repo';
export {
  createLayerCapabilitiesRepo,
  type LayerCapabilitiesRepo,
  type LayerCapabilityRow,
} from './repos/layer-capabilities-repo';
