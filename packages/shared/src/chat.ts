import { z } from 'zod';

/**
 * Cross-package zod schemas for the chat domain (phase 6.1).
 *
 * Server-internal row types live under
 * `apps/server/src/chat/repos/*`; these schemas describe the safe
 * shape that crosses the HTTP boundary and is shared with the web
 * client. Timestamps are ISO-8601 strings, like the rest of the
 * shared package.
 *
 * The five entities mirror the five tables in
 * `apps/server/src/storage/migrations/0014_chat.sql`:
 *
 *   - `ChatConversation`     — one per `(layer_id, user_id)`-scoped
 *                              thread; soft-deletable.
 *   - `ChatMessage`          — ordered turns inside a conversation.
 *                              `role` and `status` mirror the SQL
 *                              CHECK constraints 1:1.
 *   - `ChatPipelineRun`      — one per assistant message attempting
 *                              an answer.
 *   - `ChatPipelineStep`     — one per (run, kind) pipeline step.
 *   - `ChatMessageFeedback`  — thumbs up/down on an assistant
 *                              message; UNIQUE on `message_id`.
 *
 * Roles and statuses are closed enums and must match the SQL
 * CHECKs exactly; a drift would let the zod boundary accept rows
 * the storage layer rejects.
 */

// ---------- enums ------------------------------------------------------

export const ChatMessageRoleSchema = z.enum(['user', 'assistant', 'system']);
export type ChatMessageRole = z.infer<typeof ChatMessageRoleSchema>;

export const ChatMessageStatusSchema = z.enum(['queued', 'running', 'done', 'failed']);
export type ChatMessageStatus = z.infer<typeof ChatMessageStatusSchema>;

export const PipelineStepKindSchema = z.enum(['intent', 'entities', 'retrieval', 'answer']);
export type PipelineStepKind = z.infer<typeof PipelineStepKindSchema>;

export const PipelineStepStatusSchema = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
]);
export type PipelineStepStatus = z.infer<typeof PipelineStepStatusSchema>;

export const PipelineRunStatusSchema = z.enum(['pending', 'running', 'succeeded', 'failed']);
export type PipelineRunStatus = z.infer<typeof PipelineRunStatusSchema>;

export const ChatFeedbackValueSchema = z.enum(['up', 'down']);
export type ChatFeedbackValue = z.infer<typeof ChatFeedbackValueSchema>;

// ---------- conversation ----------------------------------------------

export const ChatConversationSchema = z
  .object({
    id: z.string().uuid(),
    layerId: z.string().uuid(),
    userId: z.string().uuid(),
    title: z.string().min(1).max(160),
    locale: z.string().min(2).max(16),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    deletedBy: z.string().uuid().nullable(),
  })
  .strict();
export type ChatConversation = z.infer<typeof ChatConversationSchema>;

// ---------- message ---------------------------------------------------

export const ChatMessageSchema = z
  .object({
    id: z.string().uuid(),
    conversationId: z.string().uuid(),
    role: ChatMessageRoleSchema,
    content: z.string(),
    status: ChatMessageStatusSchema,
    model: z.string().nullable(),
    tokensIn: z.number().int().min(0).nullable(),
    tokensOut: z.number().int().min(0).nullable(),
    correlationId: z.string().min(1),
    flowId: z.string().min(1),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .strict();
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// ---------- pipeline run ---------------------------------------------

export const ChatPipelineRunSchema = z
  .object({
    id: z.string().uuid(),
    messageId: z.string().uuid(),
    status: PipelineRunStatusSchema,
    startedAt: z.string(),
    endedAt: z.string().nullable(),
  })
  .strict();
export type ChatPipelineRun = z.infer<typeof ChatPipelineRunSchema>;

// ---------- pipeline step --------------------------------------------

/**
 * `inputJson` / `outputJson` are opaque to the shared package. The
 * orchestrator (phase 6.3) defines the per-kind shapes; here they're
 * untyped JSON so the schema does not couple to the pipeline contract.
 * Stored as serialised strings in SQLite to match the `..._json`
 * convention used elsewhere.
 */
export const ChatPipelineStepSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid(),
    kind: PipelineStepKindSchema,
    status: PipelineStepStatusSchema,
    attempt: z.number().int().positive(),
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    inputJson: z.string().nullable(),
    outputJson: z.string().nullable(),
    llmCallId: z.string().uuid().nullable(),
    errorCode: z.string().nullable(),
  })
  .strict();
export type ChatPipelineStep = z.infer<typeof ChatPipelineStepSchema>;

// ---------- feedback --------------------------------------------------

export const ChatMessageFeedbackSchema = z
  .object({
    id: z.string().uuid(),
    messageId: z.string().uuid(),
    userId: z.string().uuid(),
    value: ChatFeedbackValueSchema,
    reason: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();
export type ChatMessageFeedback = z.infer<typeof ChatMessageFeedbackSchema>;
