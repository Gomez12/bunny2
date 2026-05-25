import type { Hono } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import { z } from 'zod';
import {
  ChatFeedbackValueSchema,
  type ChatBoardItem,
  type ChatBoardStepSnapshot,
  type PipelineRunStatus,
  type PipelineStepKind,
  type PipelineStepStatus,
  type ChatMessageRole,
  type ChatMessageStatus,
} from '@bunny2/shared';
import type { LlmClient } from '../../llm/types';
import type { LlmCallLog } from '../../llm/call-log';
import { createChatConversationsRepo } from '../../chat/repos/chat-conversations-repo';
import { createChatMessagesRepo } from '../../chat/repos/chat-messages-repo';
import { createChatPipelineRunsRepo } from '../../chat/repos/chat-pipeline-runs-repo';
import { createChatPipelineStepsRepo } from '../../chat/repos/chat-pipeline-steps-repo';
import { createChatMessageFeedbackRepo } from '../../chat/repos/chat-message-feedback-repo';
import { createChatModelResolver, runPipeline } from '../../chat/pipeline';
import type { EntityKind, EntityStoreForRetrieval, PipelineStepEvent } from '../../chat/pipeline';
import { createLayerChatSettingsRepo } from '../../chat/repos/layer-chat-settings-repo';
import { summarizeConversation } from '../../chat/summarize-conversation';
import { createRequireLayer } from '../middleware/layer';
import type { HonoVariables } from '../types';
import type { LocalesConfig } from '../../config/schema';

/**
 * Phase 6.4 — `/l/:slug/chat/*` HTTP routes.
 *
 * Sits behind the global `requireAuth` + `requirePasswordCurrent` +
 * `withEffectiveLayers` chain. Per-route mounting uses
 * `createRequireLayer()` so a non-member gets the same
 * `404 errors.layer.notVisible` response the rest of `/l/:slug/*`
 * uses — see `apps/server/src/http/middleware/layer.ts` for the
 * rationale.
 *
 * Five surfaces:
 *  - `POST /l/:slug/chat/conversations` — create. Title defaults to
 *    `t('chat.conversation.emptyTitle')` (the web client renames
 *    after the first message lands).
 *  - `GET  /l/:slug/chat/conversations` — list, newest first.
 *  - `GET  /l/:slug/chat/conversations/:id` — single, 404 across
 *    users / layers.
 *  - `DELETE /l/:slug/chat/conversations/:id` — soft-delete.
 *  - `GET  /l/:slug/chat/conversations/:id/messages` — full thread.
 *  - `POST /l/:slug/chat/conversations/:id/messages` — SSE. Body
 *    `{ content }` only. The route inserts the user `chat_messages`
 *    row, opens the SSE stream, and calls `runPipeline()` with a
 *    chunk sink + step callback so the stream emits `step`, `token`,
 *    `done`, `error` frames in real time.
 *  - `POST /l/:slug/chat/messages/:id/feedback` — thumbs up/down.
 *
 * Security invariants (plan §10):
 *  - Every route requires a logged-in user + a visible layer.
 *  - The SSE route does NOT accept a `model` field — body schema is
 *    `{ content: string }`. System-default model only.
 *  - Cross-layer message id → 404.
 *  - Retrieval still filters by `c.var.effectiveLayers` inside the
 *    orchestrator; the route is just the auth surface.
 *
 * Observability:
 *  - `chat.sse.opened_count` / `closed_count` / `aborted_count` /
 *    `failed_count` counters dimensioned by `{ layerId }`. No
 *    user-content labels.
 *  - Structured logs at SSE open / close / abort. Never logs message
 *    content beyond `bytes`.
 */

const BAD_REQUEST = { error: 'errors.chat.badRequest' } as const;
const NOT_VISIBLE = { error: 'errors.layer.notVisible' } as const;
const NOT_FOUND = { error: 'errors.chat.notFound' } as const;
const REASON_NOT_ALLOWED = { error: 'errors.chat.feedbackReasonNotAllowed' } as const;

const MAX_MESSAGE_BYTES = 8 * 1024; // 8 KB request body cap
const MAX_TITLE_LEN = 160;
const MAX_REASON_LEN = 2_000;

const CreateConversationBodySchema = z
  .object({
    title: z.string().min(1).max(MAX_TITLE_LEN).optional(),
    locale: z.string().min(2).max(16).optional(),
  })
  .strict();

const PostMessageBodySchema = z
  .object({
    content: z.string().min(1).max(MAX_MESSAGE_BYTES),
  })
  .strict();

const FeedbackBodySchema = z
  .object({
    value: ChatFeedbackValueSchema,
    reason: z.string().max(MAX_REASON_LEN).optional(),
  })
  .strict();

/**
 * Shape consumed by `apps/server/src/http/router.ts` when registering
 * the layer-chat routes. Mirrors the surface other layer-scoped
 * routes already use (`registerScheduledTasksRoutes`,
 * `registerLayersRoutes`).
 */
export interface LayerChatRouteDeps {
  readonly bus: MessageBus;
  readonly db: Database;
  readonly llm: LlmClient;
  readonly llmCallLog: LlmCallLog;
  readonly locales: LocalesConfig;
  /**
   * Resolves an `EntityStoreForRetrieval` per kind. The orchestrator
   * calls it inside the retrieval step. The lookup is process-wide
   * (entity modules register at boot) — the route only wires the
   * callback.
   */
  readonly getEntityStore: (kind: EntityKind) => EntityStoreForRetrieval | null;
  /** Override `now()` in tests. */
  readonly now?: () => Date;
  /**
   * Optional telemetry sink. Tests inject a capturing counters set
   * to assert the SSE counters fire; production wiring uses the
   * shared `counters` instance once a telemetry module ships.
   */
  readonly counters?: LayerChatCounters;
  /**
   * Phase 7.5 — per-layer capability registry. Threaded into
   * `runPipeline` so the answerer can inject activated skill
   * prompt-fragments. Optional: tests that don't care about
   * capabilities omit it and the answerer's prompt is byte-identical
   * to the phase-6 shape.
   */
  readonly capabilityRegistry?: import('../../proposals').CapabilityRegistry;
}

export interface LayerChatCounters {
  inc(name: string, by?: number, dims?: Readonly<Record<string, string>>): void;
  observeMs?(name: string, value: number, dims?: Readonly<Record<string, string>>): void;
}

const defaultCounters: LayerChatCounters = {
  inc: (): void => undefined,
  observeMs: (): void => undefined,
};

export function registerLayerChatRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: LayerChatRouteDeps,
): void {
  const requireLayer = createRequireLayer();
  const clock = deps.now ?? ((): Date => new Date());
  const counters = deps.counters ?? defaultCounters;

  const conversationsRepo = createChatConversationsRepo(deps.db);
  const messagesRepo = createChatMessagesRepo(deps.db);
  const runsRepo = createChatPipelineRunsRepo(deps.db);
  const stepsRepo = createChatPipelineStepsRepo(deps.db);
  const feedbackRepo = createChatMessageFeedbackRepo(deps.db);
  // Per-layer chat-model follow-up — the resolver consults
  // `layer_chat_settings.model` and falls back to the LLM client's
  // default. Built per-route mount so a `db` swap (tests) picks up
  // the fresh repo.
  const layerChatSettingsRepo = createLayerChatSettingsRepo(deps.db);
  const chatModelResolver = createChatModelResolver({
    settingsRepo: layerChatSettingsRepo,
    systemDefault: deps.llm.defaultModel,
  });

  // ---------- POST /l/:slug/chat/conversations ----------------------------

  app.post('/l/:slug/chat/conversations', requireLayer, async (c) => {
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);

    let body: unknown = {};
    const contentType = c.req.header('content-type') ?? '';
    if (contentType.includes('application/json')) {
      try {
        body = await c.req.json();
      } catch {
        // Permit empty bodies; only reject a malformed JSON
        // payload with explicit content-type.
        const len = c.req.header('content-length');
        if (len !== undefined && len !== '0') {
          return c.json(BAD_REQUEST, 400);
        }
      }
    }
    const parsed = CreateConversationBodySchema.safeParse(body);
    if (!parsed.success) return c.json(BAD_REQUEST, 400);

    const locale = parsed.data.locale ?? deps.locales.default;
    const title = parsed.data.title ?? 'New conversation';
    const id = crypto.randomUUID();
    const nowIso = clock().toISOString();
    const conv = conversationsRepo.insertConversation({
      id,
      layerId: layer.id,
      userId: user.id,
      title,
      locale,
      now: nowIso,
    });
    return c.json({ conversation: conv }, 201);
  });

  // ---------- GET /l/:slug/chat/conversations ----------------------------
  //
  // Phase 6.6 widened the response: each conversation row carries
  // aggregated `feedbackUpCount` / `feedbackDownCount` so the
  // `RecentChatsWidget` can render a ratio without N+1 fetches. The
  // base `ChatConversation` fields are unchanged — phase 6.5's
  // `LayerChatPage.tsx` reads only those and ignores the new fields.

  app.get('/l/:slug/chat/conversations', requireLayer, (c) => {
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const rows = conversationsRepo.listConversationSummaries({
      layerId: layer.id,
      userId: user.id,
    });
    return c.json({ conversations: rows });
  });

  // ---------- GET /l/:slug/chat/conversations/:id ------------------------

  app.get('/l/:slug/chat/conversations/:id', requireLayer, (c) => {
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const id = c.req.param('id');
    const conv = conversationsRepo.getConversationById(id);
    if (conv === null || !isOwnedAndVisible(conv, layer.id, user.id)) {
      return c.json(NOT_FOUND, 404);
    }
    return c.json({ conversation: conv });
  });

  // ---------- DELETE /l/:slug/chat/conversations/:id ---------------------

  app.delete('/l/:slug/chat/conversations/:id', requireLayer, (c) => {
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const id = c.req.param('id');
    const conv = conversationsRepo.getConversationById(id);
    if (conv === null || !isOwnedAndVisible(conv, layer.id, user.id)) {
      return c.json(NOT_FOUND, 404);
    }
    const nowIso = clock().toISOString();
    conversationsRepo.softDeleteConversation(id, user.id, nowIso);
    return c.json({ ok: true });
  });

  // ---------- GET /l/:slug/chat/conversations/:convId/messages/:msgId/trace
  //
  // Diagnostic surface: returns every pipeline run + step the
  // orchestrator persisted for `:msgId`, with each step's joined
  // `llm_calls` row (request + response + error) hanging off when
  // present. The renderer surfaces this collapsed under each assistant
  // bubble so a user can answer "why did this turn fail?" without
  // having to open SQLite. Owner-only: the conversation must belong to
  // `(layer.id, user.id)` exactly like the rest of `/l/:slug/chat/*`
  // — closed by the same `isOwnedAndVisible` helper.

  app.get('/l/:slug/chat/conversations/:convId/messages/:msgId/trace', requireLayer, (c) => {
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const convId = c.req.param('convId');
    const msgId = c.req.param('msgId');
    const conv = conversationsRepo.getConversationById(convId);
    if (conv === null || !isOwnedAndVisible(conv, layer.id, user.id)) {
      return c.json(NOT_FOUND, 404);
    }
    const msg = messagesRepo.getMessageById(msgId);
    if (msg === null || msg.conversationId !== convId) {
      return c.json(NOT_FOUND, 404);
    }
    const runs = runsRepo.listByMessage(msgId).map((run) => {
      const steps = stepsRepo.listByRun(run.id).map((step) => ({
        id: step.id,
        kind: step.kind,
        status: step.status,
        attempt: step.attempt,
        startedAt: step.startedAt,
        endedAt: step.endedAt,
        inputJson: step.inputJson,
        outputJson: step.outputJson,
        errorCode: step.errorCode,
        llmCall:
          step.llmCallId === null
            ? null
            : (() => {
                const row = deps.llmCallLog.getById(step.llmCallId);
                if (row === null) return null;
                return {
                  id: row.id,
                  startedAt: row.startedAt,
                  endedAt: row.endedAt,
                  model: row.model,
                  endpoint: row.endpoint,
                  request: row.request,
                  response: row.response,
                  tokensIn: row.tokensIn,
                  tokensOut: row.tokensOut,
                  costUsd: row.costUsd,
                  latencyMs: row.latencyMs,
                  error: row.error,
                  modelSource: row.modelSource,
                };
              })(),
      }));
      return {
        id: run.id,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        steps,
      };
    });
    return c.json({ messageId: msgId, runs });
  });

  // ---------- GET /l/:slug/chat/conversations/:id/messages ---------------

  app.get('/l/:slug/chat/conversations/:id/messages', requireLayer, (c) => {
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const id = c.req.param('id');
    const conv = conversationsRepo.getConversationById(id);
    if (conv === null || !isOwnedAndVisible(conv, layer.id, user.id)) {
      return c.json(NOT_FOUND, 404);
    }
    const messages = messagesRepo.listByConversation(id);
    return c.json({ messages });
  });

  // ---------- POST /l/:slug/chat/conversations/:id/messages --------------
  //
  // The streaming endpoint. We MUST pre-validate body + auth + layer
  // BEFORE handing off to `streamSSE`, because once the SSE response
  // is committed, returning a JSON error is no longer possible —
  // every failure inside the streaming callback has to surface as
  // `event: error`.

  app.post('/l/:slug/chat/conversations/:id/messages', requireLayer, async (c) => {
    const user = c.get('user');
    const layer = c.get('layer');
    const effective = c.get('effectiveLayers') ?? [];
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const conversationId = c.req.param('id');

    const conv = conversationsRepo.getConversationById(conversationId);
    if (conv === null || !isOwnedAndVisible(conv, layer.id, user.id)) {
      return c.json(NOT_FOUND, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(BAD_REQUEST, 400);
    }
    const parsed = PostMessageBodySchema.safeParse(body);
    if (!parsed.success) return c.json(BAD_REQUEST, 400);

    // Pre-insert the user `chat_messages` row BEFORE opening the
    // stream. The orchestrator (per the 6.3 handoff) expects the
    // user row already exists; it inserts the assistant placeholder
    // and drives it to a terminal state.
    const correlationId = crypto.randomUUID();
    const flowId = conv.id;
    const nowIso = clock().toISOString();
    const userMessage = messagesRepo.insertMessage({
      id: crypto.randomUUID(),
      conversationId,
      role: 'user',
      content: parsed.data.content,
      status: 'done',
      correlationId,
      flowId,
      now: nowIso,
    });
    conversationsRepo.touchConversation(conversationId, nowIso);

    counters.inc('chat.sse.opened_count', 1, { layerId: layer.id });
    const sseStartedAt = Date.now();
    console.log('[chat.sse] open', {
      conversationId,
      userMessageId: userMessage.id,
      userId: user.id,
      layerId: layer.id,
      bytes: parsed.data.content.length,
      correlationId,
    });

    return streamSSE(
      c,
      async (stream) => {
        const abortController = new AbortController();
        stream.onAbort(() => {
          abortController.abort(new Error('client_disconnect'));
        });

        // Phase 6.4 — chunk sink writes one `event: token` per
        // answerer delta. Step callback writes `event: step` per
        // pipeline transition. Both are best-effort: a write
        // failure cancels the in-flight LLM call via the abort
        // controller.
        const writeStep = (event: PipelineStepEvent): void => {
          void safeSseWrite(stream, {
            event: 'step',
            data: JSON.stringify({
              stepKind: event.kind,
              status: event.status,
              attempt: event.attempt,
              ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
              ...(event.errorCode !== undefined ? { errorCode: event.errorCode } : {}),
            }),
          });
        };
        const writeToken = (chunk: { delta: string }): void => {
          void safeSseWrite(stream, {
            event: 'token',
            data: JSON.stringify({ delta: chunk.delta }),
          });
        };

        let result: Awaited<ReturnType<typeof runPipeline>> | null = null;
        let pipelineError: unknown = null;
        try {
          result = await runPipeline(
            {
              conversationId,
              userMessageId: userMessage.id,
              userContent: parsed.data.content,
              layerId: layer.id,
              effectiveLayerIds: effective.map((l) => l.id),
              userId: user.id,
              correlationId,
              flowId,
            },
            {
              db: deps.db,
              bus: deps.bus,
              llm: deps.llm,
              llmCallLog: deps.llmCallLog,
              conversationsRepo,
              messagesRepo,
              runsRepo,
              stepsRepo,
              getEntityStore: deps.getEntityStore,
              chunkSink: writeToken,
              abortSignal: abortController.signal,
              onStepEvent: writeStep,
              chatModelResolver,
              ...(deps.now !== undefined ? { clock: deps.now } : {}),
              ...(deps.capabilityRegistry !== undefined
                ? { capabilityRegistry: deps.capabilityRegistry }
                : {}),
            },
          );
        } catch (err) {
          pipelineError = err;
        }

        const durationMs = Date.now() - sseStartedAt;
        if (counters.observeMs !== undefined) {
          counters.observeMs('chat.sse.request_duration_ms', durationMs, { layerId: layer.id });
        }

        if (result !== null && result.status === 'done') {
          await safeSseWrite(stream, {
            event: 'done',
            data: JSON.stringify({
              messageId: result.assistantMessageId,
              status: 'done',
            }),
          });
          counters.inc('chat.sse.closed_count', 1, { layerId: layer.id, status: 'done' });
          console.log('[chat.sse] close', {
            conversationId,
            assistantMessageId: result.assistantMessageId,
            durationMs,
            status: 'done',
          });
        } else if (result !== null && result.aborted === true) {
          await safeSseWrite(stream, {
            event: 'error',
            data: JSON.stringify({
              errorCode: result.errorCode ?? 'answer_aborted',
              message: 'errors.chat.streamAborted',
              messageId: result.assistantMessageId,
            }),
          });
          counters.inc('chat.sse.aborted_count', 1, { layerId: layer.id });
          console.log('[chat.sse] abort', {
            conversationId,
            assistantMessageId: result.assistantMessageId,
            durationMs,
          });
        } else if (result !== null) {
          await safeSseWrite(stream, {
            event: 'error',
            data: JSON.stringify({
              errorCode: result.errorCode ?? 'pipeline_failed',
              message: 'errors.chat.upstream',
              messageId: result.assistantMessageId,
            }),
          });
          counters.inc('chat.sse.failed_count', 1, {
            layerId: layer.id,
            errorCode: result.errorCode ?? 'pipeline_failed',
          });
          console.log('[chat.sse] failed', {
            conversationId,
            assistantMessageId: result.assistantMessageId,
            durationMs,
            errorCode: result.errorCode,
          });
        } else {
          // Pipeline threw — `runPipeline` is supposed to swallow
          // and return a terminal result, so this is exceptional.
          await safeSseWrite(stream, {
            event: 'error',
            data: JSON.stringify({
              errorCode: 'pipeline_crashed',
              message: 'errors.chat.upstream',
            }),
          });
          counters.inc('chat.sse.failed_count', 1, {
            layerId: layer.id,
            errorCode: 'pipeline_crashed',
          });
          console.error('[chat.sse] pipeline crashed', {
            conversationId,
            error: pipelineError instanceof Error ? pipelineError.message : String(pipelineError),
          });
        }
      },
      async (err, stream) => {
        // Outer error handler — fires when the streamSSE callback
        // itself throws. Best-effort error frame, then close.
        try {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({
              errorCode: 'sse_writer_failed',
              message: 'errors.chat.upstream',
            }),
          });
        } catch {
          /* the writer is already dead — nothing to do */
        }
        counters.inc('chat.sse.failed_count', 1, {
          layerId: layer.id,
          errorCode: 'sse_writer_failed',
        });
        console.error('[chat.sse] writer error', {
          conversationId,
          message: err.message,
        });
      },
    );
  });

  // ---------- GET /l/:slug/chat/board ------------------------------------
  //
  // Phase 6.6 — Kanban board data. Returns the last N assistant
  // messages across the caller's conversations in this layer with
  // a small snapshot of their pipeline state. Server returns raw
  // run + step snapshots; client buckets into Kanban columns. The
  // sort is newest-first by message `created_at`.
  //
  // Filter rules:
  //  - `c.var.effectiveLayers` boundary (mirrors every other
  //    layer-scoped route): non-members of this layer hit the
  //    `requireLayer` middleware and never reach this handler.
  //  - Only `role = 'assistant'` messages are returned. User
  //    messages have no pipeline run and would land in the
  //    "queued" column permanently.
  //  - Soft-deleted conversations are skipped.
  //  - Cap at 200; clamp the `limit` query.

  app.get('/l/:slug/chat/board', requireLayer, (c) => {
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const limitRaw = c.req.query('limit');
    let limit = 50;
    if (limitRaw !== undefined) {
      const parsed = Number.parseInt(limitRaw, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.min(parsed, 200);
      }
    }
    const items = listBoardItemsFor(deps.db, layer.id, user.id, limit);
    return c.json({ items });
  });

  // ---------- POST /l/:slug/chat/messages/:id/feedback -------------------

  app.post('/l/:slug/chat/messages/:id/feedback', requireLayer, async (c) => {
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const messageId = c.req.param('id');

    const message = messagesRepo.getMessageById(messageId);
    if (message === null) return c.json(NOT_FOUND, 404);
    const conv = conversationsRepo.getConversationById(message.conversationId);
    if (conv === null || !isOwnedAndVisible(conv, layer.id, user.id)) {
      return c.json(NOT_FOUND, 404);
    }
    if (message.role !== 'assistant') {
      return c.json(BAD_REQUEST, 400);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(BAD_REQUEST, 400);
    }
    const parsed = FeedbackBodySchema.safeParse(body);
    if (!parsed.success) return c.json(BAD_REQUEST, 400);

    if (parsed.data.value === 'up' && parsed.data.reason !== undefined) {
      return c.json(REASON_NOT_ALLOWED, 400);
    }

    const id = crypto.randomUUID();
    const nowIso = clock().toISOString();
    const stored = feedbackRepo.upsertFeedback({
      id,
      messageId,
      userId: user.id,
      value: parsed.data.value,
      ...(parsed.data.value === 'down' && parsed.data.reason !== undefined
        ? { reason: parsed.data.reason }
        : {}),
      now: nowIso,
    });
    return c.json({ feedback: stored }, 201);
  });

  // ---------- POST /l/:slug/chat/conversations/:id/regenerate-title ------
  //
  // Auto-summary follow-up — any conversation member can force a
  // title rewrite. Re-uses the same `summarizeConversation` core as
  // the event subscriber and the daily sweep; `force: true` bypasses
  // the every-six-messages gate so users can re-summarize at any
  // time after the first turn.
  app.post('/l/:slug/chat/conversations/:id/regenerate-title', requireLayer, async (c) => {
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const id = c.req.param('id');
    const conv = conversationsRepo.getConversationById(id);
    if (conv === null || !isOwnedAndVisible(conv, layer.id, user.id)) {
      return c.json(NOT_FOUND, 404);
    }
    const outcome = await summarizeConversation(
      id,
      {
        db: deps.db,
        llm: deps.llm,
        conversationsRepo,
        messagesRepo,
      },
      { force: true },
    );
    console.log('[chat.regenerate-title]', {
      event: 'chat.regenerate-title',
      conversationId: id,
      layerId: layer.id,
      userId: user.id,
      outcomeStatus: outcome.status,
    });
    if (outcome.status === 'updated') {
      const refreshed = conversationsRepo.getConversationById(id);
      return c.json({ conversation: refreshed }, 200);
    }
    // The handler logs its own warning; surface a stable 502 with
    // the same `errors.chat.upstream` key the SSE error path uses.
    return c.json({ error: 'errors.chat.upstream' }, 502);
  });
}

interface OwnableConversation {
  readonly layerId: string;
  readonly userId: string;
  readonly deletedAt: string | null;
}

function isOwnedAndVisible(conv: OwnableConversation, layerId: string, userId: string): boolean {
  if (conv.deletedAt !== null) return false;
  return conv.layerId === layerId && conv.userId === userId;
}

const BOARD_CONTENT_PREVIEW_BYTES = 280;

interface BoardMessageRow {
  message_id: string;
  conversation_id: string;
  conversation_title: string;
  role: ChatMessageRole;
  status: ChatMessageStatus;
  content: string;
  created_at: string;
  finished_at: string | null;
  run_id: string | null;
  run_status: PipelineRunStatus | null;
}

interface BoardStepRow {
  run_id: string;
  kind: PipelineStepKind;
  status: PipelineStepStatus;
  attempt: number;
  started_at: string;
  attribution_json: string | null;
}

/**
 * Phase 6.6 — load the board snapshot for one (layer, user) pair.
 *
 * Returns the most-recent `limit` assistant messages across the
 * user's non-deleted conversations in this layer, each with their
 * latest pipeline run + step snapshot. Two queries: one for
 * messages + runs, one for steps. Joined client-side in this
 * function to avoid emitting one row per step. Sort is newest-first
 * by `chat_messages.created_at`.
 *
 * Auth is enforced upstream by `requireLayer` + the `layer_id` /
 * `user_id` filter below — non-members never reach this code.
 */
function listBoardItemsFor(
  db: Database,
  layerId: string,
  userId: string,
  limit: number,
): readonly ChatBoardItem[] {
  // Subquery picks the latest run per message (a v1 design assumes
  // 1:1 messages↔runs; the LEFT JOIN handles "no run yet" messages
  // gracefully). The MAX(started_at) trick keeps the SQL ANSI-ish.
  const messageRowsSql = `
    SELECT
      m.id            AS message_id,
      m.conversation_id AS conversation_id,
      c.title         AS conversation_title,
      m.role          AS role,
      m.status        AS status,
      m.content       AS content,
      m.created_at    AS created_at,
      m.finished_at   AS finished_at,
      r.id            AS run_id,
      r.status        AS run_status
      FROM chat_messages m
      JOIN chat_conversations c ON c.id = m.conversation_id
      LEFT JOIN chat_pipeline_runs r
        ON r.message_id = m.id
       AND r.started_at = (
         SELECT MAX(r2.started_at)
           FROM chat_pipeline_runs r2
          WHERE r2.message_id = m.id
       )
     WHERE c.layer_id = ?
       AND c.user_id = ?
       AND c.deleted_at IS NULL
       AND m.role = 'assistant'
     ORDER BY m.created_at DESC
     LIMIT ?
  `;
  const messageRows = db
    .query<BoardMessageRow, [string, string, number]>(messageRowsSql)
    .all(layerId, userId, limit);

  if (messageRows.length === 0) return [];

  const runIds = messageRows.map((r) => r.run_id).filter((x): x is string => x !== null);
  const stepsByRun = new Map<string, ChatBoardStepSnapshot[]>();
  if (runIds.length > 0) {
    const placeholders = runIds.map(() => '?').join(', ');
    const stepRowsSql = `
      SELECT run_id, kind, status, attempt, started_at, attribution_json
        FROM chat_pipeline_steps
       WHERE run_id IN (${placeholders})
       ORDER BY started_at ASC
    `;
    const stepRows = db.query<BoardStepRow, string[]>(stepRowsSql).all(...runIds);
    for (const row of stepRows) {
      let arr = stepsByRun.get(row.run_id);
      if (arr === undefined) {
        arr = [];
        stepsByRun.set(row.run_id, arr);
      }
      // Phase 7.6 — surface capability attribution on the answer step.
      // The column is nullable; defensively swallow JSON parse errors
      // so a malformed write never breaks the Kanban payload.
      let attribution: ChatBoardStepSnapshot['attribution'] = null;
      if (row.attribution_json !== null) {
        try {
          attribution = JSON.parse(row.attribution_json);
        } catch {
          attribution = null;
        }
      }
      arr.push({ kind: row.kind, status: row.status, attribution });
    }
  }

  return messageRows.map((row): ChatBoardItem => {
    const preview =
      row.content.length > BOARD_CONTENT_PREVIEW_BYTES
        ? `${row.content.slice(0, BOARD_CONTENT_PREVIEW_BYTES)}…`
        : row.content;
    return {
      messageId: row.message_id,
      conversationId: row.conversation_id,
      conversationTitle: row.conversation_title,
      role: row.role,
      status: row.status,
      contentPreview: preview,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
      run:
        row.run_id !== null && row.run_status !== null
          ? { id: row.run_id, status: row.run_status }
          : null,
      steps: stepsByRun.get(row.run_id ?? '') ?? [],
    };
  });
}

/**
 * Wrap `stream.writeSSE` so a closed/aborted writer doesn't escape
 * into the orchestrator's promise chain. The orchestrator already
 * owns its own error path; a writer that's gone away just means the
 * remaining frames are best-effort.
 */
async function safeSseWrite(
  stream: SSEStreamingApi,
  message: { event: string; data: string },
): Promise<void> {
  if (stream.closed || stream.aborted) return;
  try {
    await stream.writeSSE(message);
  } catch {
    /* writer is dead — drop the frame */
  }
}
