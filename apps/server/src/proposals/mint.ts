/**
 * Phase 7.3 — LLM proposal minter.
 *
 * One `llm.chat({...})` call per cluster. The system prompt
 * constrains the LLM to emit JSON matching
 * `ProposalSpecSchema` + an outer wrapper with the
 * `ExpectedImpactSchema` shape and a numeric `threshold` (see the
 * note in §1 below — the spec is one half of the LLM output, not
 * the whole thing).
 *
 * Why a wrapper:
 *   The `improvement_proposals` row carries `proposedSpecJson`,
 *   `expectedImpactJson`, `threshold` and `problemSummary` as
 *   separate columns (phase 7.2's repo + zod
 *   `ImprovementProposalSchema`). Plan §4.3 originally implied
 *   `spec.summary` / `spec.expectedImpact` / `spec.threshold`, but
 *   the actual `ProposalSpecSchema` only has the artifact-specific
 *   fields (name, description, handler/intent/etc., `addressesTags`).
 *   Per the sub-phase brief ("If you discover the plan requires
 *   something inconsistent with what 7.2 actually shipped, prefer
 *   what landed in 7.2"), this file aligns the LLM contract to
 *   what 7.2 shipped — a `ProposalMintOutput` wrapper.
 *
 * `addressesTags` MUST include the cluster's `reason` — the
 * `failureModeTags` ↔ `addressesTags` contract from ADR 0025 §2
 * is enforced AFTER zod parsing. Output that parses but omits the
 * cluster reason is rejected the same as a malformed parse, and
 * the retry/skip path applies.
 *
 * Retry rules (plan §4.3 + risks row 1):
 *   - One retry on parse / contract failure.
 *   - On the second failure, return `{ err }`; the handler logs
 *     `proposal.mint.skipped`.
 *   - Both calls share the same `flow_id` so the LLM-calls table
 *     surfaces them as one logical flow.
 */

import { z } from 'zod';
import {
  ExpectedImpactSchema,
  ProposalSpecSchema,
  type CapabilitySnapshot,
  type ClusterReason,
} from '@bunny2/shared';
import type { LlmClient } from '../llm';
import type { Cluster } from './clusters';

/**
 * Wrapper the LLM emits. `spec` is the
 * artifact-kind-discriminated body; `expectedImpact` and
 * `threshold` are the two extra fields the proposals row stores
 * alongside the spec.
 */
export const ProposalMintOutputSchema = z
  .object({
    spec: ProposalSpecSchema,
    expectedImpact: ExpectedImpactSchema,
    threshold: z.number().min(0).max(1),
  })
  .strict();
export type ProposalMintOutput = z.infer<typeof ProposalMintOutputSchema>;

export interface ProposalMintInput {
  readonly cluster: Cluster;
  readonly capabilitySnapshot: CapabilitySnapshot;
  readonly layerId: string;
  /** Snippet (already-truncated) per message id. Capped at 200 chars per entry by the handler. */
  readonly messageSnippets: ReadonlyMap<string, string>;
  /** `proposal.mint:<runId>` — pinned by the handler. */
  readonly flowId: string;
  readonly correlationId: string;
}

export type ProposalMintResult = { readonly ok: ProposalMintOutput } | { readonly err: Error };

const MAX_SNIPPET_LEN = 200;
const MAX_RETRIES = 1; // one retry → up to two total calls.

/**
 * Mint a proposal for one cluster. One LLM call (plus up to one
 * retry on parse failure). Caller persists; this function is
 * side-effect-free apart from the LLM call itself.
 */
export async function mintProposalViaLlm(
  llm: LlmClient,
  input: ProposalMintInput,
): Promise<ProposalMintResult> {
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(input);
  const baseMetadata = {
    flowId: input.flowId,
    correlationId: input.correlationId,
    layerId: input.layerId,
  } as const;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    let raw: string;
    try {
      const response = await llm.chat({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        metadata: {
          ...baseMetadata,
          step: 'proposal.mint',
          attempt: attempt + 1,
        },
      });
      raw = response.content;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      continue;
    }

    const parsed = parseAndValidate(raw, input.cluster.reason);
    if ('ok' in parsed) {
      return { ok: parsed.ok };
    }
    lastError = parsed.err;
  }

  return {
    err: lastError ?? new Error('proposal.mint: exhausted retries without an error message'),
  };
}

function parseAndValidate(
  content: string,
  clusterReason: ClusterReason,
): { readonly ok: ProposalMintOutput } | { readonly err: Error } {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stripJsonFence(content));
  } catch (err) {
    return {
      err: new Error(
        `proposal.mint: LLM output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }
  const result = ProposalMintOutputSchema.safeParse(parsedJson);
  if (!result.success) {
    return {
      err: new Error(
        `proposal.mint: LLM output failed schema validation: ${result.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      ),
    };
  }
  // ADR 0025 §2: addressesTags MUST contain the cluster reason so
  // the failureModeTags ↔ addressesTags contract holds at replan
  // time.
  if (!result.data.spec.addressesTags.includes(clusterReason)) {
    return {
      err: new Error(
        `proposal.mint: spec.addressesTags must include the cluster reason '${clusterReason}' (got: ${result.data.spec.addressesTags.join(', ')})`,
      ),
    };
  }
  return { ok: result.data };
}

/**
 * Strip a leading/trailing ``` fence (some providers wrap JSON).
 * Deliberately conservative — we only strip the outermost fence,
 * never re-format the body.
 */
function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  // Drop the first line (e.g. ```json) and the trailing fence.
  const firstNewline = trimmed.indexOf('\n');
  if (firstNewline === -1) return trimmed;
  const withoutOpener = trimmed.slice(firstNewline + 1);
  const closingFenceIdx = withoutOpener.lastIndexOf('```');
  if (closingFenceIdx === -1) return withoutOpener.trim();
  return withoutOpener.slice(0, closingFenceIdx).trim();
}

function buildSystemPrompt(): string {
  return [
    'You are the per-layer review agent of a chat assistant.',
    'For the cluster of failures the user message describes, propose ONE',
    'improvement to the layer. Emit ONLY a JSON object, no commentary, no',
    'markdown fence.',
    '',
    'Output shape:',
    '{',
    '  "spec": <ProposalSpec>,',
    '  "expectedImpact": { "thumbsUpDelta": <number>, "tokensDelta": <number>, "latencyDeltaMs": <number> },',
    '  "threshold": <number 0..1>',
    '}',
    '',
    'ProposalSpec is a discriminated union over "artifactKind":',
    '  - artifactKind="tool": { name, description, jsonSchema, handler: { kind, config }, addressesTags }',
    '    handler.kind ∈ {"searchSummaries-aliased", "projection-lookup"}.',
    '  - artifactKind="skill": { name, description, intent, promptFragment, addressesTags }',
    '    intent ∈ {"question.entity_lookup", "question.summary", "command.create", "command.update", "smalltalk", "unsupported"}.',
    '  - artifactKind="agent": { name, description, subscribesTo: string[], handler: { kind, config }, addressesTags }',
    '    handler.kind ∈ {"enrichment-call", "summary-call"}.',
    '',
    'addressesTags ⊆ {"zero-hit-retrieval","thumbs-down","invalid-step-output","latency-over-budget","repeated-error-code"} and MUST contain the cluster reason supplied in the user prompt.',
    '',
    'threshold reflects (frequency × thumbs-down rate × token cost) on [0,1]: low for rare, low-cost issues; high for frequent, costly, user-visible failures.',
    '',
    'No raw user content is included in name / description / promptFragment beyond what you need to identify the pattern. The user prompt already truncates message snippets at 200 chars.',
    '',
    'If no other capability addresses this gap yet, propose a fresh artifact.',
  ].join('\n');
}

function buildUserPrompt(input: ProposalMintInput): string {
  const snippetLines: string[] = [];
  let i = 0;
  for (const [id, snippet] of input.messageSnippets) {
    if (i >= 5) break;
    snippetLines.push(`  - [${id}] ${snippet.slice(0, MAX_SNIPPET_LEN)}`);
    i += 1;
  }
  const stats = input.cluster.stats;
  const statsLines = [
    `count=${stats.count}`,
    stats.thumbsDownRate !== undefined ? `thumbsDownRate=${stats.thumbsDownRate.toFixed(2)}` : null,
    stats.avgLatencyMs !== undefined ? `avgLatencyMs=${stats.avgLatencyMs}` : null,
    stats.totalTokens !== undefined ? `totalTokens=${stats.totalTokens}` : null,
  ]
    .filter((s): s is string => s !== null)
    .join(', ');
  const snapshot = {
    capabilities: input.capabilitySnapshot.capabilities.map((c) => ({
      kind: c.kind,
      name: c.name,
      origin: c.origin,
    })),
    builtins: input.capabilitySnapshot.builtins.map((c) => ({
      kind: c.kind,
      name: c.name,
      origin: c.origin,
    })),
  };
  return [
    `Cluster reason: ${input.cluster.reason}`,
    `Cluster summary: ${input.cluster.summary}`,
    `Cluster stats: ${statsLines}`,
    '',
    'First message snippets (≤5, ≤200 chars each):',
    ...(snippetLines.length === 0 ? ['  (no snippets supplied)'] : snippetLines),
    '',
    `Layer id (for context only; do not echo): ${input.layerId}`,
    '',
    'Current capability snapshot (active per-layer capabilities + builtins):',
    JSON.stringify(snapshot),
    '',
    'Reminder: if the snapshot is empty for this layer, propose a fresh artifact. addressesTags MUST contain the cluster reason.',
  ].join('\n');
}
