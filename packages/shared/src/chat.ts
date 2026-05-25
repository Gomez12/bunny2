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

/**
 * The closed set of intents the intent step can emit. Moved into
 * the shared package in phase 7.2 so that proposal `skill` artifact
 * specs (`packages/shared/src/proposals.ts`) can pin the same enum
 * the chat pipeline routes on without re-declaring it.
 *
 * Server-internal aliases (`IntentEnum`, `Intent`) in
 * `apps/server/src/chat/pipeline/types.ts` re-export this schema
 * so the orchestrator import path stays stable.
 */
export const ChatIntentSchema = z.enum([
  'question.entity_lookup',
  'question.summary',
  'command.create',
  'command.update',
  'smalltalk',
  'unsupported',
]);
export type ChatIntent = z.infer<typeof ChatIntentSchema>;

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
    /**
     * Auto-summary follow-up — `messageCount` watermark from the
     * last summarize run. NULL on threads that have never been
     * summarized; the handler uses it as the idempotency guard.
     */
    lastSummarizedMessageCount: z.number().int().min(0).nullable(),
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

// ---------- list summary (phase 6.6) ---------------------------------
//
// The list endpoint (`GET /l/:slug/chat/conversations`) returns each
// `ChatConversation` plus aggregated thumbs-up / thumbs-down counts
// so the `RecentChatsWidget` (on the layer dashboard) can render a
// ratio without N+1 fetches. Phase 6.5's `LayerChatPage.tsx` reads
// only the base fields and ignores the new counts.

export const ChatConversationSummarySchema = ChatConversationSchema.extend({
  feedbackUpCount: z.number().int().min(0),
  feedbackDownCount: z.number().int().min(0),
}).strict();
export type ChatConversationSummary = z.infer<typeof ChatConversationSummarySchema>;

// ---------- board snapshot (phase 6.6) -------------------------------
//
// The Kanban board (`/l/:slug/chat/board`) fetches a "recent N
// messages with their pipeline-state snapshot" view. The endpoint
// returns assistant messages only — user messages have no pipeline
// run and live on the column logic as their conversation's last
// assistant turn. The client buckets each row into a column based
// on the message `status` and (when running) the step kind currently
// `running` (or last `running`).

export const BoardCapabilityChipSchema = z
  .object({
    capabilityId: z.string(),
    name: z.string(),
  })
  .strict();
export type BoardCapabilityChip = z.infer<typeof BoardCapabilityChipSchema>;

export const ChatBoardStepAttributionSchema = z
  .object({
    skills: z.array(BoardCapabilityChipSchema),
    tools: z.array(BoardCapabilityChipSchema),
    agents: z.array(BoardCapabilityChipSchema),
  })
  .strict();
export type ChatBoardStepAttribution = z.infer<typeof ChatBoardStepAttributionSchema>;

export const ChatBoardStepSnapshotSchema = z
  .object({
    kind: PipelineStepKindSchema,
    status: PipelineStepStatusSchema,
    /**
     * Phase 7.6 — capability-attribution chips. Only the `answer`
     * step currently writes this (skill prompt-fragments). `null`
     * when no capability contributed (the common phase-6 case).
     */
    attribution: ChatBoardStepAttributionSchema.nullable().optional(),
  })
  .strict();
export type ChatBoardStepSnapshot = z.infer<typeof ChatBoardStepSnapshotSchema>;

export const ChatBoardRunSnapshotSchema = z
  .object({
    id: z.string().uuid(),
    status: PipelineRunStatusSchema,
  })
  .strict();
export type ChatBoardRunSnapshot = z.infer<typeof ChatBoardRunSnapshotSchema>;

export const ChatBoardItemSchema = z
  .object({
    messageId: z.string().uuid(),
    conversationId: z.string().uuid(),
    conversationTitle: z.string(),
    role: ChatMessageRoleSchema,
    status: ChatMessageStatusSchema,
    contentPreview: z.string(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
    run: ChatBoardRunSnapshotSchema.nullable(),
    steps: z.array(ChatBoardStepSnapshotSchema),
  })
  .strict();
export type ChatBoardItem = z.infer<typeof ChatBoardItemSchema>;

// ---------- per-layer chat settings (follow-up) ---------------------
//
// Per-layer overrides for the chat LLM model + embedding budget. The
// settings row is 1:1 with `layers(id)`; NULL on a field = "inherit
// the system default". Absent row = inherit every default. The
// server-side `LayerChatSettings` row carries the same shape plus
// audit timestamps; the wire payload here is the editable subset.

const CHAT_MODEL_MAX_LEN = 200;

/**
 * Editable shape for the per-layer chat settings PUT endpoint. Every
 * field is nullable: a non-null value pins the override, `null`
 * (re)inherits the system default.
 */
export const LayerChatSettingsInputSchema = z
  .object({
    model: z.string().min(1).max(CHAT_MODEL_MAX_LEN).nullable(),
    embeddingDailyCap: z.number().int().min(0).nullable(),
    embeddingMonthlyCap: z.number().int().min(0).nullable(),
  })
  .strict();
export type LayerChatSettingsInput = z.infer<typeof LayerChatSettingsInputSchema>;

/**
 * Read-side shape for `GET /l/:slug/settings/chat`. The route widens
 * the input schema with `layerId` + ISO timestamps so the UI can
 * show "last updated".
 */
export const LayerChatSettingsSchema = z
  .object({
    layerId: z.string().uuid(),
    model: z.string().max(CHAT_MODEL_MAX_LEN).nullable(),
    embeddingDailyCap: z.number().int().min(0).nullable(),
    embeddingMonthlyCap: z.number().int().min(0).nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type LayerChatSettings = z.infer<typeof LayerChatSettingsSchema>;

/**
 * GET response — includes current-day + last-30-days spend so the
 * settings page can render a "today / month so far" readout without
 * a second round-trip. Token counts only — never raw payloads.
 */
export const LayerChatSettingsResponseSchema = z
  .object({
    source: z.enum(['default', 'saved']),
    settings: LayerChatSettingsSchema,
    spend: z
      .object({
        day: z.string(),
        tokensToday: z.number().int().min(0),
        tokensLast30Days: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();
export type LayerChatSettingsResponse = z.infer<typeof LayerChatSettingsResponseSchema>;
