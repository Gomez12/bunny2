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
} from './capability-registry';

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
  COVERAGE_BONUS_PER_EVIDENCE,
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
  type ProposalActivatedPayload,
  type ProposalEventType,
  type ProposalMintedPayload,
  type ProposalSupersededPayload,
} from './events';
