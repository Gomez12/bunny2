/**
 * Per-message subscriber on `chat.message.answered`.
 *
 * Fires `summarizeConversation` inline when the eligibility gate
 * is met (every 6th message after the first 6). Idempotent thanks
 * to the `last_summarized_message_count` watermark — re-deliveries
 * (durable bus replay on boot) are harmless.
 *
 * Production wiring (`apps/server/src/index.ts`) calls
 * `start()` AFTER the chat module + LLM client are ready; tests
 * subscribe directly against an in-memory bus.
 */

import type { MessageBus, Unsubscribe } from '@bunny2/bus';
import type { Database } from 'bun:sqlite';
import type { LlmClient } from '../llm/types';
import { type ChatMessageAnsweredPayload } from './events';
import {
  shouldEnqueueSummarize,
  summarizeConversation,
  type SummarizeCounters,
  type SummarizeLogger,
} from './summarize-conversation';
import { createChatConversationsRepo } from './repos/chat-conversations-repo';
import { createChatMessagesRepo } from './repos/chat-messages-repo';

export interface SummarizeConversationSubscriberDeps {
  readonly bus: MessageBus;
  readonly db: Database;
  readonly llm: LlmClient;
  readonly logger?: SummarizeLogger;
  readonly counters?: SummarizeCounters;
}

export interface SummarizeConversationSubscriber {
  start(): void;
  stop(): void;
}

export function createSummarizeConversationSubscriber(
  deps: SummarizeConversationSubscriberDeps,
): SummarizeConversationSubscriber {
  let unsub: Unsubscribe | null = null;
  const conversationsRepo = createChatConversationsRepo(deps.db);
  const messagesRepo = createChatMessagesRepo(deps.db);

  return {
    start(): void {
      if (unsub !== null) return;
      unsub = deps.bus.subscribe<ChatMessageAnsweredPayload>(
        'chat.message.answered',
        async (event) => {
          const conversationId = event.payload.conversationId;
          const conv = conversationsRepo.getConversationById(conversationId);
          if (conv === null || conv.deletedAt !== null) return;
          const count = messagesRepo.listByConversation(conversationId).length;
          if (!shouldEnqueueSummarize(count, conv.lastSummarizedMessageCount)) return;
          await summarizeConversation(conversationId, {
            db: deps.db,
            llm: deps.llm,
            conversationsRepo,
            messagesRepo,
            ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
            ...(deps.counters !== undefined ? { counters: deps.counters } : {}),
          });
        },
        { idempotent: true },
      );
    },
    stop(): void {
      if (unsub !== null) {
        try {
          unsub();
        } catch {
          /* shutdown noise — not actionable */
        }
        unsub = null;
      }
    },
  };
}
