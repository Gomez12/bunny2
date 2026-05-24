/**
 * Phase 7.5 — sandbox metrics + delta computation.
 *
 * Computes per-variant transcript metrics and the
 * `proposed minus current` delta the UI surfaces.
 *
 * History (phase 7.4): the orchestrator's capability-registry seam
 * was INERT — both replays under the same scripted LLM produced
 * identical transcripts. Metrics relied on a synthetic `thumbsScore`
 * derived from the spec's `addressesTags` to give the UI + the
 * re-plan path a meaningful delta.
 *
 * Phase 7.5 wires the seam: the answerer reads activated `skill`
 * rows and injects each `promptFragment` AFTER the hard grounding
 * system prompt. The proposed-variant replay therefore sees a
 * strictly LONGER prompt than the current-variant replay (additional
 * system message(s) for every active skill). That length is the
 * real, transcript-observable signal — `tokensIn` grows on the
 * proposed variant.
 *
 * New `thumbsScore` formula:
 *
 *   thumbsScore = (# evidence messages whose replay produced ≥1 hit)
 *               + (# proposed-variant messages whose `tokensIn` is
 *                  strictly GREATER than the matching current-variant
 *                  message's `tokensIn`)
 *
 * Per-message comparison (instead of summed totals) is robust against
 * fractional-token rounding: the programmable-LLM fixture computes
 * `tokensIn = floor(inChars / 4)`, so a one-character prompt addition
 * on a 4n+3-byte prompt rounds away under summed totals but is
 * preserved under per-message ">" comparison.
 *
 * For the `current` variant the per-message bonus is 0 by definition
 * (the baseline isn't compared to anything); for the `proposed`
 * variant the bonus is positive whenever the registry actually
 * returned at least one skill fragment for the matched intent. That
 * ties the sandbox's positive-delta decision (and the downstream
 * re-plan branch boundaries) to a real prompt change — no
 * `addressesTags` hand-wave.
 *
 * Production LLMs report `tokensIn` from their own tokeniser; the
 * formula degrades gracefully (a 0-growth provider yields a 0
 * bonus). The retrieval-hit baseline keeps the score meaningful
 * even when prompt growth is zero (e.g. when no skills matched the
 * resolved intent).
 */

import type { ClusterReason, ProposalSpec } from '@bunny2/shared';
import type { MessageReplayResult, SandboxOutcome, Transcript } from './types';

/** Bonus added to `thumbsScore` per evidence message whose proposed-
 *  variant `tokensIn` is strictly greater than the current variant's.
 *  Keeping it 1 so the score remains small-integer + readable. */
export const PROMPT_GROWTH_BONUS_PER_MESSAGE = 1;

export interface ReplayMetricsInput {
  readonly replays: readonly MessageReplayResult[];
  readonly evidenceClusterReasons: readonly ClusterReason[];
  readonly variant: 'current' | 'proposed' | 'replanned';
  readonly proposedSpec?: ProposalSpec;
  readonly sandboxOutcome: SandboxOutcome;
  /**
   * Phase 7.5 — the `current` variant's per-message `tokensIn` totals,
   * supplied when summarising the `proposed` variant so the formula
   * can derive prompt growth from a real transcript field. Omitted
   * for the `current` summarisation itself (growth is trivially 0).
   */
  readonly baselineTokensIn?: readonly number[];
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
  const thumbsScore = scoreVariant(input, tokensIn);
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

function scoreVariant(input: ReplayMetricsInput, totalTokensIn: number): number {
  void totalTokensIn;
  const baseline = input.replays.filter((r) => r.retrievalHitCount > 0).length;
  if (input.variant === 'current') return baseline;
  // For proposed / replanned variants, derive the bonus from real
  // per-message `tokensIn` growth observed in the transcript. When
  // the runner hasn't been wired to pass `baselineTokensIn` (e.g.
  // older test call sites), fall back to the spec's `addressesTags`
  // coverage so the function stays usable in isolation.
  if (input.baselineTokensIn !== undefined) {
    let grew = 0;
    for (let i = 0; i < input.replays.length; i += 1) {
      const proposedTokens = input.replays[i]?.tokensIn ?? 0;
      const baselineTokens = input.baselineTokensIn[i] ?? 0;
      if (proposedTokens > baselineTokens) grew += 1;
    }
    return baseline + PROMPT_GROWTH_BONUS_PER_MESSAGE * grew;
  }
  const spec = input.proposedSpec;
  if (spec === undefined) return baseline;
  const specTags = new Set<ClusterReason>(spec.addressesTags);
  const covered = input.evidenceClusterReasons.filter((tag) => specTags.has(tag)).length;
  return baseline + covered;
}

function sum(xs: readonly number[]): number {
  let total = 0;
  for (const x of xs) total += x;
  return total;
}
