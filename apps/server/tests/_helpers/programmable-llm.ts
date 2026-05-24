/**
 * Phase 6.3 — programmable LLM client for chat-pipeline tests.
 *
 * The production `mock://echo` provider only echoes the user
 * message, which can't produce intent JSON / entities JSON / a
 * free-text answer in sequence. The chat-pipeline integration
 * tests need scripted responses, so this fixture implements the
 * `LlmClient` interface directly and serves replies keyed by the
 * `metadata.step` marker the orchestrator sets ('intent',
 * 'entities', 'answer').
 *
 * No streaming — that's phase 6.4. Token counts mirror the mock
 * provider's heuristic (chars / 4) so the LLM-calls-row assertions
 * still pass.
 */

import type { ChatChunk, ChatRequest, ChatResponse, LlmClient } from '../../src/llm/types';

export interface ProgrammableLlmReply {
  /** Free-form content sent back to the orchestrator. */
  readonly content: string;
  /** Optional model override; defaults to the client's `defaultModel`. */
  readonly model?: string;
  /** Override tokens; default is char-count/4. */
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  /** Throw this instead of returning a reply. */
  readonly throwError?: Error;
  /**
   * Phase 6.4 — emit `content` as N chunks when the answer step
   * calls `chatStream`. Default chunkCount = 4. Used by the SSE
   * route tests.
   */
  readonly streamChunkCount?: number;
  /**
   * Phase 6.4 — when set, abort the stream after this many
   * non-terminal chunks have been delivered (simulates a server
   * upstream failing mid-stream). Throws an `AbortError`.
   */
  readonly abortAfterChunks?: number;
  /**
   * Phase 6.4 — when set, sleep for N ms between chunks. Lets the
   * client-abort test cancel the request mid-stream.
   */
  readonly chunkDelayMs?: number;
}

export interface ProgrammableLlmCall {
  readonly step: string | null;
  readonly messages: readonly { role: string; content: string }[];
  readonly response: ChatResponse | null;
  readonly error: Error | null;
}

export interface ProgrammableLlmClient extends LlmClient {
  /** Push another reply for `step`. FIFO per step. */
  enqueue(step: string, reply: ProgrammableLlmReply): void;
  /** Inspect every call made so far. */
  readonly calls: readonly ProgrammableLlmCall[];
}

export interface ProgrammableLlmOpts {
  readonly defaultModel?: string;
  readonly endpoint?: string;
}

/**
 * Build a programmable client. Tests enqueue per-step replies in
 * order; the orchestrator pops them as it runs each step.
 */
export function createProgrammableLlm(opts: ProgrammableLlmOpts = {}): ProgrammableLlmClient {
  const endpoint = opts.endpoint ?? 'mock://programmable';
  const defaultModel = opts.defaultModel ?? 'mock-default';
  const queues = new Map<string, ProgrammableLlmReply[]>();
  const calls: ProgrammableLlmCall[] = [];

  function pop(step: string | null): ProgrammableLlmReply {
    const key = step ?? '__default__';
    const q = queues.get(key);
    if (q === undefined || q.length === 0) {
      throw new Error(
        `programmable-llm: no reply enqueued for step='${key}' (calls=${calls.length})`,
      );
    }
    const reply = q.shift();
    if (reply === undefined) {
      throw new Error(`programmable-llm: queue went empty for step='${key}'`);
    }
    return reply;
  }

  const client: ProgrammableLlmClient = {
    endpoint,
    defaultModel,
    async *chatStream(req: ChatRequest): AsyncIterable<ChatChunk> {
      const step =
        typeof req.metadata?.step === 'string' && req.metadata.step.length > 0
          ? req.metadata.step
          : null;
      let response: ChatResponse | null = null;
      let error: Error | null = null;

      const reply = pop(step);
      const chunkCount = reply.streamChunkCount ?? 4;
      const inChars = req.messages.reduce((acc, m) => acc + m.content.length, 0);
      const tokensIn = reply.tokensIn ?? Math.max(0, Math.floor(inChars / 4));
      const tokensOut = reply.tokensOut ?? Math.max(0, Math.floor(reply.content.length / 4));

      try {
        if (reply.throwError) {
          error = reply.throwError;
          throw error;
        }
        const chunkLen = Math.max(1, Math.ceil(reply.content.length / chunkCount));
        const pieces: string[] = [];
        for (let i = 0; i < reply.content.length; i += chunkLen) {
          pieces.push(reply.content.slice(i, i + chunkLen));
        }
        for (let i = 0; i < pieces.length; i += 1) {
          if (req.signal?.aborted === true) {
            const abortErr = new Error('aborted');
            abortErr.name = 'AbortError';
            error = abortErr;
            throw abortErr;
          }
          if (reply.abortAfterChunks !== undefined && i >= reply.abortAfterChunks) {
            const abortErr = new Error('upstream aborted');
            abortErr.name = 'AbortError';
            error = abortErr;
            throw abortErr;
          }
          if (reply.chunkDelayMs !== undefined && reply.chunkDelayMs > 0) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, reply.chunkDelayMs);
              const sig = req.signal;
              if (sig !== undefined) {
                const onAbort = (): void => {
                  clearTimeout(timer);
                  const abortErr = new Error('aborted');
                  abortErr.name = 'AbortError';
                  reject(abortErr);
                };
                if (sig.aborted) onAbort();
                else sig.addEventListener('abort', onAbort, { once: true });
              }
            });
          }
          yield { delta: pieces[i] ?? '' };
        }
        response = {
          id: crypto.randomUUID(),
          model: reply.model ?? defaultModel,
          content: reply.content,
          tokensIn,
          tokensOut,
          raw: { provider: 'programmable', endpoint },
        };
        yield { done: true, tokensIn, tokensOut, model: reply.model ?? defaultModel };
      } finally {
        calls.push({
          step,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
          response,
          error,
        });
      }
    },
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const step =
        typeof req.metadata?.step === 'string' && req.metadata.step.length > 0
          ? req.metadata.step
          : null;
      let response: ChatResponse | null = null;
      let error: Error | null = null;
      try {
        const reply = pop(step);
        if (reply.throwError) {
          error = reply.throwError;
          throw error;
        }
        const inChars = req.messages.reduce((acc, m) => acc + m.content.length, 0);
        const tokensIn = reply.tokensIn ?? Math.max(0, Math.floor(inChars / 4));
        const tokensOut = reply.tokensOut ?? Math.max(0, Math.floor(reply.content.length / 4));
        response = {
          id: crypto.randomUUID(),
          model: reply.model ?? defaultModel,
          content: reply.content,
          tokensIn,
          tokensOut,
          raw: { provider: 'programmable', endpoint },
        };
        return response;
      } finally {
        calls.push({
          step,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
          response,
          error,
        });
      }
    },
    enqueue(step, reply): void {
      const arr = queues.get(step) ?? [];
      arr.push(reply);
      queues.set(step, arr);
    },
    get calls(): readonly ProgrammableLlmCall[] {
      return calls;
    },
  };
  return client;
}
