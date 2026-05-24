/**
 * Phase 7.3 — pure-code cluster grouper for the per-layer review agent.
 *
 * The review-agent body (`chat.review-layer`) reads the last 7 days
 * of chat telemetry and hands the rows to this module. Everything
 * here is pure code (no DB, no LLM, no I/O): given a fixed input,
 * the function returns the same cluster list, every time. The
 * downstream LLM-mint step (`mint.ts`) only sees the resulting
 * clusters, never the raw rows.
 *
 * The five cluster reasons are the closed enum
 * `ClusterReasonSchema` from `packages/shared/src/proposals.ts`
 * (phase 7.2). Each reason has a single, mechanical detection rule
 * documented inline. The detection rules deliberately overlap — a
 * single message can land in `zero-hit-retrieval` AND
 * `thumbs-down` AND `latency-over-budget`; the LLM sees one
 * proposal per cluster, so the same message can support multiple
 * proposals.
 *
 * Deterministic ordering, pinned by `proposals-clusters.test.ts`:
 *   1. Cluster sort: by `CLUSTER_REASON_ORDER` then by `stats.count`
 *      desc. Pinning enum order in this file (instead of importing
 *      `clusterReasonEnum.options`) prevents a future shared-package
 *      enum reorder from silently re-ordering test fixtures.
 *   2. Within a cluster: thumbs-down messages first (strongest
 *      signal), then most-recent `created_at` first. The first 5
 *      survive (`MAX_MESSAGES_PER_CLUSTER`).
 *   3. Clusters with `stats.count < MIN_CLUSTER_COUNT` (2) are
 *      dropped — a single-message "cluster" is noise.
 *
 * `LATENCY_BUDGET_MS` (10 s) and `REPEATED_ERROR_THRESHOLD` (3) are
 * file-level constants. Externalising them as task config is a
 * phase 7-follow-up candidate; phase 7.3 keeps the surface minimal.
 */

import type { ClusterReason } from '@bunny2/shared';

// ---------- input row shapes (subsets of the repo row types) ----------

/**
 * Subset of `ChatMessage` the grouper needs. Re-declared here as a
 * narrow interface so the grouper does not bind to repo-internal
 * field names; the handler maps repo rows into this shape before
 * calling.
 */
export interface ClusterGrouperMessage {
  readonly id: string;
  readonly correlationId: string;
  readonly createdAt: string;
}

export interface ClusterGrouperFeedback {
  readonly messageId: string;
  readonly value: 'up' | 'down';
}

export interface ClusterGrouperStep {
  readonly id: string;
  readonly messageId: string;
  readonly kind: string;
  readonly status: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outputJson: string | null;
  readonly errorCode: string | null;
}

/**
 * `LlmCallRow` slice. Phase 7.3 does not yet derive a cluster from
 * LLM-call telemetry — the field is reserved for phase 7.4+ when
 * cost-per-message clusters become relevant. The handler still
 * passes `[]` in 7.3 so the signature is stable.
 */
export interface ClusterGrouperLlmCall {
  readonly id: string;
  readonly correlationId: string | null;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly latencyMs: number | null;
}

export interface ClusterGrouperInput {
  readonly messages: readonly ClusterGrouperMessage[];
  readonly feedback: readonly ClusterGrouperFeedback[];
  readonly steps: readonly ClusterGrouperStep[];
  readonly llmCalls: readonly ClusterGrouperLlmCall[];
}

export interface ClusterStats {
  readonly count: number;
  readonly thumbsDownRate?: number;
  readonly avgLatencyMs?: number;
  readonly totalTokens?: number;
}

export interface Cluster {
  readonly reason: ClusterReason;
  /** Strongest signal first; capped at `MAX_MESSAGES_PER_CLUSTER`. */
  readonly messageIds: readonly string[];
  /** Short human-readable description — template, not LLM. */
  readonly summary: string;
  readonly stats: ClusterStats;
}

// ---------- knobs (file-level constants) ------------------------------

/** Default latency budget (ms) for `latency-over-budget` clusters. */
export const LATENCY_BUDGET_MS = 10_000;

/**
 * Minimum supporting messages a cluster needs to survive. A
 * single-message cluster is noise; the LLM prompt cost is not worth
 * one signal.
 */
export const MIN_CLUSTER_COUNT = 2;

/** Cap per cluster — the LLM prompt only sees the strongest five. */
export const MAX_MESSAGES_PER_CLUSTER = 5;

/**
 * Number of distinct messages an `error_code` must appear in before
 * a `repeated-error-code` cluster is emitted.
 */
export const REPEATED_ERROR_THRESHOLD = 3;

/**
 * Enum order pinned here so test fixtures stay stable if the shared
 * `ClusterReasonSchema` ever reorders. Must contain every reason
 * the grouper can emit.
 */
export const CLUSTER_REASON_ORDER: readonly ClusterReason[] = [
  'zero-hit-retrieval',
  'thumbs-down',
  'invalid-step-output',
  'latency-over-budget',
  'repeated-error-code',
];

// ---------- main entry point ------------------------------------------

/**
 * Group telemetry rows into clusters. Pure, deterministic, no I/O.
 *
 * Returns clusters sorted by `CLUSTER_REASON_ORDER` then by
 * `stats.count` desc. Empty input → empty output; the handler logs
 * `proposal.mint.no-clusters` in that case.
 */
export function groupClusters(input: ClusterGrouperInput): readonly Cluster[] {
  // Phase 7.3 does not yet derive any cluster from raw LLM-call rows
  // (the five reasons all key off chat-pipeline state). The argument
  // stays in the input signature so phase 7.4+ can add a cost-based
  // cluster without re-shaping the call sites.
  void input.llmCalls;
  const feedbackByMessage = new Map(input.feedback.map((f) => [f.messageId, f]));
  const stepsByMessage = groupStepsByMessage(input.steps);

  const clusters: Cluster[] = [];

  const zeroHit = buildZeroHitCluster(input.messages, stepsByMessage, feedbackByMessage);
  if (zeroHit !== null) clusters.push(zeroHit);

  const thumbsDown = buildThumbsDownCluster(input.messages, feedbackByMessage);
  if (thumbsDown !== null) clusters.push(thumbsDown);

  const invalidStep = buildInvalidStepCluster(input.messages, stepsByMessage, feedbackByMessage);
  if (invalidStep !== null) clusters.push(invalidStep);

  const latencyOver = buildLatencyOverBudgetCluster(
    input.messages,
    stepsByMessage,
    feedbackByMessage,
  );
  if (latencyOver !== null) clusters.push(latencyOver);

  const repeatedError = buildRepeatedErrorClusters(
    input.messages,
    stepsByMessage,
    feedbackByMessage,
  );
  if (repeatedError !== null) clusters.push(repeatedError);

  return clusters
    .filter((c) => c.stats.count >= MIN_CLUSTER_COUNT)
    .map((c) => limitMessageIds(c))
    .sort((a, b) => {
      const ra = CLUSTER_REASON_ORDER.indexOf(a.reason);
      const rb = CLUSTER_REASON_ORDER.indexOf(b.reason);
      if (ra !== rb) return ra - rb;
      return b.stats.count - a.stats.count;
    });
}

// ---------- per-cluster builders --------------------------------------

function buildZeroHitCluster(
  messages: readonly ClusterGrouperMessage[],
  stepsByMessage: Map<string, readonly ClusterGrouperStep[]>,
  feedbackByMessage: Map<string, ClusterGrouperFeedback>,
): Cluster | null {
  const hits: ClusterGrouperMessage[] = [];
  for (const msg of messages) {
    const steps = stepsByMessage.get(msg.id);
    if (steps === undefined) continue;
    const retrievalStep = steps.find((s) => s.kind === 'retrieval');
    if (retrievalStep === undefined) continue;
    const hitCount = parseRetrievalHitCount(retrievalStep.outputJson);
    if (hitCount === 0) {
      hits.push(msg);
    }
  }
  if (hits.length === 0) return null;
  const ordered = orderMessagesBySignal(hits, feedbackByMessage);
  const thumbsDownCount = ordered.filter(
    (m) => feedbackByMessage.get(m.id)?.value === 'down',
  ).length;
  return {
    reason: 'zero-hit-retrieval',
    messageIds: ordered.map((m) => m.id),
    summary: `${hits.length} message(s) got 0 retrieval hits in the last 7 days`,
    stats: {
      count: hits.length,
      thumbsDownRate: hits.length === 0 ? 0 : thumbsDownCount / hits.length,
    },
  };
}

function buildThumbsDownCluster(
  messages: readonly ClusterGrouperMessage[],
  feedbackByMessage: Map<string, ClusterGrouperFeedback>,
): Cluster | null {
  const downs: ClusterGrouperMessage[] = [];
  for (const msg of messages) {
    if (feedbackByMessage.get(msg.id)?.value === 'down') {
      downs.push(msg);
    }
  }
  if (downs.length === 0) return null;
  const ordered = orderMessagesBySignal(downs, feedbackByMessage);
  return {
    reason: 'thumbs-down',
    messageIds: ordered.map((m) => m.id),
    summary: `${downs.length} message(s) received a thumbs-down`,
    stats: {
      count: downs.length,
      thumbsDownRate: 1,
    },
  };
}

function buildInvalidStepCluster(
  messages: readonly ClusterGrouperMessage[],
  stepsByMessage: Map<string, readonly ClusterGrouperStep[]>,
  feedbackByMessage: Map<string, ClusterGrouperFeedback>,
): Cluster | null {
  const hits: ClusterGrouperMessage[] = [];
  for (const msg of messages) {
    const steps = stepsByMessage.get(msg.id);
    if (steps === undefined) continue;
    const hasInvalid = steps.some((s) => s.errorCode === 'invalid_step_output');
    if (hasInvalid) hits.push(msg);
  }
  if (hits.length === 0) return null;
  const ordered = orderMessagesBySignal(hits, feedbackByMessage);
  return {
    reason: 'invalid-step-output',
    messageIds: ordered.map((m) => m.id),
    summary: `${hits.length} message(s) had a pipeline step fail zod validation (invalid_step_output)`,
    stats: {
      count: hits.length,
    },
  };
}

function buildLatencyOverBudgetCluster(
  messages: readonly ClusterGrouperMessage[],
  stepsByMessage: Map<string, readonly ClusterGrouperStep[]>,
  feedbackByMessage: Map<string, ClusterGrouperFeedback>,
): Cluster | null {
  const hits: { msg: ClusterGrouperMessage; durationMs: number }[] = [];
  for (const msg of messages) {
    const steps = stepsByMessage.get(msg.id);
    if (steps === undefined) continue;
    const totalMs = totalStepDurationMs(steps);
    if (totalMs > LATENCY_BUDGET_MS) {
      hits.push({ msg, durationMs: totalMs });
    }
  }
  if (hits.length === 0) return null;
  const orderedMessages = orderMessagesBySignal(
    hits.map((h) => h.msg),
    feedbackByMessage,
  );
  const avgLatencyMs = Math.round(
    hits.reduce((acc, h) => acc + h.durationMs, 0) / Math.max(1, hits.length),
  );
  return {
    reason: 'latency-over-budget',
    messageIds: orderedMessages.map((m) => m.id),
    summary: `${hits.length} message(s) exceeded the ${LATENCY_BUDGET_MS}ms total-pipeline latency budget`,
    stats: {
      count: hits.length,
      avgLatencyMs,
    },
  };
}

function buildRepeatedErrorClusters(
  messages: readonly ClusterGrouperMessage[],
  stepsByMessage: Map<string, readonly ClusterGrouperStep[]>,
  feedbackByMessage: Map<string, ClusterGrouperFeedback>,
): Cluster | null {
  // Count distinct messages per error code.
  const messagesByCode = new Map<string, Set<string>>();
  for (const msg of messages) {
    const steps = stepsByMessage.get(msg.id);
    if (steps === undefined) continue;
    for (const step of steps) {
      if (step.errorCode === null || step.errorCode.length === 0) continue;
      let set = messagesByCode.get(step.errorCode);
      if (set === undefined) {
        set = new Set<string>();
        messagesByCode.set(step.errorCode, set);
      }
      set.add(msg.id);
    }
  }
  // Pick error codes that appear in ≥ REPEATED_ERROR_THRESHOLD messages,
  // pool all of their messages into a single cluster (one proposal can
  // address the family of "this step keeps failing" errors).
  const matchingCodes = Array.from(messagesByCode.entries())
    .filter(([, set]) => set.size >= REPEATED_ERROR_THRESHOLD)
    .sort(([a], [b]) => a.localeCompare(b)); // deterministic code order
  if (matchingCodes.length === 0) return null;
  const messageIdSet = new Set<string>();
  for (const [, set] of matchingCodes) {
    for (const id of set) messageIdSet.add(id);
  }
  const pickedMessages: ClusterGrouperMessage[] = [];
  for (const msg of messages) {
    if (messageIdSet.has(msg.id)) pickedMessages.push(msg);
  }
  const ordered = orderMessagesBySignal(pickedMessages, feedbackByMessage);
  const codeList = matchingCodes.map(([code]) => code).join(', ');
  return {
    reason: 'repeated-error-code',
    messageIds: ordered.map((m) => m.id),
    summary: `${pickedMessages.length} message(s) hit recurring pipeline error code(s): ${codeList}`,
    stats: {
      count: pickedMessages.length,
    },
  };
}

// ---------- shared helpers --------------------------------------------

function groupStepsByMessage(
  steps: readonly ClusterGrouperStep[],
): Map<string, readonly ClusterGrouperStep[]> {
  const out = new Map<string, ClusterGrouperStep[]>();
  for (const step of steps) {
    let arr = out.get(step.messageId);
    if (arr === undefined) {
      arr = [];
      out.set(step.messageId, arr);
    }
    arr.push(step);
  }
  return out;
}

function parseRetrievalHitCount(outputJson: string | null): number | null {
  if (outputJson === null) return null;
  try {
    const parsed = JSON.parse(outputJson) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as { hits?: unknown };
    if (!Array.isArray(obj.hits)) return null;
    return obj.hits.length;
  } catch {
    return null;
  }
}

function totalStepDurationMs(steps: readonly ClusterGrouperStep[]): number {
  let total = 0;
  for (const step of steps) {
    if (step.endedAt === null) continue;
    const started = Date.parse(step.startedAt);
    const ended = Date.parse(step.endedAt);
    if (Number.isNaN(started) || Number.isNaN(ended)) continue;
    total += Math.max(0, ended - started);
  }
  return total;
}

/**
 * Order messages by (thumbs-down first, then most-recent
 * `created_at` first). Stable, deterministic; the LLM prompt's
 * "first five messages" therefore prioritises the strongest signal.
 */
function orderMessagesBySignal(
  messages: readonly ClusterGrouperMessage[],
  feedbackByMessage: Map<string, ClusterGrouperFeedback>,
): readonly ClusterGrouperMessage[] {
  return [...messages].sort((a, b) => {
    const aDown = feedbackByMessage.get(a.id)?.value === 'down' ? 1 : 0;
    const bDown = feedbackByMessage.get(b.id)?.value === 'down' ? 1 : 0;
    if (aDown !== bDown) return bDown - aDown; // down first
    // newest first
    return b.createdAt.localeCompare(a.createdAt);
  });
}

function limitMessageIds(cluster: Cluster): Cluster {
  if (cluster.messageIds.length <= MAX_MESSAGES_PER_CLUSTER) return cluster;
  return {
    ...cluster,
    messageIds: cluster.messageIds.slice(0, MAX_MESSAGES_PER_CLUSTER),
  };
}
