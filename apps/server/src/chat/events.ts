/**
 * Phase 6.3 — `chat.*` bus event taxonomy.
 *
 * Mirrors the shape used by `bus/events.ts` and `scheduled/events.ts`:
 * a closed const tuple of event-type strings + one typed payload
 * interface per row. The orchestrator (`pipeline/orchestrator.ts`)
 * publishes these whenever a message moves through its lifecycle.
 *
 * Anti-leak invariants:
 *  - Payloads carry IDs (conversation, message, run, step) + the
 *    pipeline-step kind/status + a clipped `errorCode` when relevant.
 *    They MUST NOT carry the assistant's content, the user's content,
 *    or the LLM request/response payloads — those live in
 *    `chat_messages` and `chat_pipeline_steps` rows where they're
 *    behind authenticated routes (per plan §10).
 *  - `chat.step.*` carries the `kind` and the `attempt` number so a
 *    Kanban / dashboard can render step transitions without joining.
 *  - Pipeline runs are in-process: these events go through the
 *    in-memory bus, not the durable outbox (ADR 0020, plan §4.1).
 */

import type { PipelineStepKind, PipelineStepStatus } from '@bunny2/shared';

export const CHAT_EVENT_TYPES = [
  'chat.message.received',
  'chat.message.answered',
  'chat.message.failed',
  'chat.step.started',
  'chat.step.succeeded',
  'chat.step.failed',
] as const;

export type ChatEventType = (typeof CHAT_EVENT_TYPES)[number];

/**
 * Fired the moment the orchestrator accepts a user message and starts
 * the pipeline. The assistant message row exists in `queued` state by
 * the time this fires.
 */
export interface ChatMessageReceivedPayload {
  readonly conversationId: string;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly layerId: string;
  readonly userId: string;
}

/**
 * Fired after the assistant message moves to `done`. Carries the
 * token counts so a dashboard can summarise spend without joining
 * `llm_calls`.
 */
export interface ChatMessageAnsweredPayload {
  readonly conversationId: string;
  readonly assistantMessageId: string;
  readonly layerId: string;
  readonly userId: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

/**
 * Fired when a pipeline step hard-fails (after retries) and the
 * assistant message resolves to `failed`. `errorCode` is the same
 * stable code the failing step wrote to `chat_pipeline_steps`.
 */
export interface ChatMessageFailedPayload {
  readonly conversationId: string;
  readonly assistantMessageId: string;
  readonly layerId: string;
  readonly userId: string;
  readonly errorCode: string;
}

export interface ChatStepStartedPayload {
  readonly runId: string;
  readonly stepId: string;
  readonly assistantMessageId: string;
  readonly conversationId: string;
  readonly layerId: string;
  readonly userId: string;
  readonly kind: PipelineStepKind;
  readonly attempt: number;
}

export interface ChatStepSucceededPayload {
  readonly runId: string;
  readonly stepId: string;
  readonly assistantMessageId: string;
  readonly conversationId: string;
  readonly layerId: string;
  readonly userId: string;
  readonly kind: PipelineStepKind;
  readonly status: Extract<PipelineStepStatus, 'succeeded' | 'skipped'>;
  readonly attempt: number;
  readonly durationMs: number;
}

export interface ChatStepFailedPayload {
  readonly runId: string;
  readonly stepId: string;
  readonly assistantMessageId: string;
  readonly conversationId: string;
  readonly layerId: string;
  readonly userId: string;
  readonly kind: PipelineStepKind;
  readonly attempt: number;
  readonly errorCode: string;
}
