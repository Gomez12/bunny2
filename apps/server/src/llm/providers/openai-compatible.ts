import { z } from 'zod';
import type { ChatRequest, ChatResponse, LlmProvider } from '../types';

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
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(body),
      });

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
  };
}
