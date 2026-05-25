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
import { ChatIntentSchema, type ChatIntent } from '@bunny2/shared';
import type { ChatMessage } from '../repos/chat-messages-repo';
import { ENTITY_KIND_TO_LANCE_TABLE } from '../embeddings/lance-tables';
// Type-only import — keeps the pipeline → proposals edge purely
// structural so the JS module graph stays acyclic.
import type { CapabilityRegistry } from '../../proposals/capability-registry';

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

/**
 * The intent enum lives in `packages/shared` (`ChatIntentSchema`)
 * so cross-package consumers (proposal specs in phase 7.2) can pin
 * the same closed set. Re-exported here under the orchestrator's
 * historic names to keep server import paths stable.
 */
export const IntentEnum = ChatIntentSchema;
export type Intent = ChatIntent;

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
    /** Phase 6.4 — true when the stream was cancelled mid-response. */
    aborted: z.boolean().optional(),
    /** Phase 6.4 — true when the answer was streamed (vs. non-stream). */
    streamed: z.boolean().optional(),
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
  /**
   * Per-layer chat model resolution. Each LLM-backed step (intent /
   * entities / answer) MUST forward `chatModel.model` as the per-call
   * model override and stamp `metadata.modelSource = chatModel.source`
   * so `llm_calls.model_source` lands `'system'` vs `'layer'`. Absent
   * (legacy fixtures that build a context by hand) falls back to the
   * LLM client default.
   */
  readonly chatModel?: { readonly model: string; readonly source: 'system' | 'layer' };
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
  /**
   * Phase 6.4 — chunk sink for the answer step. When provided AND
   * the step's wrapped LLM exposes `chatStream`, the answerer
   * streams; otherwise it falls back to non-streaming `chat()`.
   */
  readonly chunkSink?: PipelineChunkSink;
  /**
   * Phase 6.4 — caller abort signal (HTTP client disconnect). The
   * orchestrator combines it with the per-step 60 s timeout into a
   * single linked signal handed to `chatStream`/`chat`. Mid-stream
   * abort surfaces as an `AbortError` from the iterator, persists
   * the partial assistant content, and marks the message `failed`.
   */
  readonly abortSignal?: AbortSignal;
  /**
   * Phase 7.5 — per-layer capability registry. Optional so the
   * existing pipeline tests (which don't care about capabilities)
   * keep working unchanged. When present, the answer step reads
   * activated `skill` rows via `loadSkillFragments(registry, layerId,
   * intent)` and injects their prompt fragments AFTER the hard
   * grounding system prompt + BEFORE the user/history turns. Sandbox
   * replays pass a `withOverlay(...)` view here so the proposed
   * variant sees the proposal's spec without touching the live
   * registry.
   */
  readonly capabilityRegistry?: CapabilityRegistry;
}

/**
 * Narrow `LlmClient` shape — same as the production interface but
 * declared here so the step files don't import from `../../llm` in
 * test fixtures.
 *
 * Phase 6.4 — `chatStream` is the optional streaming counterpart to
 * `chat`. The answer step uses it when (a) the upstream client
 * exposes it AND (b) the orchestrator was handed a chunk sink. The
 * fall-back to `chat()` keeps non-streaming environments (the
 * existing 6.3 integration test, the programmable-LLM fixture)
 * working unchanged.
 */
export interface PipelineLlmStreamChunk {
  readonly delta?: string;
  readonly done?: boolean;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly model?: string;
}

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
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly id: string;
    readonly model: string;
    readonly content: string;
    readonly tokensIn: number;
    readonly tokensOut: number;
  }>;
  chatStream?(req: {
    readonly model?: string;
    readonly messages: readonly {
      readonly role: 'system' | 'user' | 'assistant';
      readonly content: string;
    }[];
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): AsyncIterable<PipelineLlmStreamChunk>;
}

/**
 * Phase 6.4 — chunk sink the SSE route hands the orchestrator. One
 * call per non-terminal `delta` from the answerer; the route writes
 * `event: token` to the SSE stream. Terminal frames are NOT passed
 * here — the orchestrator emits its own `done` event after the step
 * row is persisted.
 */
export type PipelineChunkSink = (chunk: { readonly delta: string }) => void;

/**
 * Phase 6.4 — per-step lifecycle hook for the SSE route. Fires
 * synchronously after the orchestrator publishes the corresponding
 * `chat.step.*` bus event so the SSE writer can emit `event: step`
 * without subscribing to the in-process bus adapter.
 */
export interface PipelineStepEvent {
  readonly kind: PipelineStepKind;
  readonly status: 'running' | PipelineStepStatus;
  readonly attempt: number;
  readonly stepId: string;
  readonly durationMs?: number;
  readonly errorCode?: string;
}
export type PipelineStepEventSink = (event: PipelineStepEvent) => void;

export interface EntityStoreForRetrieval {
  /**
   * Same shape as `EntityStore.searchSummaries` — duplicated here so
   * the pipeline doesn't depend on the generic `Entity<Payload>`
   * surface. The orchestrator builds a per-kind adapter at boot.
   *
   * Phase 7.1 made this async: the orchestrator's adapter may consult
   * a LanceDB vector path before falling back to the underlying
   * synchronous SQLite LIKE path. The chat pipeline's retrieval step
   * awaits this call. The auth boundary
   * (`overall.md` §5 invariant 8 / ADR 0021 §1) is unchanged — the
   * `layerIds` filter still runs BEFORE any candidate selection,
   * vector or LIKE.
   */
  searchSummaries(
    layerIds: readonly string[],
    query: string,
    opts?: { readonly limit?: number },
  ): Promise<
    readonly {
      readonly id: string;
      readonly kind: string;
      readonly layerId: string;
      readonly slug: string;
      readonly title: string;
      readonly searchableText: string;
    }[]
  >;
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
  /**
   * Phase 7.6 — optional capability-attribution JSON written to
   * `chat_pipeline_steps.attribution_json`. Currently only the
   * answer step emits it (skill prompt-fragments); the Kanban
   * board reads it to render `[skill:<name>]` chips. Omitted →
   * column stays NULL (phase-6 byte-identical default).
   */
  readonly attributionJson?: string | null;
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
  AnswerAborted: 'answer_aborted',
  IntentLlmFailed: 'intent_llm_failed',
  EntitiesLlmFailed: 'entities_llm_failed',
  RetrievalFailed: 'retrieval_failed',
});
