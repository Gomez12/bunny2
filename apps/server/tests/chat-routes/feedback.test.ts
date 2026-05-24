/**
 * Phase 6.4 — `POST /l/:slug/chat/messages/:id/feedback` tests.
 *
 * Covers the §6 contract:
 *  - thumbs-down with reason is stored verbatim,
 *  - thumbs-up with reason is rejected (the column is meaningless),
 *  - re-posting overwrites via the UNIQUE(message_id) constraint,
 *  - feedback on a message the caller does not own → 404.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { makeChatFixture, send, consumeSse, type ChatTestFixture } from './_helpers';

let fx: ChatTestFixture | null = null;

afterEach(() => {
  if (fx !== null) {
    fx.app.cleanup();
    fx = null;
  }
});

/** Drives one happy-path SSE round-trip, returning the assistant message id. */
async function postOneAnswer(fx: ChatTestFixture): Promise<string> {
  const createRes = await send(fx, 'POST', `/l/${fx.layerSlug}/chat/conversations`, fx.token, {
    title: 't',
  });
  const { conversation } = (await createRes.json()) as { conversation: { id: string } };
  fx.llm.enqueue('intent', {
    content: JSON.stringify({ intent: 'question.entity_lookup' }),
  });
  fx.llm.enqueue('entities', {
    content: JSON.stringify({ kinds: [], queryHints: [] }),
  });
  fx.llm.enqueue('answer', { content: 'hello world', streamChunkCount: 2 });
  const res = await fx.app.app.fetch(
    new Request(
      `http://localhost/l/${fx.layerSlug}/chat/conversations/${conversation.id}/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${fx.token}`,
        },
        body: JSON.stringify({ content: 'hi' }),
      },
    ),
  );
  const frames = await consumeSse(res);
  const doneFrame = frames.find((f) => f.event === 'done');
  if (doneFrame === undefined) throw new Error('postOneAnswer: no done frame');
  const data = JSON.parse(doneFrame.data) as { messageId: string };
  return data.messageId;
}

describe('phase 6.4 — chat feedback', () => {
  it('stores a thumbs-down with a reason and reads it back', async () => {
    fx = await makeChatFixture('bunny2-chat-fb-down-');
    const messageId = await postOneAnswer(fx);
    const res = await send(
      fx,
      'POST',
      `/l/${fx.layerSlug}/chat/messages/${messageId}/feedback`,
      fx.token,
      { value: 'down', reason: 'wrong date' },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      feedback: { value: string; reason: string | null };
    };
    expect(body.feedback.value).toBe('down');
    expect(body.feedback.reason).toBe('wrong date');
  });

  it('rejects a thumbs-up that includes a reason', async () => {
    fx = await makeChatFixture('bunny2-chat-fb-up-reason-');
    const messageId = await postOneAnswer(fx);
    const res = await send(
      fx,
      'POST',
      `/l/${fx.layerSlug}/chat/messages/${messageId}/feedback`,
      fx.token,
      { value: 'up', reason: 'looks good' },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.chat.feedbackReasonNotAllowed');
  });

  it('overwrites the existing feedback via the UNIQUE(message_id) upsert', async () => {
    fx = await makeChatFixture('bunny2-chat-fb-upsert-');
    const messageId = await postOneAnswer(fx);
    await send(fx, 'POST', `/l/${fx.layerSlug}/chat/messages/${messageId}/feedback`, fx.token, {
      value: 'down',
      reason: 'first',
    });
    const second = await send(
      fx,
      'POST',
      `/l/${fx.layerSlug}/chat/messages/${messageId}/feedback`,
      fx.token,
      { value: 'up' },
    );
    expect(second.status).toBe(201);
    const body = (await second.json()) as {
      feedback: { value: string; reason: string | null };
    };
    expect(body.feedback.value).toBe('up');
    expect(body.feedback.reason).toBeNull();

    // Exactly one row per message — the UNIQUE upsert overwrote the
    // first thumbs-down rather than appending.
    const rows = fx.app.db
      .query<
        { n: number },
        [string]
      >(`SELECT COUNT(*) AS n FROM chat_message_feedback WHERE message_id = ?`)
      .get(messageId);
    expect(rows?.n).toBe(1);
  });

  it('returns 404 when a different user tries to post feedback on the message', async () => {
    fx = await makeChatFixture('bunny2-chat-fb-cross-user-');
    const messageId = await postOneAnswer(fx);
    // bob (otherToken) can't see alice's layer at all -> 404
    // because the requireLayer middleware fires first.
    const res = await send(
      fx,
      'POST',
      `/l/${fx.layerSlug}/chat/messages/${messageId}/feedback`,
      fx.otherToken,
      { value: 'up' },
    );
    expect(res.status).toBe(404);
  });
});
