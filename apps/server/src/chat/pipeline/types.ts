/**
 * Phase 6.3 — pipeline types + step output zod schemas.
 *
 * One file because the four step kinds share a small, closed
 * universe of types and the orchestrator wants to import them
 * together. The output shapes are the contract surface every LLM
 * step must hit; the orchestrator zod-validates each step's output
 * before persisting it to `chat_pipeline_steps.output_json` and
 * before handing it to the next step.
 *
 * `command.*` intents are explicitly part of the enum so the
 * orchestrator can short-circuit (plan §4.1: "phase 6 only fully
 * handles `question.*`"). `smalltalk` is allowed too — the answerer
 * just produces a polite reply with empty retrieval.
 */

import { z } from 'zod';
import type { ChatMessage } from '../repos/chat-messages-repo';
import { ENTITY_KIND_TO_LANCE_TABLE } from '../embeddings/lance-tables';

// ---------- step kind/status (mirror shared zod 1:1) ------------------

export type PipelineStepKind = 'intent' | 'entities' | 'retrieval' | 'answer';
export type PipelineStepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

// ---------- entity kinds (canonical set is the LanceDB-table keys) ----

/**
 * The four phase-4 entity kinds the resolver step is allowed to
 * route to. Single source of truth: the same Map the embedding
 * subscriber routes on. New kinds opt in by extending that map.
 */
export const PIPELINE_ENTITY_KINDS = Object.freeze(
  Object.keys(ENTITY_KIND_TO_LANCE_TABLE) as readonly EntityKind[],
);

export const EntityKindSchema = z.enum(['company', 'contact', 'calendar_event', 'todo']);
export type EntityKind = z.infer<typeof EntityKindSchema>;

// ---------- intent step ------------------------------------------------

export const IntentEnum = z.enum([
  'question.entity_lookup',
  'question.summary',
  'command.create',
  'command.update',
  'smalltalk',
  'unsupported',
]);
export type Intent = z.infer<typeof IntentEnum>;

export const IntentOutputSchema = z
  .object({
    intent: IntentEnum,
    confidence: z.number().min(0).max(1).optional(),
    reason: z.string().max(280).optional(),
  })
  .strict();
export type IntentOutput = z.infer<typeof IntentOutputSchema>;

// ---------- entities (resolver) step ----------------------------------

export const QueryHintSchema = z
  .object({
    term: z.string().min(1).max(160),
    kind: EntityKindSchema.optional(),
    timeWindow: z
      .object({
        from: z.string(),
        to: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type QueryHint = z.infer<typeof QueryHintSchema>;

export const EntitiesOutputSchema = z
  .object({
    kinds: z.array(EntityKindSchema).max(8),
    queryHints: z.array(QueryHintSchema).max(12),
  })
  .strict();
export type EntitiesOutput = z.infer<typeof EntitiesOutputSchema>;

// ---------- retrieval step (no LLM) -----------------------------------

export const RetrievalHitSchema = z
  .object({
    id: z.string(),
    kind: EntityKindSchema,
    layerId: z.string(),
    slug: z.string(),
    title: z.string(),
    /** Short snippet ≤ 400 chars; the answerer needs context, not the world. */
    text: z.string().max(400),
  })
  .strict();
export type RetrievalHit = z.infer<typeof RetrievalHitSchema>;

export const RetrievalOutputSchema = z
  .object({
    hits: z.array(RetrievalHitSchema).max(20),
    skipped: z.boolean(),
  })
  .strict();
export type RetrievalOutput = z.infer<typeof RetrievalOutputSchema>;

// ---------- answer step -----------------------------------------------

export const AnswerOutputSchema = z
  .object({
    content: z.string(),
    tokensIn: z.number().int().min(0),
    tokensOut: z.number().int().min(0),
    model: z.string(),
    /** True when the answerer was skipped (command.* short-circuit). */
    skipped: z.boolean(),
  })
  .strict();
export type AnswerOutput = z.infer<typeof AnswerOutputSchema>;

// ---------- pipeline context + step contract --------------------------

/**
 * The slice of message history the orchestrator hands every step.
 * Kept narrow so steps don't accidentally bind to repo internals.
 */
export interface HistoryTurn {
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
}

export function historyFromMessages(messages: readonly ChatMessage[]): HistoryTurn[] {
  return messages
    .filter((m) => m.role !== 'system' || m.content.length > 0)
    .map((m) => ({ role: m.role, content: m.content }));
}

export interface PipelineContext {
  readonly conversationId: string;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly runId: string;
  readonly layerId: string;
  readonly effectiveLayerIds: readonly string[];
  readonly userId: string;
  readonly correlationId: string;
  readonly flowId: string;
  /** Capped at last 20 turns by the orchestrator. */
  readonly history: readonly HistoryTurn[];
  /** The user message content; same string the route received. */
  readonly userContent: string;
}

export interface PipelineDeps {
  // Filled in by `pipeline/orchestrator.ts`. The step modules use
  // only the subsets they need; declaring this interface here keeps
  // the typing for orchestrator + steps consistent.
  readonly llm: PipelineLlm;
  /**
   * Per-kind retrieval surface. Returns `null` for unknown kinds.
   *
   * Why a function and not a Map: the integration test wires only
   * the kinds it cares about (`calendar_event`) and lets the rest
   * answer `null`. A Map argument would force the test to pre-build
   * the universe.
   */
  readonly getEntityStore: (kind: EntityKind) => EntityStoreForRetrieval | null;
  readonly logger?: PipelineLogger;
  readonly counters?: PipelineCounters;
  /** Override now() in tests. */
  readonly clock?: () => Date;
}

/**
 * Narrow `LlmClient` shape — same as the production interface but
 * declared here so the step files don't import from `../../llm` in
 * test fixtures.
 */
export interface PipelineLlm {
  readonly endpoint: string;
  readonly defaultModel: string;
  chat(req: {
    readonly model?: string;
    readonly messages: readonly {
      readonly role: 'system' | 'user' | 'assistant';
      readonly content: string;
    }[];
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<{
    readonly id: string;
    readonly model: string;
    readonly content: string;
    readonly tokensIn: number;
    readonly tokensOut: number;
  }>;
}

export interface EntityStoreForRetrieval {
  /**
   * Same shape as `EntityStore.searchSummaries` — duplicated here so
   * the pipeline doesn't depend on the generic `Entity<Payload>`
   * surface. The orchestrator builds a per-kind adapter at boot.
   */
  searchSummaries(
    layerIds: readonly string[],
    query: string,
    opts?: { readonly limit?: number },
  ): readonly {
    readonly id: string;
    readonly kind: string;
    readonly layerId: string;
    readonly slug: string;
    readonly title: string;
    readonly searchableText: string;
  }[];
}

export interface PipelineLogger {
  info(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  error(msg: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface PipelineCounters {
  inc(name: string, by?: number, dims?: Readonly<Record<string, string>>): void;
  observeMs(name: string, value: number, dims?: Readonly<Record<string, string>>): void;
}

// ---------- step interface --------------------------------------------

/**
 * Per-step output the orchestrator gets back. `outputJson` is the
 * already-serialised body for `chat_pipeline_steps.output_json`
 * (the step owns the shape; the orchestrator owns the persistence).
 * `llmCallId` is set when the step ran an LLM call so the orchestrator
 * can persist it.
 */
export interface PipelineStepResult<TOut> {
  readonly value: TOut;
  readonly outputJson: string;
  readonly llmCallId: string | null;
  readonly status: Extract<PipelineStepStatus, 'succeeded' | 'skipped'>;
}

export interface PipelineStep<TIn, TOut> {
  readonly kind: PipelineStepKind;
  run(input: TIn, ctx: PipelineContext, deps: PipelineDeps): Promise<PipelineStepResult<TOut>>;
}

// ---------- stable error codes ----------------------------------------

export const ERROR_CODES = Object.freeze({
  InvalidStepOutput: 'invalid_step_output',
  AnswerTimeout: 'answer_timeout',
  AnswerLlmFailed: 'answer_llm_failed',
  IntentLlmFailed: 'intent_llm_failed',
  EntitiesLlmFailed: 'entities_llm_failed',
  RetrievalFailed: 'retrieval_failed',
});
