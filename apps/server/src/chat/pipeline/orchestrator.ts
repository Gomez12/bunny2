/**
 * Phase 6.3 — pipeline orchestrator.
 *
 * Runs the four steps (intent → entities → retrieval → answer) for
 * one user message. Owns:
 *   - `chat_pipeline_runs` row creation + terminal transition.
 *   - `chat_pipeline_steps` row per step (start row + end update).
 *   - `chat_messages` assistant row lifecycle (queued → running →
 *     done|failed).
 *   - `conversation.updated_at` touch.
 *   - `chat.message.*` + `chat.step.*` bus events.
 *   - The §4.1 inline retry policy (2 attempts: 250ms then 1s
 *     backoff) and the §4.1 zod-parse-failure-retry policy.
 *
 * Out of scope (phase 6.4): HTTP, SSE, streaming. The orchestrator
 * is callable in-process and returns the persisted assistant message
 * id + final content.
 *
 * Observability:
 *  - Console + file-log via `deps.logger` (defaults to console).
 *  - Per-step duration counter `chat.pipeline.step.duration_ms`
 *    with dimensions `{ kind, status }`.
 *  - Per-step failure counter `chat.pipeline.step.failed`.
 *  - Per-message terminal counter `chat.pipeline.message.<status>`.
 *  - No analytics (server-only — plan §10 + AGENTS.md privacy rule).
 *  - No full LLM payload logging; only token counts + ids.
 */

import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import type { LlmCallLog } from '../../llm/call-log';
import type { LlmClient } from '../../llm/types';
import { withTelemetry } from '../../llm/telemetry';
import type { ChatConversationsRepo } from '../repos/chat-conversations-repo';
import type { ChatMessage, ChatMessagesRepo } from '../repos/chat-messages-repo';
import type { ChatPipelineRunsRepo } from '../repos/chat-pipeline-runs-repo';
import type { ChatPipelineStep, ChatPipelineStepsRepo } from '../repos/chat-pipeline-steps-repo';
import {
  CHAT_EVENT_TYPES,
  type ChatMessageAnsweredPayload,
  type ChatMessageFailedPayload,
  type ChatMessageReceivedPayload,
  type ChatStepFailedPayload,
  type ChatStepStartedPayload,
  type ChatStepSucceededPayload,
} from '../events';
import { createIntentStep, type IntentStepInput } from './intent-step';
import { createEntitiesStep, type EntitiesStepInput } from './entities-step';
import { createRetrievalStep, type RetrievalStepInput } from './retrieval-step';
import {
  createAnswerStep,
  COMMAND_NOT_SUPPORTED_MESSAGE,
  SMALLTALK_FALLBACK_MESSAGE,
  type AnswerStepInput,
} from './answer-step';
import { InvalidStepOutputError, delay } from './step-utils';
import {
  ERROR_CODES,
  historyFromMessages,
  type AnswerOutput,
  type EntitiesOutput,
  type EntityKind,
  type EntityStoreForRetrieval,
  type IntentOutput,
  type PipelineContext,
  type PipelineDeps,
  type PipelineLogger,
  type PipelineCounters,
  type PipelineStep,
  type PipelineStepKind,
  type PipelineStepResult,
  type PipelineStepStatus,
  type RetrievalOutput,
} from './types';

const HISTORY_TURN_CAP = 20;
const RETRY_BACKOFFS_MS = [250, 1000] as const;

const HARDFAIL_FALLBACK_MESSAGE =
  "I couldn't process that. Try again in a moment, or rephrase your question.";

const noopCounters: PipelineCounters = {
  inc: () => undefined,
  observeMs: () => undefined,
};

const defaultLogger: PipelineLogger = {
  info: (msg, fields) => console.log(`[chat.pipeline] ${msg}`, fields ?? {}),
  warn: (msg, fields) => console.warn(`[chat.pipeline] ${msg}`, fields ?? {}),
  error: (msg, fields) => console.error(`[chat.pipeline] ${msg}`, fields ?? {}),
};

export interface RunPipelineInput {
  readonly conversationId: string;
  readonly userMessageId: string;
  readonly userContent: string;
  readonly layerId: string;
  readonly effectiveLayerIds: readonly string[];
  readonly userId: string;
  readonly correlationId?: string;
  readonly flowId?: string;
}

export interface RunPipelineDeps {
  readonly db: Database;
  readonly bus: MessageBus;
  readonly llm: LlmClient;
  readonly llmCallLog: LlmCallLog;
  readonly conversationsRepo: ChatConversationsRepo;
  readonly messagesRepo: ChatMessagesRepo;
  readonly runsRepo: ChatPipelineRunsRepo;
  readonly stepsRepo: ChatPipelineStepsRepo;
  readonly getEntityStore: (kind: EntityKind) => EntityStoreForRetrieval | null;
  readonly logger?: PipelineLogger;
  readonly counters?: PipelineCounters;
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
}

export interface RunPipelineResult {
  readonly assistantMessageId: string;
  readonly assistantContent: string;
  readonly status: 'done' | 'failed';
  readonly runId: string;
}

/**
 * Entry point. The caller (phase-6.4 HTTP route, or a test) has
 * already inserted the user `chat_messages` row. We create the
 * assistant row, drive the four pipeline steps, persist each step,
 * publish the lifecycle events, and return the assistant message id
 * + final content + status.
 */
export async function runPipeline(
  input: RunPipelineInput,
  deps: RunPipelineDeps,
): Promise<RunPipelineResult> {
  const clock = deps.clock ?? ((): Date => new Date());
  const newId = deps.idFactory ?? ((): string => crypto.randomUUID());
  const logger = deps.logger ?? defaultLogger;
  const counters = deps.counters ?? noopCounters;
  const correlationId = input.correlationId ?? newId();
  const flowId = input.flowId ?? input.conversationId;

  // ----- assistant message + run row -----
  const assistantMessageId = newId();
  const startedAtIso = clock().toISOString();
  deps.messagesRepo.insertMessage({
    id: assistantMessageId,
    conversationId: input.conversationId,
    role: 'assistant',
    content: '',
    status: 'queued',
    correlationId,
    flowId,
    now: startedAtIso,
  });
  deps.messagesRepo.updateMessage(assistantMessageId, { status: 'running' });

  const runId = newId();
  deps.runsRepo.insertRun({
    id: runId,
    messageId: assistantMessageId,
    status: 'running',
    startedAt: startedAtIso,
  });

  // Touch the conversation so the list view sorts it to the top.
  deps.conversationsRepo.touchConversation(input.conversationId, startedAtIso);

  await publishMessageReceived(deps.bus, {
    conversationId: input.conversationId,
    userMessageId: input.userMessageId,
    assistantMessageId,
    layerId: input.layerId,
    userId: input.userId,
  });

  // ----- pipeline context -----
  const history = loadHistory(deps.messagesRepo, input.conversationId, input.userMessageId);
  const ctx: PipelineContext = {
    conversationId: input.conversationId,
    userMessageId: input.userMessageId,
    assistantMessageId,
    runId,
    layerId: input.layerId,
    effectiveLayerIds: input.effectiveLayerIds,
    userId: input.userId,
    correlationId,
    flowId,
    history,
    userContent: input.userContent,
  };

  // ----- run the four steps -----
  const intentStep = createIntentStep();
  const entitiesStep = createEntitiesStep();
  const retrievalStep = createRetrievalStep();
  const answerStep = createAnswerStep();

  let intentResult: PipelineStepResult<IntentOutput> | null = null;
  let entitiesResult: PipelineStepResult<EntitiesOutput> | null = null;
  let retrievalResult: PipelineStepResult<RetrievalOutput> | null = null;
  let answerResult: PipelineStepResult<AnswerOutput> | null = null;

  try {
    intentResult = await runStepWithPersistence(
      intentStep,
      { userContent: input.userContent } satisfies IntentStepInput,
      ctx,
      deps,
      logger,
      counters,
      newId,
      clock,
      true /* zodRetry */,
      true /* usesLlm */,
    );
  } catch (err) {
    return await failPipelineWithFallback(
      err,
      'intent',
      runId,
      assistantMessageId,
      input,
      ctx,
      deps,
      logger,
      counters,
      clock,
      newId,
    );
  }

  try {
    entitiesResult = await runStepWithPersistence(
      entitiesStep,
      { userContent: input.userContent, intent: intentResult.value } satisfies EntitiesStepInput,
      ctx,
      deps,
      logger,
      counters,
      newId,
      clock,
      true /* zodRetry */,
      true /* usesLlm */,
    );
  } catch (err) {
    return await failPipelineWithFallback(
      err,
      'entities',
      runId,
      assistantMessageId,
      input,
      ctx,
      deps,
      logger,
      counters,
      clock,
      newId,
    );
  }

  try {
    retrievalResult = await runStepWithPersistence(
      retrievalStep,
      {
        intent: intentResult.value,
        entities: entitiesResult.value,
      } satisfies RetrievalStepInput,
      ctx,
      deps,
      logger,
      counters,
      newId,
      clock,
      false /* zodRetry */,
      false /* usesLlm */,
    );
  } catch (err) {
    return await failPipelineWithFallback(
      err,
      'retrieval',
      runId,
      assistantMessageId,
      input,
      ctx,
      deps,
      logger,
      counters,
      clock,
      newId,
    );
  }

  try {
    answerResult = await runStepWithPersistence(
      answerStep,
      {
        intent: intentResult.value,
        retrieval: retrievalResult.value,
      } satisfies AnswerStepInput,
      ctx,
      deps,
      logger,
      counters,
      newId,
      clock,
      false /* zodRetry */,
      true /* usesLlm */,
    );
  } catch (err) {
    return await failPipelineWithFallback(
      err,
      'answer',
      runId,
      assistantMessageId,
      input,
      ctx,
      deps,
      logger,
      counters,
      clock,
      newId,
    );
  }

  // ----- terminal success -----
  const finishedAt = clock().toISOString();
  const finalContent = pickFinalContent(intentResult.value, answerResult.value);

  deps.messagesRepo.updateMessage(assistantMessageId, {
    status: 'done',
    content: finalContent,
    model: answerResult.value.model,
    tokensIn: answerResult.value.tokensIn,
    tokensOut: answerResult.value.tokensOut,
    finishedAt,
  });
  deps.runsRepo.updateRun(runId, { status: 'succeeded', endedAt: finishedAt });
  deps.conversationsRepo.touchConversation(input.conversationId, finishedAt);

  await deps.bus.publish<ChatMessageAnsweredPayload>({
    type: 'chat.message.answered',
    payload: {
      conversationId: input.conversationId,
      assistantMessageId,
      layerId: input.layerId,
      userId: input.userId,
      tokensIn: answerResult.value.tokensIn,
      tokensOut: answerResult.value.tokensOut,
    },
    correlationId,
    flowId,
  });

  counters.inc('chat.pipeline.message.done');
  logger.info('pipeline.message.done', {
    conversationId: input.conversationId,
    assistantMessageId,
    runId,
    tokensIn: answerResult.value.tokensIn,
    tokensOut: answerResult.value.tokensOut,
  });

  return {
    assistantMessageId,
    assistantContent: finalContent,
    status: 'done',
    runId,
  };
}

// ---------------------------------------------------------------------
// Step persistence + retry plumbing
// ---------------------------------------------------------------------

/**
 * Runs one step with the §4.1 retry policy and full persistence.
 *
 *  - On `InvalidStepOutputError` from an LLM-backed zod-validated
 *    step: retry ONCE. On the second failure, mark the step `failed`
 *    with `error_code='invalid_step_output'` and bubble.
 *  - On any other thrown error: retry inline up to
 *    `RETRY_BACKOFFS_MS.length` times (250ms then 1s). Final failure
 *    marks the step `failed` with the step's error code and bubbles.
 *
 * Per-attempt: a new `chat_pipeline_steps` row is written
 * (`attempt = N`). Steps that complete successfully on attempt 2+
 * still leave a `failed` row for attempt 1 — the audit trail.
 *
 * `usesLlm`: true means we wrap `deps.llm` with `withTelemetry` so
 * the call lands in `llm_calls` AND we get the freshly-minted id to
 * persist on `chat_pipeline_steps.llm_call_id`.
 */
async function runStepWithPersistence<TIn, TOut>(
  step: PipelineStep<TIn, TOut>,
  input: TIn,
  ctx: PipelineContext,
  deps: RunPipelineDeps,
  logger: PipelineLogger,
  counters: PipelineCounters,
  newId: () => string,
  clock: () => Date,
  zodRetry: boolean,
  usesLlm: boolean,
): Promise<PipelineStepResult<TOut>> {
  const maxAttempts = RETRY_BACKOFFS_MS.length + 1; // 1 base + 2 retries
  const zodMaxAttempts = 2; // base + 1 retry

  let lastError: unknown = null;
  let lastErrorCode = errorCodeForStep(step.kind);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAtIso = clock().toISOString();
    const stepId = newId();

    deps.stepsRepo.insertStep({
      id: stepId,
      runId: ctx.runId,
      kind: step.kind,
      status: 'running',
      attempt,
      startedAt: startedAtIso,
      inputJson: safeStringify(input),
    });

    await deps.bus.publish<ChatStepStartedPayload>({
      type: 'chat.step.started',
      payload: {
        runId: ctx.runId,
        stepId,
        assistantMessageId: ctx.assistantMessageId,
        conversationId: ctx.conversationId,
        layerId: ctx.layerId,
        userId: ctx.userId,
        kind: step.kind,
        attempt,
      },
      correlationId: ctx.correlationId,
      flowId: ctx.flowId,
    });

    // Build a per-call telemetry wrapper for LLM-backed steps so we
    // capture the row id `withTelemetry` mints. The wrapper writes
    // its one `llm_calls` row regardless of whether we record the id
    // on the step (so a captured-then-discarded id is fine).
    let capturedLlmCallId: string | null = null;
    const stepLlm = usesLlm
      ? withTelemetry(deps.llm, {
          log: deps.llmCallLog,
          onCall: (id) => {
            capturedLlmCallId = id;
          },
        })
      : deps.llm;

    const stepDeps: PipelineDeps = {
      llm: stepLlm,
      getEntityStore: deps.getEntityStore,
      ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
      ...(deps.counters !== undefined ? { counters: deps.counters } : {}),
      ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
    };

    try {
      const startMs = clock().getTime();
      const result = await step.run(input, ctx, stepDeps);
      const endIso = clock().toISOString();
      const durationMs = clock().getTime() - startMs;

      deps.stepsRepo.updateStep(stepId, {
        status: result.status,
        endedAt: endIso,
        outputJson: result.outputJson,
        llmCallId: result.llmCallId ?? capturedLlmCallId,
      });

      await deps.bus.publish<ChatStepSucceededPayload>({
        type: 'chat.step.succeeded',
        payload: {
          runId: ctx.runId,
          stepId,
          assistantMessageId: ctx.assistantMessageId,
          conversationId: ctx.conversationId,
          layerId: ctx.layerId,
          userId: ctx.userId,
          kind: step.kind,
          status: result.status,
          attempt,
          durationMs,
        },
        correlationId: ctx.correlationId,
        flowId: ctx.flowId,
      });

      counters.observeMs('chat.pipeline.step.duration_ms', durationMs, {
        kind: step.kind,
        status: result.status,
      });
      logger.info('pipeline.step.ok', {
        kind: step.kind,
        status: result.status,
        attempt,
        durationMs,
        assistantMessageId: ctx.assistantMessageId,
      });

      return result;
    } catch (err) {
      const endIso = clock().toISOString();
      const isZodFailure = err instanceof InvalidStepOutputError;
      const errorCode = isZodFailure ? ERROR_CODES.InvalidStepOutput : errorCodeForStep(step.kind);
      lastError = err;
      lastErrorCode = errorCode;

      const cap = isZodFailure ? zodMaxAttempts : maxAttempts;
      const isFinal = attempt >= cap || (isZodFailure && !zodRetry);

      deps.stepsRepo.updateStep(stepId, {
        status: 'failed',
        endedAt: endIso,
        errorCode,
        llmCallId: capturedLlmCallId,
      });

      await deps.bus.publish<ChatStepFailedPayload>({
        type: 'chat.step.failed',
        payload: {
          runId: ctx.runId,
          stepId,
          assistantMessageId: ctx.assistantMessageId,
          conversationId: ctx.conversationId,
          layerId: ctx.layerId,
          userId: ctx.userId,
          kind: step.kind,
          attempt,
          errorCode,
        },
        correlationId: ctx.correlationId,
        flowId: ctx.flowId,
      });

      counters.inc('chat.pipeline.step.failed', 1, {
        kind: step.kind,
        errorCode,
      });
      // Debug-level for the underlying error: we keep stack traces
      // out of info logs. The clipped errorCode is on the step row.
      logger.warn('pipeline.step.failed', {
        kind: step.kind,
        attempt,
        errorCode,
        assistantMessageId: ctx.assistantMessageId,
        // Bare message only — no stack at info level (AGENTS.md §Logging).
        message: stringMessage(err),
      });

      if (isFinal) {
        throw new StepFailure(errorCode, err);
      }
      // Backoff before the next attempt. Pick the backoff for the
      // upcoming attempt index (attempt 1 done → use backoff[0]).
      const backoff = RETRY_BACKOFFS_MS[attempt - 1] ?? 0;
      await delay(backoff);
    }
  }
  // Defensive — the loop either returns or throws.
  throw new StepFailure(lastErrorCode, lastError);
}

class StepFailure extends Error {
  readonly errorCode: string;
  readonly stepCause: unknown;
  constructor(errorCode: string, cause: unknown) {
    super(`pipeline step failed: ${errorCode}`);
    this.name = 'StepFailure';
    this.errorCode = errorCode;
    this.stepCause = cause;
  }
}

function errorCodeForStep(kind: PipelineStepKind): string {
  switch (kind) {
    case 'intent':
      return ERROR_CODES.IntentLlmFailed;
    case 'entities':
      return ERROR_CODES.EntitiesLlmFailed;
    case 'retrieval':
      return ERROR_CODES.RetrievalFailed;
    case 'answer':
      return ERROR_CODES.AnswerLlmFailed;
  }
}

// ---------------------------------------------------------------------
// Terminal-failure path
// ---------------------------------------------------------------------

async function failPipelineWithFallback(
  err: unknown,
  failedKind: PipelineStepKind,
  runId: string,
  assistantMessageId: string,
  input: RunPipelineInput,
  ctx: PipelineContext,
  deps: RunPipelineDeps,
  logger: PipelineLogger,
  counters: PipelineCounters,
  clock: () => Date,
  _newId: () => string,
): Promise<RunPipelineResult> {
  void _newId;
  const errorCode = err instanceof StepFailure ? err.errorCode : 'unknown_failure';
  const finishedAt = clock().toISOString();

  deps.messagesRepo.updateMessage(assistantMessageId, {
    status: 'failed',
    content: HARDFAIL_FALLBACK_MESSAGE,
    finishedAt,
  });
  deps.runsRepo.updateRun(runId, { status: 'failed', endedAt: finishedAt });
  deps.conversationsRepo.touchConversation(input.conversationId, finishedAt);

  await deps.bus.publish<ChatMessageFailedPayload>({
    type: 'chat.message.failed',
    payload: {
      conversationId: input.conversationId,
      assistantMessageId,
      layerId: input.layerId,
      userId: input.userId,
      errorCode,
    },
    correlationId: ctx.correlationId,
    flowId: ctx.flowId,
  });

  counters.inc('chat.pipeline.message.failed', 1, { failedKind, errorCode });
  logger.error('pipeline.message.failed', {
    conversationId: input.conversationId,
    assistantMessageId,
    failedKind,
    errorCode,
  });

  return {
    assistantMessageId,
    assistantContent: HARDFAIL_FALLBACK_MESSAGE,
    status: 'failed',
    runId,
  };
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

async function publishMessageReceived(
  bus: MessageBus,
  payload: ChatMessageReceivedPayload,
): Promise<void> {
  await bus.publish<ChatMessageReceivedPayload>({
    type: 'chat.message.received',
    payload,
  });
}

function loadHistory(
  repo: ChatMessagesRepo,
  conversationId: string,
  userMessageId: string,
): { readonly role: 'user' | 'assistant' | 'system'; readonly content: string }[] {
  // Pull the full thread and slice the last HISTORY_TURN_CAP turns
  // EXCLUDING the just-arrived user message (the answer step lays
  // it down as the final `user` message in the prompt itself).
  const all: ChatMessage[] = repo.listByConversation(conversationId);
  const filtered = all.filter((m) => m.id !== userMessageId && m.status !== 'failed');
  const sliced = filtered.slice(-HISTORY_TURN_CAP);
  return historyFromMessages(sliced);
}

function pickFinalContent(intent: IntentOutput, answer: AnswerOutput): string {
  // The smalltalk path keeps the LLM's reply; we only override when
  // the answerer returned empty content (most providers shouldn't,
  // but we guard against it).
  if (intent.intent === 'smalltalk' && answer.content.trim().length === 0) {
    return SMALLTALK_FALLBACK_MESSAGE;
  }
  if (answer.skipped) {
    return COMMAND_NOT_SUPPORTED_MESSAGE;
  }
  return answer.content;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"<unserialisable>"';
  }
}

function stringMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Re-export the topic registry so callers can wire subscribers in
// one place without hunting down the `events.ts` file directly.
export { CHAT_EVENT_TYPES };
export type { ChatPipelineStep };
export type { PipelineStepStatus };
