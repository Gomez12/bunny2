/**
 * Phase 6.4 — SSE answerer streaming tests.
 *
 * Covers:
 *  - Happy path: `step` / `token` / `done` sequence, 3 `llm_calls`
 *    rows (router + resolver + answerer), assistant message has
 *    final token counts.
 *  - Upstream LLM throws during the stream → `event: error`,
 *    message `failed`, one `llm_calls` row carries the error and
 *    the partial response.
 *  - Client cancels the response stream mid-flight → message
 *    becomes `failed` with partial content, `llm_calls` row has
 *    `error='aborted'` and a non-null partial `response`.
 *  - The route does NOT accept a `model` body field; the SSE
 *    endpoint must reject it as a bad request.
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
  fx.llm.enqueue('answer', { content: answerText, streamChunkCount: 4 });
}

async function createConversation(fx: ChatTestFixture, token: string): Promise<string> {
  const res = await send(fx, 'POST', `/l/${fx.layerSlug}/chat/conversations`, token, {
    title: 'sse test',
  });
  if (res.status !== 201) throw new Error(`createConversation: ${res.status}`);
  const body = (await res.json()) as { conversation: { id: string } };
  return body.conversation.id;
}

interface LlmCallsRow {
  id: string;
  error: string | null;
  response: string | null;
  tokens_out: number | null;
}
function readLlmCalls(fx: ChatTestFixture): LlmCallsRow[] {
  return fx.app.db
    .query<
      LlmCallsRow,
      []
    >('SELECT id, error, response, tokens_out FROM llm_calls ORDER BY started_at ASC')
    .all();
}

describe('phase 6.4 — SSE answerer streaming', () => {
  it('emits step / token / done in order and lands 3 llm_calls rows', async () => {
    fx = await makeChatFixture('bunny2-chat-sse-happy-');
    const convId = await createConversation(fx, fx.token);
    const answer = 'Your Acme strategy meeting is on 2026-06-01 at 10:00.';
    enqueueHappyPath(fx, answer);

    const res = await fx.app.app.fetch(
      new Request(`http://localhost/l/${fx.layerSlug}/chat/conversations/${convId}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${fx.token}`,
        },
        body: JSON.stringify({ content: 'when do I meet acme?' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const frames = await consumeSse(res);
    const events = frames.map((f) => f.event);
    expect(events).toContain('step');
    expect(events).toContain('token');
    expect(events).toContain('done');
    // `done` must be the final event (any later frames would mean
    // the SSE writer wasn't closed cleanly).
    expect(events[events.length - 1]).toBe('done');

    const tokenFrames = frames.filter((f) => f.event === 'token');
    expect(tokenFrames.length).toBeGreaterThan(0);
    const reconstructed = tokenFrames
      .map((f) => (JSON.parse(f.data) as { delta: string }).delta)
      .join('');
    expect(reconstructed).toBe(answer);

    const doneFrame = frames.find((f) => f.event === 'done');
    expect(doneFrame).toBeDefined();
    const doneData = JSON.parse(doneFrame!.data) as { messageId: string; status: string };
    expect(doneData.status).toBe('done');

    // Assistant message row carries the final content + tokens.
    const msgRow = fx.app.db
      .query<
        { content: string; status: string; tokens_out: number | null },
        [string]
      >(`SELECT content, status, tokens_out FROM chat_messages WHERE id = ?`)
      .get(doneData.messageId);
    expect(msgRow?.status).toBe('done');
    expect(msgRow?.content).toBe(answer);
    expect(msgRow?.tokens_out).not.toBeNull();

    // Three LLM calls: intent + entities + answer (the streamed
    // one). Retrieval is pure code, no LLM call.
    const calls = readLlmCalls(fx);
    expect(calls.length).toBe(3);
    expect(calls.every((c) => c.error === null)).toBe(true);
  });

  it('returns 400 when the body carries a model override', async () => {
    fx = await makeChatFixture('bunny2-chat-sse-no-model-');
    const convId = await createConversation(fx, fx.token);
    enqueueHappyPath(fx, 'hi');
    const res = await fx.app.app.fetch(
      new Request(`http://localhost/l/${fx.layerSlug}/chat/conversations/${convId}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${fx.token}`,
        },
        body: JSON.stringify({ content: 'hi', model: 'evil-model' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('emits event: error when the upstream LLM throws mid-stream', async () => {
    fx = await makeChatFixture('bunny2-chat-sse-upstream-fail-');
    const convId = await createConversation(fx, fx.token);
    // Intent + entities succeed; the answer step's stream aborts
    // after 2 chunks. The orchestrator marks the message `failed`
    // and the SSE route emits `event: error`.
    fx.llm.enqueue('intent', {
      content: JSON.stringify({ intent: 'question.entity_lookup' }),
    });
    fx.llm.enqueue('entities', {
      content: JSON.stringify({ kinds: [], queryHints: [] }),
    });
    fx.llm.enqueue('answer', {
      content: 'streamed reply that will abort halfway',
      streamChunkCount: 6,
      abortAfterChunks: 2,
    });

    const res = await fx.app.app.fetch(
      new Request(`http://localhost/l/${fx.layerSlug}/chat/conversations/${convId}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${fx.token}`,
        },
        body: JSON.stringify({ content: 'hi' }),
      }),
    );
    expect(res.status).toBe(200);

    const frames = await consumeSse(res);
    const errFrame = frames.find((f) => f.event === 'error');
    expect(errFrame).toBeDefined();
    const errData = JSON.parse(errFrame!.data) as { errorCode: string; messageId?: string };
    expect(typeof errData.errorCode).toBe('string');

    // The assistant message row landed `failed`; partial assistant
    // content (the chunks delivered before the abort) was persisted.
    const failedRow = fx.app.db
      .query<
        { status: string; content: string },
        [string]
      >(`SELECT status, content FROM chat_messages WHERE id = ?`)
      .get(errData.messageId!);
    expect(failedRow?.status).toBe('failed');
    // Partial assistant content is non-empty (we got two chunks
    // before the abort).
    expect((failedRow?.content ?? '').length).toBeGreaterThan(0);

    // The answer-step's `llm_calls` row records the abort.
    const calls = readLlmCalls(fx);
    const answerCall = calls[calls.length - 1];
    expect(answerCall?.error).toBe('aborted');
    expect(answerCall?.response).not.toBeNull();
  });

  it('handles client disconnect mid-stream: message failed, partial persisted', async () => {
    fx = await makeChatFixture('bunny2-chat-sse-client-abort-');
    const convId = await createConversation(fx, fx.token);
    fx.llm.enqueue('intent', {
      content: JSON.stringify({ intent: 'question.entity_lookup' }),
    });
    fx.llm.enqueue('entities', {
      content: JSON.stringify({ kinds: [], queryHints: [] }),
    });
    // 6 chunks, 50ms apart — enough time for the client-side abort
    // controller to fire after we see one or two token frames.
    fx.llm.enqueue('answer', {
      content: 'a slow streamed reply that the client will abort',
      streamChunkCount: 6,
      chunkDelayMs: 50,
    });

    const clientController = new AbortController();
    const res = await fx.app.app.fetch(
      new Request(`http://localhost/l/${fx.layerSlug}/chat/conversations/${convId}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${fx.token}`,
        },
        body: JSON.stringify({ content: 'hi' }),
        signal: clientController.signal,
      }),
    );

    let assistantMessageId: string | null = null;
    const frames = await consumeSse(res, {
      abortAfter: (collected) => {
        const tokens = collected.filter((f) => f.event === 'token');
        if (tokens.length >= 1) {
          clientController.abort();
          return true;
        }
        return false;
      },
    });
    expect(frames.some((f) => f.event === 'token')).toBe(true);

    // Wait long enough for the orchestrator finally-block to mark
    // the message `failed`. The route owns the abort-controller
    // wired into the orchestrator; once the SSE writer aborts,
    // `runPipeline` resolves with `status: 'failed'`.
    for (let i = 0; i < 30; i += 1) {
      const row = fx.app.db
        .query<
          { id: string; status: string; content: string },
          []
        >(`SELECT id, status, content FROM chat_messages WHERE role='assistant' ORDER BY created_at DESC LIMIT 1`)
        .get();
      if (row !== null && row.status !== 'queued' && row.status !== 'running') {
        assistantMessageId = row.id;
        if (row.status === 'failed') {
          // Partial content has landed.
          break;
        }
      }
      await Bun.sleep(20);
    }
    expect(assistantMessageId).not.toBeNull();
    const finalRow = fx.app.db
      .query<
        { status: string; content: string },
        [string]
      >(`SELECT status, content FROM chat_messages WHERE id = ?`)
      .get(assistantMessageId!);
    expect(finalRow?.status).toBe('failed');

    // One LLM call row with `error='aborted'` should land
    // eventually (telemetry writes inside the same async loop).
    let answerCall: { error: string | null; response: string | null } | undefined;
    for (let i = 0; i < 30; i += 1) {
      const calls = readLlmCalls(fx);
      const last = calls[calls.length - 1];
      if (last !== undefined && last.error !== null) {
        answerCall = last;
        break;
      }
      await Bun.sleep(20);
    }
    expect(answerCall?.error).toBe('aborted');
    expect(answerCall?.response).not.toBeNull();
  });
});
