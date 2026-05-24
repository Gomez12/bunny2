import { z } from 'zod';
import type { ChatChunk, ChatRequest, ChatResponse, LlmProvider } from '../types';

/**
 * Minimal subset of the OpenAI Chat Completions response that we rely on.
 * The full response is preserved in `ChatResponse.raw` for callers that
 * need provider-specific fields; this schema is only used to extract the
 * fields we promote to first-class columns.
 */
const ChatCompletionResponseSchema = z.object({
  id: z.string(),
  model: z.string(),
  choices: z
    .array(
      z.object({
        message: z.object({
          role: z.string(),
          content: z.string(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export interface OpenAiCompatibleOpts {
  readonly endpoint: string;
  readonly apiKey: string;
  /** Override the global `fetch` for tests. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * POSTs to `${endpoint}/chat/completions` using the documented OpenAI Chat
 * Completions request shape. Works against OpenAI, Ollama
 * (`http://localhost:11434/v1`), LM Studio, and similar.
 *
 * The provider never echoes the API key into the request payload we hand
 * back to telemetry — `Authorization: Bearer ${apiKey}` is set on the
 * outgoing HTTP request and stays there.
 */
export function createOpenAiCompatibleProvider(opts: OpenAiCompatibleOpts): LlmProvider {
  const endpoint = opts.endpoint.replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    endpoint,
    async chat(req: ChatRequest & { model: string }): Promise<ChatResponse> {
      const body: Record<string, unknown> = {
        model: req.model,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      };
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;

      const url = `${endpoint}/chat/completions`;
      const fetchInit: RequestInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(body),
      };
      if (req.signal !== undefined) {
        fetchInit.signal = req.signal;
      }
      const res = await fetchImpl(url, fetchInit);

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`LLM HTTP ${res.status} ${res.statusText}: ${text}`);
      }

      const raw: unknown = await res.json();
      const parsed = ChatCompletionResponseSchema.parse(raw);
      const firstChoice = parsed.choices[0];
      if (!firstChoice) {
        // Schema's .min(1) guards this, but TS still narrows the index access
        // to `T | undefined`; explicit branch keeps the code honest.
        throw new Error('LLM response had zero choices');
      }

      return {
        id: parsed.id,
        model: parsed.model,
        content: firstChoice.message.content,
        tokensIn: parsed.usage?.prompt_tokens ?? 0,
        tokensOut: parsed.usage?.completion_tokens ?? 0,
        raw,
      };
    },

    /**
     * Phase 6.4 — streamed `text/event-stream` reader.
     *
     * Drives one POST `/chat/completions` with `stream: true`,
     * decodes the `data:` frames per the OpenAI spec, and yields
     * one `ChatChunk` per non-empty delta. The final OpenAI frame
     * (`data: [DONE]`) maps to a terminal `{ done: true, ... }`
     * chunk that carries the token counts when the upstream emits
     * a `usage` block (a non-OpenAI server may not — the wrapper
     * estimates from the accumulated text when absent).
     *
     * Aborts: `req.signal` is forwarded to `fetch`, which cancels
     * the underlying socket. The decoder then sees `reader.read()`
     * throw, which surfaces as an `AbortError` to the caller.
     */
    async *chatStream(req: ChatRequest & { model: string }): AsyncIterable<ChatChunk> {
      const body: Record<string, unknown> = {
        model: req.model,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
      };
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;

      const url = `${endpoint}/chat/completions`;
      const fetchInit: RequestInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(body),
      };
      if (req.signal !== undefined) fetchInit.signal = req.signal;

      const res = await fetchImpl(url, fetchInit);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`LLM HTTP ${res.status} ${res.statusText}: ${text}`);
      }
      if (res.body === null) {
        throw new Error('LLM stream response had no body');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let lastModel: string | undefined;
      let tokensIn: number | undefined;
      let tokensOut: number | undefined;
      let done = false;

      try {
        while (!done) {
          const result = await reader.read();
          if (result.done === true) break;
          buffer += decoder.decode(result.value, { stream: true });

          // SSE frames are separated by blank lines (`\n\n`). Each
          // frame contains one or more `field: value` lines; OpenAI
          // only uses `data:`.
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);

            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (payload === '') continue;
              if (payload === '[DONE]') {
                done = true;
                break;
              }
              let frameJson: unknown;
              try {
                frameJson = JSON.parse(payload);
              } catch {
                // Malformed frame — skip it; the spec allows
                // keep-alive comments and partial buffers.
                continue;
              }
              const parsedFrame = ChatStreamFrameSchema.safeParse(frameJson);
              if (!parsedFrame.success) continue;
              const f = parsedFrame.data;
              if (typeof f.model === 'string') lastModel = f.model;
              if (f.usage !== undefined) {
                if (typeof f.usage.prompt_tokens === 'number') {
                  tokensIn = f.usage.prompt_tokens;
                }
                if (typeof f.usage.completion_tokens === 'number') {
                  tokensOut = f.usage.completion_tokens;
                }
              }
              const delta = f.choices?.[0]?.delta?.content;
              if (typeof delta === 'string' && delta.length > 0) {
                yield { delta };
              }
            }
            if (done) break;
          }
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          /* best-effort */
        }
      }

      // Always yield a terminal `done` frame so the wrapper sees a
      // single close signal regardless of whether the upstream sent
      // `[DONE]`. Token counts are forwarded when known.
      const terminal: ChatChunk = { done: true };
      if (typeof lastModel === 'string') {
        (terminal as { model?: string }).model = lastModel;
      }
      if (typeof tokensIn === 'number') {
        (terminal as { tokensIn?: number }).tokensIn = tokensIn;
      }
      if (typeof tokensOut === 'number') {
        (terminal as { tokensOut?: number }).tokensOut = tokensOut;
      }
      yield terminal;
    },
  };
}

/**
 * Subset of the OpenAI chat-completions stream frame we care about.
 * Permissive enough to survive small per-provider variations (Ollama,
 * LM Studio). Unknown fields are ignored.
 */
const ChatStreamFrameSchema = z
  .object({
    model: z.string().optional(),
    choices: z
      .array(
        z.object({
          delta: z
            .object({
              content: z.string().optional(),
            })
            .partial()
            .optional(),
        }),
      )
      .optional(),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative().optional(),
        completion_tokens: z.number().int().nonnegative().optional(),
      })
      .optional(),
  })
  .passthrough();
