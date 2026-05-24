/**
 * Phase 6.6 — `/l/:slug/chat/board` route tests.
 *
 * Covers:
 *  - Auth + cross-layer 404 (same gate as the other chat routes).
 *  - Happy path: after one SSE message round-trip there is exactly
 *    one assistant board item with its run + step snapshot.
 *  - Soft-deleted conversations are excluded.
 *  - The list-conversations endpoint now carries aggregated
 *    `feedbackUpCount` / `feedbackDownCount` (used by the
 *    `RecentChatsWidget`).
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

function enqueueHappyPath(fx: ChatTestFixture, answerText: string): void {
  fx.llm.enqueue('intent', {
    content: JSON.stringify({ intent: 'question.entity_lookup', confidence: 0.9 }),
  });
  fx.llm.enqueue('entities', {
    content: JSON.stringify({
      kinds: ['calendar_event'],
      queryHints: [{ term: 'acme', kind: 'calendar_event' }],
    }),
  });
  fx.llm.enqueue('answer', { content: answerText, streamChunkCount: 2 });
}

async function createConversation(fx: ChatTestFixture, token: string): Promise<string> {
  const res = await send(fx, 'POST', `/l/${fx.layerSlug}/chat/conversations`, token, {
    title: 'board test',
  });
  if (res.status !== 201) throw new Error(`createConversation: ${res.status}`);
  const body = (await res.json()) as { conversation: { id: string } };
  return body.conversation.id;
}

async function postMessageAndWait(
  fx: ChatTestFixture,
  conversationId: string,
  content: string,
): Promise<void> {
  const res = await fx.app.app.fetch(
    new Request(
      `http://localhost/l/${fx.layerSlug}/chat/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${fx.token}`,
        },
        body: JSON.stringify({ content }),
      },
    ),
  );
  if (res.status !== 200) throw new Error(`postMessage: ${res.status}`);
  await consumeSse(res); // drain so the orchestrator finalises
}

describe('phase 6.6 — chat board route', () => {
  it('rejects unauthenticated calls with 401', async () => {
    fx = await makeChatFixture('bunny2-chat-board-401-');
    const res = await send(fx, 'GET', `/l/${fx.layerSlug}/chat/board`, null);
    expect(res.status).toBe(401);
  });

  it('returns 404 errors.layer.notVisible for a layer the user cannot see', async () => {
    fx = await makeChatFixture('bunny2-chat-board-cross-');
    const res = await send(fx, 'GET', `/l/${fx.otherLayerSlug}/chat/board`, fx.token);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.layer.notVisible');
  });

  it('returns assistant board items with run + step snapshots after one message round-trip', async () => {
    fx = await makeChatFixture('bunny2-chat-board-happy-');
    const convId = await createConversation(fx, fx.token);
    enqueueHappyPath(fx, 'The Acme meeting is tomorrow at 10:00.');
    await postMessageAndWait(fx, convId, 'when do I meet acme?');

    const res = await send(fx, 'GET', `/l/${fx.layerSlug}/chat/board`, fx.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        messageId: string;
        conversationId: string;
        conversationTitle: string;
        role: string;
        status: string;
        contentPreview: string;
        run: { status: string } | null;
        steps: Array<{ kind: string; status: string }>;
      }>;
    };
    // Exactly one assistant message (the user row is filtered out).
    expect(body.items.length).toBe(1);
    const item = body.items[0];
    expect(item).toBeDefined();
    if (item === undefined) return;
    expect(item.role).toBe('assistant');
    expect(item.conversationId).toBe(convId);
    expect(item.status).toBe('done');
    expect(item.run).not.toBeNull();
    expect(item.run?.status).toBe('succeeded');
    // The orchestrator persisted four steps (intent / entities /
    // retrieval / answer).
    const stepKinds = item.steps.map((s) => s.kind).sort();
    expect(stepKinds).toEqual(['answer', 'entities', 'intent', 'retrieval']);
  });

  it('excludes soft-deleted conversations from the board', async () => {
    fx = await makeChatFixture('bunny2-chat-board-delete-');
    const convId = await createConversation(fx, fx.token);
    enqueueHappyPath(fx, 'short answer');
    await postMessageAndWait(fx, convId, 'q');

    const before = await send(fx, 'GET', `/l/${fx.layerSlug}/chat/board`, fx.token);
    const beforeBody = (await before.json()) as { items: unknown[] };
    expect(beforeBody.items.length).toBe(1);

    const del = await send(
      fx,
      'DELETE',
      `/l/${fx.layerSlug}/chat/conversations/${convId}`,
      fx.token,
    );
    expect(del.status).toBe(200);

    const after = await send(fx, 'GET', `/l/${fx.layerSlug}/chat/board`, fx.token);
    const afterBody = (await after.json()) as { items: unknown[] };
    expect(afterBody.items.length).toBe(0);
  });
});

describe('phase 6.6 — conversation list feedback aggregates', () => {
  it('returns feedbackUpCount / feedbackDownCount alongside conversation fields', async () => {
    fx = await makeChatFixture('bunny2-chat-feedback-list-');
    const convId = await createConversation(fx, fx.token);
    enqueueHappyPath(fx, 'answer');
    await postMessageAndWait(fx, convId, 'q');

    // The assistant message id is the only assistant message in this
    // conversation; read it back via the messages endpoint and post a
    // thumbs-up.
    const msgs = await send(
      fx,
      'GET',
      `/l/${fx.layerSlug}/chat/conversations/${convId}/messages`,
      fx.token,
    );
    const { messages } = (await msgs.json()) as {
      messages: Array<{ id: string; role: string }>;
    };
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    if (assistant === undefined) return;

    const fbRes = await send(
      fx,
      'POST',
      `/l/${fx.layerSlug}/chat/messages/${assistant.id}/feedback`,
      fx.token,
      { value: 'up' },
    );
    expect(fbRes.status).toBe(201);

    const listRes = await send(fx, 'GET', `/l/${fx.layerSlug}/chat/conversations`, fx.token);
    expect(listRes.status).toBe(200);
    const { conversations } = (await listRes.json()) as {
      conversations: Array<{
        id: string;
        feedbackUpCount?: number;
        feedbackDownCount?: number;
      }>;
    };
    const row = conversations.find((r) => r.id === convId);
    expect(row).toBeDefined();
    expect(row?.feedbackUpCount).toBe(1);
    expect(row?.feedbackDownCount).toBe(0);
  });
});
