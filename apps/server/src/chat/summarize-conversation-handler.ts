/**
 * `chat.summarize-conversation` scheduled-task handler.
 *
 * Daily sweep that catches conversations the event-based subscriber
 * missed (e.g. server restart between message-6 and the handler).
 * The per-conversation logic lives in `summarizeConversation`; this
 * file is the registration boilerplate that wires the handler to the
 * scheduled-tasks subsystem.
 */

import type { ScheduledTaskHandler, ScheduledTaskRunContext } from '../scheduled';
import {
  CHAT_SUMMARIZE_CONVERSATION_KIND,
  listConversationIdsForSweep,
  summarizeConversation,
} from './summarize-conversation';
import { createChatConversationsRepo } from './repos/chat-conversations-repo';
import { createChatMessagesRepo } from './repos/chat-messages-repo';

const DEFAULT_INTERVAL_MINUTES = 60 * 24;

export const chatSummarizeConversationHandler: ScheduledTaskHandler = {
  kind: CHAT_SUMMARIZE_CONVERSATION_KIND,
  defaultSchedule: { kind: 'interval', intervalMinutes: DEFAULT_INTERVAL_MINUTES },
  async run(ctx: ScheduledTaskRunContext): Promise<void> {
    const conversationIds = listConversationIdsForSweep(ctx.db);
    if (conversationIds.length === 0) {
      ctx.logger.info('summarize sweep: no eligible conversations', {
        event: 'chat.summarize.sweep.empty',
      });
      return;
    }
    const deps = {
      db: ctx.db,
      llm: ctx.llm,
      conversationsRepo: createChatConversationsRepo(ctx.db),
      messagesRepo: createChatMessagesRepo(ctx.db),
      logger: ctx.logger,
      // The ctx.now is a `() => string`; the handler expects a Date.
      clock: (): Date => new Date(ctx.now()),
    };
    let updated = 0;
    let failed = 0;
    let skipped = 0;
    for (const conversationId of conversationIds) {
      const outcome = await summarizeConversation(conversationId, deps);
      if (outcome.status === 'updated') {
        updated += 1;
      } else if (outcome.status === 'failed') {
        failed += 1;
      } else {
        skipped += 1;
      }
    }
    ctx.logger.info('summarize sweep complete', {
      event: 'chat.summarize.sweep.complete',
      total: conversationIds.length,
      updated,
      failed,
      skipped,
    });
  },
};
