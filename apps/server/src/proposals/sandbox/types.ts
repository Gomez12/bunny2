/**
 * Phase 7.4 — sandbox public types.
 *
 * Keeps the transcript / metrics shape pinned in one place so the
 * runner, replay, metrics, and replan modules import from a single
 * source. Phase 7.6's HTTP detail page will render `Transcript` shape
 * verbatim from `improvement_proposal_artifacts.transcript_json`.
 */

import type { ClusterReason } from '@bunny2/shared';

export type SandboxOutcome = 'ok' | 'timeout' | 'error';

/**
 * Per-message replay result. `retrievalHitCount` is the count of
 * entity-store hits the replay's retrieval step produced — used by
 * the synthetic thumbs-score heuristic (metrics.ts §1) and surfaced
 * verbatim on the detail page so admins can read the replay outcome.
 *
 * Phase 7.4 does not embed full prompts or full LLM responses in the
 * transcript — only the answer step's final content (truncated). This
 * keeps the row small and avoids storing chat history twice.
 */
export interface MessageReplayResult {
  readonly messageId: string;
  readonly userContent: string;
  readonly assistantContent: string;
  readonly status: 'done' | 'failed';
  readonly errorCode?: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly latencyMs: number;
  readonly retrievalHitCount: number;
  readonly clusterReason?: ClusterReason;
}

export interface Transcript {
  readonly messages: readonly MessageReplayResult[];
}
