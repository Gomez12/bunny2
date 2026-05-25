/**
 * `chat.summarize-conversation` handler + subscriber unit tests.
 *
 * Covers:
 *   - `sanitizeTitle` strips quotes, trailing period, newlines, and
 *     truncates at 60 chars.
 *   - `shouldEnqueueSummarize` enumerates the gate exactly.
 *   - `summarizeConversation` writes the title + bumps
 *     `last_summarized_message_count` on success.
 *   - Empty LLM reply → no-op, increments `chat.summarize.failed`.
 *   - LLM throw → no-op, increments `chat.summarize.failed`.
 *   - Subscriber enqueues at message 6 / 12, NOT at 1-5 or 7-11.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import { openDatabase } from '../src/storage/sqlite';
import { createUsersRepo } from '../src/repos/users-repo';
import { createLayersRepo } from '../src/repos/layers-repo';
import { createChatConversationsRepo } from '../src/chat/repos/chat-conversations-repo';
import { createChatMessagesRepo } from '../src/chat/repos/chat-messages-repo';
import { createSummarizeConversationSubscriber } from '../src/chat/summarize-conversation-subscriber';
import {
  sanitizeTitle,
  shouldEnqueueSummarize,
  summarizeConversation,
} from '../src/chat/summarize-conversation';
import type { LlmClient } from '../src/llm/types';
import type { ChatMessageAnsweredPayload } from '../src/chat/events';

const now = (): string => new Date().toISOString();

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly userId: string;
  readonly layerId: string;
}

function mkFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-chat-summarize-'));
  const db = openDatabase(dir);
  const user = createUsersRepo(db).createUser({
    id: crypto.randomUUID(),
    username: 'alice',
    displayName: 'Alice',
    passwordHash: 'h',
    mustChangePassword: false,
    now: now(),
  });
  const layer = createLayersRepo(db).insertLayer({
    id: crypto.randomUUID(),
    type: 'everyone',
    slug: 'everyone',
    name: 'Everyone',
    now: now(),
  });
  return { dir, db, userId: user.id, layerId: layer.id };
}

function close(fx: Fixture): void {
  fx.db.close();
  try {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function seedConversation(fx: Fixture, title = 'Untitled'): string {
  const conv = createChatConversationsRepo(fx.db).insertConversation({
    id: crypto.randomUUID(),
    layerId: fx.layerId,
    userId: fx.userId,
    title,
    locale: 'en',
    now: now(),
  });
  return conv.id;
}

function pushMessage(fx: Fixture, conversationId: string, role: 'user' | 'assistant'): void {
  createChatMessagesRepo(fx.db).insertMessage({
    id: crypto.randomUUID(),
    conversationId,
    role,
    content: 'lorem ipsum',
    status: 'done',
    correlationId: crypto.randomUUID(),
    flowId: conversationId,
    now: now(),
  });
}

function fakeLlm(replyContent: string, throwOnCall = false): LlmClient {
  return {
    endpoint: 'mock://test',
    defaultModel: 'mock',
    async chat() {
      if (throwOnCall) {
        throw new Error('boom');
      }
      return {
        id: 'r',
        model: 'mock',
        content: replyContent,
        tokensIn: 1,
        tokensOut: 1,
        raw: null,
      };
    },
  };
}

describe('sanitizeTitle', () => {
  it('strips wrapping quotes and trailing periods', () => {
    expect(sanitizeTitle('"Quick chat about Acme strategy."')).toBe(
      'Quick chat about Acme strategy',
    );
    expect(sanitizeTitle("'Hello'")).toBe('Hello');
  });

  it('collapses newlines and trims to 60 characters', () => {
    const long = 'A'.repeat(80);
    expect(sanitizeTitle(long).length).toBe(60);
    expect(sanitizeTitle('line1\nline2  line3')).toBe('line1 line2 line3');
  });
});

describe('shouldEnqueueSummarize', () => {
  it('returns true at message 6 / 12 / 18 and false in between', () => {
    expect(shouldEnqueueSummarize(0, null)).toBe(false);
    expect(shouldEnqueueSummarize(5, null)).toBe(false);
    expect(shouldEnqueueSummarize(6, null)).toBe(true);
    expect(shouldEnqueueSummarize(7, null)).toBe(false);
    expect(shouldEnqueueSummarize(11, null)).toBe(false);
    expect(shouldEnqueueSummarize(12, null)).toBe(true);
    expect(shouldEnqueueSummarize(18, null)).toBe(true);
  });

  it('returns false when last_summarized_message_count is already at the current count', () => {
    expect(shouldEnqueueSummarize(12, 12)).toBe(false);
    expect(shouldEnqueueSummarize(12, 6)).toBe(true);
    expect(shouldEnqueueSummarize(12, 18)).toBe(false);
  });
});

describe('summarizeConversation', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = mkFixture();
  });
  afterEach(() => {
    close(fx);
  });

  it('happy path writes the title and bumps the watermark', async () => {
    const conversationId = seedConversation(fx, 'Untitled');
    for (let i = 0; i < 6; i += 1) {
      pushMessage(fx, conversationId, i % 2 === 0 ? 'user' : 'assistant');
    }
    const outcome = await summarizeConversation(conversationId, {
      db: fx.db,
      llm: fakeLlm('Acme strategy chat'),
      conversationsRepo: createChatConversationsRepo(fx.db),
      messagesRepo: createChatMessagesRepo(fx.db),
    });
    expect(outcome.status).toBe('updated');
    const conv = createChatConversationsRepo(fx.db).getConversationById(conversationId);
    expect(conv?.title).toBe('Acme strategy chat');
    expect(conv?.lastSummarizedMessageCount).toBe(6);
  });

  it('skips when last_summarized_message_count is already at the current count', async () => {
    const conversationId = seedConversation(fx, 'Pinned');
    for (let i = 0; i < 6; i += 1) {
      pushMessage(fx, conversationId, 'user');
    }
    createChatConversationsRepo(fx.db).setTitleAndSummaryCount(conversationId, 'Pinned', 6);
    const outcome = await summarizeConversation(conversationId, {
      db: fx.db,
      llm: fakeLlm('Should not be used'),
      conversationsRepo: createChatConversationsRepo(fx.db),
      messagesRepo: createChatMessagesRepo(fx.db),
    });
    expect(outcome.status).toBe('skipped_not_eligible');
  });

  it('keeps the existing title when the LLM returns empty content', async () => {
    const conversationId = seedConversation(fx, 'Original');
    for (let i = 0; i < 6; i += 1) {
      pushMessage(fx, conversationId, 'user');
    }
    const counters = {
      ticks: new Map<string, number>(),
      inc(name: string, by = 1): void {
        counters.ticks.set(name, (counters.ticks.get(name) ?? 0) + by);
      },
    };
    const outcome = await summarizeConversation(conversationId, {
      db: fx.db,
      llm: fakeLlm('   '),
      conversationsRepo: createChatConversationsRepo(fx.db),
      messagesRepo: createChatMessagesRepo(fx.db),
      counters,
    });
    expect(outcome.status).toBe('failed');
    expect(counters.ticks.get('chat.summarize.failed')).toBe(1);
    const conv = createChatConversationsRepo(fx.db).getConversationById(conversationId);
    expect(conv?.title).toBe('Original');
    expect(conv?.lastSummarizedMessageCount).toBeNull();
  });

  it('keeps the existing title when the LLM throws', async () => {
    const conversationId = seedConversation(fx, 'Original');
    for (let i = 0; i < 6; i += 1) {
      pushMessage(fx, conversationId, 'user');
    }
    const counters = {
      ticks: new Map<string, number>(),
      inc(name: string, by = 1): void {
        counters.ticks.set(name, (counters.ticks.get(name) ?? 0) + by);
      },
    };
    const outcome = await summarizeConversation(conversationId, {
      db: fx.db,
      llm: fakeLlm('', true),
      conversationsRepo: createChatConversationsRepo(fx.db),
      messagesRepo: createChatMessagesRepo(fx.db),
      counters,
    });
    expect(outcome.status).toBe('failed');
    expect(counters.ticks.get('chat.summarize.failed')).toBe(1);
    const conv = createChatConversationsRepo(fx.db).getConversationById(conversationId);
    expect(conv?.title).toBe('Original');
  });
});

describe('summarize subscriber', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = mkFixture();
  });
  afterEach(() => {
    close(fx);
  });

  async function deliverAnswered(bus: InMemoryMessageBus, conversationId: string): Promise<void> {
    const payload: ChatMessageAnsweredPayload = {
      conversationId,
      assistantMessageId: crypto.randomUUID(),
      layerId: fx.layerId,
      userId: fx.userId,
      tokensIn: 0,
      tokensOut: 0,
    };
    await bus.publish({ type: 'chat.message.answered', payload });
  }

  it('runs the handler at message 6 and 12 but NOT at 1-5 or 7-11', async () => {
    const bus = new InMemoryMessageBus();
    const conversationId = seedConversation(fx, 'Untitled');
    let llmCalls = 0;
    const llm: LlmClient = {
      endpoint: 'mock://test',
      defaultModel: 'mock',
      async chat() {
        llmCalls += 1;
        return {
          id: 'r',
          model: 'mock',
          content: `Call ${llmCalls}`,
          tokensIn: 0,
          tokensOut: 0,
          raw: null,
        };
      },
    };
    const sub = createSummarizeConversationSubscriber({ bus, db: fx.db, llm });
    sub.start();

    // 1..5 — not eligible.
    for (let i = 0; i < 5; i += 1) {
      pushMessage(fx, conversationId, 'user');
      await deliverAnswered(bus, conversationId);
    }
    expect(llmCalls).toBe(0);

    // 6 — eligible.
    pushMessage(fx, conversationId, 'user');
    await deliverAnswered(bus, conversationId);
    expect(llmCalls).toBe(1);

    // 7..11 — not eligible (idempotent guard + non-multiple-of-6).
    for (let i = 0; i < 5; i += 1) {
      pushMessage(fx, conversationId, 'user');
      await deliverAnswered(bus, conversationId);
    }
    expect(llmCalls).toBe(1);

    // 12 — eligible again.
    pushMessage(fx, conversationId, 'user');
    await deliverAnswered(bus, conversationId);
    expect(llmCalls).toBe(2);

    // Watermark followed along.
    const conv = createChatConversationsRepo(fx.db).getConversationById(conversationId);
    expect(conv?.lastSummarizedMessageCount).toBe(12);
    expect(conv?.title).toBe('Call 2');
  });
});
