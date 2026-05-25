/**
 * `chat.summarize-conversation` — auto-generate stable conversation titles.
 *
 * Three trigger paths share the same core function:
 *  1. Event subscriber on `chat.message.answered` checks the gate
 *     (`messageCount >= 6 AND messageCount % 6 === 0 AND
 *     last_summarized_message_count < messageCount`) and runs the
 *     handler inline.
 *  2. Daily scheduled task (kind `chat.summarize-conversation`)
 *     sweeps every conversation that meets the same gate and runs
 *     the handler — catches threads missed by the event path.
 *  3. Manual `POST /l/:slug/chat/conversations/:id/regenerate-title`
 *     unconditionally runs the handler (admin / member action).
 *
 * The handler is idempotent: re-running for the same `messageCount`
 * is a no-op because `last_summarized_message_count` is bumped on
 * success.
 *
 * Failure handling (plan §"Failure handling"):
 *  - LLM error → leave the existing title alone, log a warning,
 *    increment `chat.summarize.failed`. Do NOT retry in-handler;
 *    the next 6-message gate or the daily sweep retries.
 *  - Empty title → same as LLM error.
 *
 * Privacy: the LLM sees the last 10 messages (truncated by the
 * orchestrator's normal flow); we never log message content.
 */

import type { Database } from 'bun:sqlite';
import type { LlmClient } from '../llm/types';
import type { ChatConversationsRepo } from './repos/chat-conversations-repo';
import type { ChatMessagesRepo } from './repos/chat-messages-repo';

export const CHAT_SUMMARIZE_CONVERSATION_KIND = 'chat.summarize-conversation';

const SUMMARIZE_GATE_INTERVAL = 6;
const MAX_TITLE_LEN = 60;
const HISTORY_TURN_CAP = 10;

const SYSTEM_PROMPT =
  'Generate a short conversation title (max 60 characters, no quotes, ' +
  'no trailing period). Respond with only the title text.';

export interface SummarizeConversationDeps {
  readonly db: Database;
  readonly llm: LlmClient;
  readonly conversationsRepo: ChatConversationsRepo;
  readonly messagesRepo: ChatMessagesRepo;
  readonly logger?: SummarizeLogger;
  readonly counters?: SummarizeCounters;
  readonly clock?: () => Date;
}

export interface SummarizeLogger {
  info(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  error(msg: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface SummarizeCounters {
  inc(name: string, by?: number, dims?: Readonly<Record<string, string>>): void;
  observeMs?(name: string, value: number, dims?: Readonly<Record<string, string>>): void;
}

const defaultLogger: SummarizeLogger = {
  info: (msg, fields) => console.log(`[chat.summarize] ${msg}`, fields ?? {}),
  warn: (msg, fields) => console.warn(`[chat.summarize] ${msg}`, fields ?? {}),
  error: (msg, fields) => console.error(`[chat.summarize] ${msg}`, fields ?? {}),
};

const noopCounters: SummarizeCounters = { inc: () => undefined };

export type SummarizeOutcome =
  | { readonly status: 'updated'; readonly title: string; readonly messageCount: number }
  | { readonly status: 'skipped_not_eligible'; readonly reason: 'no-conversation' | 'already-summarized' | 'too-few-messages' }
  | { readonly status: 'failed'; readonly reason: 'empty-title' | 'llm-error' };

export interface SummarizeOpts {
  /** Forces the run even when the eligibility gate would skip. */
  readonly force?: boolean;
}

/**
 * Drive the summarize handler for one conversation. Returns the
 * outcome so the caller (subscriber, scheduled task, manual route)
 * can decide what to log / count.
 */
export async function summarizeConversation(
  conversationId: string,
  deps: SummarizeConversationDeps,
  opts: SummarizeOpts = {},
): Promise<SummarizeOutcome> {
  const logger = deps.logger ?? defaultLogger;
  const counters = deps.counters ?? noopCounters;
  const startMs = (deps.clock ?? ((): Date => new Date()))().getTime();

  const conv = deps.conversationsRepo.getConversationById(conversationId);
  if (conv === null || conv.deletedAt !== null) {
    return { status: 'skipped_not_eligible', reason: 'no-conversation' };
  }
  const messages = deps.messagesRepo.listByConversation(conversationId);
  const messageCount = messages.length;
  if (!opts.force) {
    if (messageCount < SUMMARIZE_GATE_INTERVAL) {
      return { status: 'skipped_not_eligible', reason: 'too-few-messages' };
    }
    if (conv.lastSummarizedMessageCount !== null && conv.lastSummarizedMessageCount >= messageCount) {
      return { status: 'skipped_not_eligible', reason: 'already-summarized' };
    }
  }

  // Take the last N messages as the LLM prompt. We strip raw role
  // markers + content; nothing else crosses the boundary.
  const tail = messages.slice(-HISTORY_TURN_CAP);
  const userPrompt = tail.map((m) => `${m.role}: ${m.content}`).join('\n');

  let title: string;
  try {
    const res = await deps.llm.chat({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      metadata: {
        flowId: `chat.summarize:${conv.id}`,
        layerId: conv.layerId,
        userId: conv.userId,
        step: 'summarize-conversation',
      },
    });
    title = sanitizeTitle(res.content);
  } catch (err) {
    counters.inc('chat.summarize.failed', 1, { reason: 'llm-error' });
    logger.warn('summarize failed', {
      event: 'chat.summarize.failed',
      conversationId,
      layerId: conv.layerId,
      reason: 'llm-error',
      // No raw message content — only the bounded error string.
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: 'failed', reason: 'llm-error' };
  }

  if (title.length === 0) {
    counters.inc('chat.summarize.failed', 1, { reason: 'empty-title' });
    logger.warn('summarize produced empty title', {
      event: 'chat.summarize.failed',
      conversationId,
      layerId: conv.layerId,
      reason: 'empty-title',
    });
    return { status: 'failed', reason: 'empty-title' };
  }

  deps.conversationsRepo.setTitleAndSummaryCount(conv.id, title, messageCount);
  const durationMs = (deps.clock ?? ((): Date => new Date()))().getTime() - startMs;
  counters.inc('chat.summarize.completed', 1);
  if (counters.observeMs !== undefined) {
    counters.observeMs('chat.summarize.duration_ms', durationMs);
  }
  logger.info('summarize completed', {
    event: 'chat.summarize.completed',
    conversationId,
    layerId: conv.layerId,
    messageCount,
    durationMs,
    // Title length only — no body in counter dimensions.
    titleLen: title.length,
  });
  return { status: 'updated', title, messageCount };
}

/**
 * Clip + scrub the LLM's reply. The prompt asks for a quote-free,
 * period-free title up to 60 characters; this trims wrapping
 * whitespace + matching quotes + a single trailing period, then
 * truncates defensively in case the model ignored the cap.
 */
export function sanitizeTitle(raw: string): string {
  let s = raw.trim();
  // Strip a single matched pair of wrapping quotes.
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'")) ||
      (s.startsWith('“') && s.endsWith('”')))
  ) {
    s = s.slice(1, -1).trim();
  }
  // Drop a trailing period (single).
  if (s.endsWith('.') && !s.endsWith('..')) {
    s = s.slice(0, -1).trim();
  }
  // Collapse newlines to a single space; titles must be one line.
  s = s.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ');
  if (s.length > MAX_TITLE_LEN) {
    s = s.slice(0, MAX_TITLE_LEN).trim();
  }
  return s;
}

/**
 * Returns the closed-form eligibility gate: `true` when the
 * subscriber should enqueue (`messageCount >= 6 AND messageCount % 6
 * === 0 AND last_summarized_message_count < messageCount`).
 */
export function shouldEnqueueSummarize(
  messageCount: number,
  lastSummarizedMessageCount: number | null,
): boolean {
  if (messageCount < SUMMARIZE_GATE_INTERVAL) return false;
  if (messageCount % SUMMARIZE_GATE_INTERVAL !== 0) return false;
  if (lastSummarizedMessageCount !== null && lastSummarizedMessageCount >= messageCount) {
    return false;
  }
  return true;
}

/**
 * Daily sweep — returns every conversation id that the handler
 * should re-evaluate. The handler itself re-checks the gate per
 * conversation, so a small race (a new message landing between the
 * sweep query and the handler call) is harmless.
 */
export function listConversationIdsForSweep(db: Database): readonly string[] {
  // The gate is implemented in TS, but we narrow the candidate set
  // in SQL: only threads with >= 6 messages AND (never summarized
  // OR summarized at a stale count). This avoids scanning every
  // single conversation when most threads stay short.
  type Row = { conversation_id: string };
  const sql = `
    SELECT c.id AS conversation_id
      FROM chat_conversations c
      JOIN (
        SELECT conversation_id, COUNT(*) AS n
          FROM chat_messages
         GROUP BY conversation_id
      ) m ON m.conversation_id = c.id
     WHERE c.deleted_at IS NULL
       AND m.n >= 6
       AND m.n % 6 = 0
       AND (
         c.last_summarized_message_count IS NULL
         OR c.last_summarized_message_count < m.n
       )
  `;
  const rows = db.query<Row, []>(sql).all();
  return rows.map((r) => r.conversation_id);
}
