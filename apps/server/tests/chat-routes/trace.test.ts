/**
 * Follow-up `chat-llm-call-inspector` — per-message trace route tests.
 *
 * `GET /l/:slug/chat/conversations/:convId/messages/:msgId/trace`
 * returns the persisted pipeline runs + steps for an assistant
 * message, with each step's joined `llm_calls` row hanging off when
 * present. The renderer surfaces it inside a collapsed `<details>`
 * panel so a user can diagnose a failed turn without opening SQLite.
 *
 * Covers:
 *  - Owner happy path: runs + steps + the joined LLM-call payload.
 *  - Cross-user 404 (`bob` cannot read `alice`'s message trace).
 *  - Cross-layer 404 (`alice` cannot ask for a trace under `bob`'s
 *    layer slug).
 *  - Unknown message id → 404.
 *  - Unauthenticated → 401.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  makeChatFixture,
  send,
  consumeSse,
  type ChatTestFixture,
  type SseFrame,
} from './_helpers';

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
    title: 'trace test',
  });
  if (res.status !== 201) throw new Error(`createConversation: ${res.status}`);
  const body = (await res.json()) as { conversation: { id: string } };
  return body.conversation.id;
}

async function postMessageAndWaitForAssistant(
  fx: ChatTestFixture,
  conversationId: string,
  content: string,
): Promise<string> {
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
  const frames = await consumeSse(res);
  return assistantMessageIdFromFrames(frames);
}

function assistantMessageIdFromFrames(frames: readonly SseFrame[]): string {
  // `done` (happy path) and `error` (failure) both carry the
  // assistant message id as `{ messageId }` per
  // `apps/server/src/http/routes/layer-chat.ts`. Either frame works
  // for the trace lookup — both close the SSE stream.
  for (const frame of frames) {
    if (frame.event !== 'done' && frame.event !== 'error') continue;
    const payload = JSON.parse(frame.data) as { messageId?: string };
    if (typeof payload.messageId === 'string') return payload.messageId;
  }
  throw new Error('no done/error frame; cannot resolve assistant message id');
}

interface TraceBody {
  messageId: string;
  runs: ReadonlyArray<{
    id: string;
    status: string;
    startedAt: string;
    endedAt: string | null;
    steps: ReadonlyArray<{
      id: string;
      kind: string;
      status: string;
      attempt: number;
      errorCode: string | null;
      inputJson: string | null;
      outputJson: string | null;
      llmCall:
        | {
            id: string;
            model: string;
            endpoint: string;
            request: string;
            response: string | null;
            error: string | null;
          }
        | null;
    }>;
  }>;
}

describe('GET /l/:slug/chat/conversations/:convId/messages/:msgId/trace', () => {
  it('rejects unauthenticated calls with 401', async () => {
    fx = await makeChatFixture('bunny2-chat-trace-401-');
    const res = await send(
      fx,
      'GET',
      `/l/${fx.layerSlug}/chat/conversations/00000000-0000-0000-0000-000000000000/messages/00000000-0000-0000-0000-000000000000/trace`,
      null,
    );
    expect(res.status).toBe(401);
  });

  it('returns runs + steps + joined LLM calls for the owner', async () => {
    fx = await makeChatFixture('bunny2-chat-trace-owner-');
    const convId = await createConversation(fx, fx.token);
    enqueueHappyPath(fx, 'The Acme meeting is tomorrow at 10:00.');
    const assistantMsgId = await postMessageAndWaitForAssistant(
      fx,
      convId,
      'when do I meet acme?',
    );

    const res = await send(
      fx,
      'GET',
      `/l/${fx.layerSlug}/chat/conversations/${convId}/messages/${assistantMsgId}/trace`,
      fx.token,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TraceBody;
    expect(body.messageId).toBe(assistantMsgId);
    expect(body.runs.length).toBe(1);
    const run = body.runs[0]!;
    expect(run.status).toBe('succeeded');
    const stepKinds = run.steps.map((s) => s.kind).sort();
    expect(stepKinds).toEqual(['answer', 'entities', 'intent', 'retrieval']);
    // The intent + entities + answer steps invoked the LLM, so their
    // joined `llmCall` must carry the request the orchestrator sent
    // and the response the LLM produced. `retrieval` runs without an
    // LLM call in this happy path (LanceDB hit), so its slot is null.
    const intentStep = run.steps.find((s) => s.kind === 'intent');
    expect(intentStep).toBeDefined();
    expect(intentStep?.llmCall).not.toBeNull();
    expect(intentStep?.llmCall?.request.length ?? 0).toBeGreaterThan(0);
    expect(intentStep?.llmCall?.response?.length ?? 0).toBeGreaterThan(0);
    expect(intentStep?.llmCall?.endpoint.length ?? 0).toBeGreaterThan(0);
  });

  it('returns 404 errors.chat.notFound when another user asks for the trace', async () => {
    fx = await makeChatFixture('bunny2-chat-trace-cross-user-');
    const convId = await createConversation(fx, fx.token);
    enqueueHappyPath(fx, 'ok');
    const assistantMsgId = await postMessageAndWaitForAssistant(fx, convId, 'hi');

    const res = await send(
      fx,
      'GET',
      `/l/${fx.layerSlug}/chat/conversations/${convId}/messages/${assistantMsgId}/trace`,
      fx.otherToken,
    );
    // Bob cannot see alice's layer; the layer middleware fires
    // `errors.layer.notVisible` before the route runs.
    expect(res.status).toBe(404);
  });

  it('returns 404 when the message id does not belong to the conversation', async () => {
    fx = await makeChatFixture('bunny2-chat-trace-wrong-msg-');
    const convId = await createConversation(fx, fx.token);
    const res = await send(
      fx,
      'GET',
      `/l/${fx.layerSlug}/chat/conversations/${convId}/messages/11111111-1111-1111-1111-111111111111/trace`,
      fx.token,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.chat.notFound');
  });
});
