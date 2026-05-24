import type { ChatChunk, ChatRequest, ChatResponse, LlmProvider } from '../types';

/**
 * Deterministic in-process provider used by tests, CI, and the default
 * config seed. Two variants by URL:
 *
 *  - `mock://echo`  — replies with `"echo: " + last user message`.
 *  - `mock://error` — throws on every `chat()` call. Used to exercise the
 *                      telemetry error path.
 *
 * Token counts are a deterministic stand-in: total characters across all
 * input messages divided by 4 for `tokensIn`, output chars / 4 for
 * `tokensOut`. The "4 chars ≈ 1 token" heuristic is rough but enough for
 * the prune + cost tests in phase 1.4.
 */
export function createMockProvider(endpoint: string): LlmProvider {
  if (endpoint !== 'mock://echo' && endpoint !== 'mock://error') {
    throw new Error(`unknown mock endpoint: ${endpoint} (expected mock://echo or mock://error)`);
  }

  return {
    endpoint,
    async chat(req: ChatRequest & { model: string }): Promise<ChatResponse> {
      if (endpoint === 'mock://error') {
        // Throw from inside chat() so the telemetry wrapper sees the error
        // and writes a row with `error` populated and `response = null`.
        throw new Error('mock provider configured to always error');
      }

      const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
      const content = `echo: ${lastUser?.content ?? ''}`;

      const inChars = req.messages.reduce((acc, m) => acc + m.content.length, 0);
      const tokensIn = Math.max(0, Math.floor(inChars / 4));
      const tokensOut = Math.max(0, Math.floor(content.length / 4));

      return {
        id: crypto.randomUUID(),
        model: req.model,
        content,
        tokensIn,
        tokensOut,
        raw: { provider: 'mock', endpoint },
      };
    },
    /**
     * Phase 6.4 — deterministic mock stream. Splits the same
     * `echo: <last user message>` response into 3 fixed-size chunks
     * + a `done` frame. Used by the SSE route smoke test and
     * `apps/server/tests/llm/streaming.test.ts`.
     *
     * Honours `req.signal`: if the signal is already aborted, the
     * iterator yields nothing and throws `AbortError`. If it aborts
     * mid-stream, the next iteration step throws.
     */
    async *chatStream(req: ChatRequest & { model: string }): AsyncIterable<ChatChunk> {
      if (endpoint === 'mock://error') {
        throw new Error('mock provider configured to always error');
      }
      const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
      const content = `echo: ${lastUser?.content ?? ''}`;
      const inChars = req.messages.reduce((acc, m) => acc + m.content.length, 0);
      const tokensIn = Math.max(0, Math.floor(inChars / 4));
      const tokensOut = Math.max(0, Math.floor(content.length / 4));

      const chunkCount = 3;
      const chunkLen = Math.max(1, Math.ceil(content.length / chunkCount));
      const pieces: string[] = [];
      for (let i = 0; i < content.length; i += chunkLen) {
        pieces.push(content.slice(i, i + chunkLen));
      }

      for (const piece of pieces) {
        if (req.signal?.aborted === true) {
          throwAbort(req.signal);
        }
        yield { delta: piece };
      }
      yield { done: true, tokensIn, tokensOut, model: req.model };
    },
  };
}

function throwAbort(signal: AbortSignal): never {
  // Surface the `AbortError`-shaped reason so callers can branch on
  // `err.name === 'AbortError'` exactly like `fetch` does on abort.
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  const err = new Error('aborted');
  err.name = 'AbortError';
  throw err;
}
