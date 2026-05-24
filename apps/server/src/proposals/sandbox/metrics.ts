/**
 * Phase 7.4 — sandbox metrics + delta computation.
 *
 * Computes per-variant transcript metrics and the
 * `proposed minus current` delta the UI surfaces.
 *
 * Synthetic `thumbsScore` heuristic (documented inline):
 *   The capability-registry seam on the orchestrator is INERT in 7.4
 *   (consumers land in 7.5). Both replays under the same scripted LLM
 *   therefore produce essentially identical transcripts. A "real"
 *   thumbs ratio cannot be inferred from a replay because no human is
 *   in the loop. Instead, we score the *spec* deterministically:
 *
 *     - For `current`  (no overlay applied):
 *         thumbsScore = baseline = (# evidence messages whose replay
 *                                   produced ≥1 retrieval hit)
 *
 *     - For `proposed` (overlay applied):
 *         thumbsScore = baseline
 *                     + COVERAGE_BONUS_PER_EVIDENCE
 *                       × (# evidence messages whose cluster reason
 *                          is covered by `spec.addressesTags`)
 *
 *   `thumbsUpDelta = proposed.thumbsScore - current.thumbsScore`.
 *
 *   Consequence: a proposed spec whose `addressesTags` intersects the
 *   evidence cluster reasons returns a STRICTLY POSITIVE
 *   `thumbsUpDelta`. A spec whose tags don't intersect returns
 *   `thumbsUpDelta = 0`. This pins the
 *   `activated-replanned` vs `superseded-after-replan` decision to
 *   the replanned spec's tag-coverage — testable, deterministic,
 *   and matches the spirit of the ADR 0025 §2 "covers the gap"
 *   tag-subset rule.
 *
 *   When 7.5's consumer wiring lands, the answerer prompt fragment
 *   from a skill spec WILL change the transcript, and this heuristic
 *   should be re-shaped to read transcript signals directly.
 */

import type { ClusterReason, ProposalSpec } from '@bunny2/shared';
import type { MessageReplayResult, SandboxOutcome, Transcript } from './types';

export const COVERAGE_BONUS_PER_EVIDENCE = 1;

export interface ReplayMetricsInput {
  readonly replays: readonly MessageReplayResult[];
  readonly evidenceClusterReasons: readonly ClusterReason[];
  readonly variant: 'current' | 'proposed' | 'replanned';
  readonly proposedSpec?: ProposalSpec;
  readonly sandboxOutcome: SandboxOutcome;
}

export interface VariantMetrics {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly latencyMs: number;
  readonly thumbsScore: number;
  readonly sandboxOutcome: SandboxOutcome;
}

export interface DeltaMetrics {
  readonly current: VariantMetrics;
  readonly proposed: VariantMetrics;
  readonly thumbsUpDelta: number;
  readonly tokensDelta: number;
  readonly latencyDeltaMs: number;
  readonly sandboxOutcome: SandboxOutcome;
}

export function buildTranscript(replays: readonly MessageReplayResult[]): Transcript {
  return { messages: replays };
}

export function summarizeVariant(input: ReplayMetricsInput): VariantMetrics {
  const tokensIn = sum(input.replays.map((r) => r.tokensIn));
  const tokensOut = sum(input.replays.map((r) => r.tokensOut));
  const latencyMs = sum(input.replays.map((r) => r.latencyMs));
  const thumbsScore = scoreVariant(input);
  return { tokensIn, tokensOut, latencyMs, thumbsScore, sandboxOutcome: input.sandboxOutcome };
}

export function computeDelta(current: VariantMetrics, proposed: VariantMetrics): DeltaMetrics {
  // If either variant timed out, propagate the worse outcome — the UI
  // renders that the proposal could not be evaluated rather than a
  // nonsensical 0-delta.
  const sandboxOutcome: SandboxOutcome =
    proposed.sandboxOutcome === 'timeout' || current.sandboxOutcome === 'timeout'
      ? 'timeout'
      : proposed.sandboxOutcome === 'error' || current.sandboxOutcome === 'error'
        ? 'error'
        : 'ok';
  return {
    current,
    proposed,
    thumbsUpDelta: proposed.thumbsScore - current.thumbsScore,
    tokensDelta: proposed.tokensIn + proposed.tokensOut - (current.tokensIn + current.tokensOut),
    latencyDeltaMs: proposed.latencyMs - current.latencyMs,
    sandboxOutcome,
  };
}

function scoreVariant(input: ReplayMetricsInput): number {
  // Baseline: count of evidence messages whose replay produced ≥1 hit.
  const baseline = input.replays.filter((r) => r.retrievalHitCount > 0).length;
  if (input.variant === 'current') return baseline;
  const spec = input.proposedSpec;
  if (spec === undefined) return baseline;
  const specTags = new Set<ClusterReason>(spec.addressesTags);
  const covered = input.evidenceClusterReasons.filter((tag) => specTags.has(tag)).length;
  return baseline + COVERAGE_BONUS_PER_EVIDENCE * covered;
}

function sum(xs: readonly number[]): number {
  let total = 0;
  for (const x of xs) total += x;
  return total;
}
