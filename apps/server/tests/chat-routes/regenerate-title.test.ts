/**
 * `POST /l/:slug/chat/conversations/:id/regenerate-title` tests.
 *
 * Covers:
 *  - Happy path: regen replaces the title and returns the updated row.
 *  - 404 for a conversation that belongs to another user / layer (the
 *    auth boundary the existing chat routes enforce).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { makeChatFixture, send, type ChatTestFixture } from './_helpers';

let fx: ChatTestFixture | null = null;

afterEach(() => {
  if (fx !== null) {
    fx.app.cleanup();
    fx = null;
  }
});

describe('regenerate-title', () => {
  it('happy path rewrites the title and bumps the watermark', async () => {
    fx = await makeChatFixture('bunny2-chat-regen-title-');
    const createRes = await send(fx, 'POST', `/l/${fx.layerSlug}/chat/conversations`, fx.token, {
      title: 'Original',
    });
    const { conversation } = (await createRes.json()) as { conversation: { id: string } };

    // Enqueue exactly one reply at the default queue so the handler
    // (which uses the chat client without a `step` marker) picks it
    // up.
    fx.llm.enqueue('summarize-conversation', { content: 'Crisp title' });
    const res = await send(
      fx,
      'POST',
      `/l/${fx.layerSlug}/chat/conversations/${conversation.id}/regenerate-title`,
      fx.token,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversation: { title: string; lastSummarizedMessageCount: number | null };
    };
    expect(body.conversation.title).toBe('Crisp title');
    // No messages exist yet, so the watermark is bumped to 0
    // (force=true short-circuits the gate).
    expect(body.conversation.lastSummarizedMessageCount).toBe(0);
  });

  it('returns 404 when the conversation belongs to another user', async () => {
    fx = await makeChatFixture('bunny2-chat-regen-title-authz-');
    const createRes = await send(fx, 'POST', `/l/${fx.layerSlug}/chat/conversations`, fx.token, {
      title: 'Alice',
    });
    const { conversation } = (await createRes.json()) as { conversation: { id: string } };
    // Bob hits Alice's conversation id under his own layer → 404
    // (the conversation's user_id != bob).
    const res = await send(
      fx,
      'POST',
      `/l/${fx.otherLayerSlug}/chat/conversations/${conversation.id}/regenerate-title`,
      fx.otherToken,
    );
    expect(res.status).toBe(404);
  });
});
