import type { ChatRequest, ChatResponse, LlmClient, LlmProvider } from './types';
import { createMockProvider } from './providers/mock';
import { createOpenAiCompatibleProvider } from './providers/openai-compatible';

export interface CreateLlmClientOpts {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly defaultModel: string;
  /** Override the global `fetch` for tests (forwarded to HTTP providers). */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Picks a provider from the endpoint URL scheme:
 *
 *  - `mock://…` → in-process deterministic mock.
 *  - `http://…` / `https://…` → OpenAI-compatible HTTP provider.
 *
 * The returned `LlmClient` resolves the model override (per-call `req.model`
 * wins over `defaultModel`) before delegating to the provider, which keeps
 * provider implementations free of "default model" knowledge.
 */
export function createLlmClient(opts: CreateLlmClientOpts): LlmClient {
  const provider = pickProvider(opts);

  return {
    endpoint: provider.endpoint,
    defaultModel: opts.defaultModel,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const model = req.model ?? opts.defaultModel;
      return provider.chat({ ...req, model });
    },
  };
}

function pickProvider(opts: CreateLlmClientOpts): LlmProvider {
  if (opts.endpoint.startsWith('mock://')) {
    return createMockProvider(opts.endpoint);
  }
  if (opts.endpoint.startsWith('http://') || opts.endpoint.startsWith('https://')) {
    const httpOpts: Parameters<typeof createOpenAiCompatibleProvider>[0] = {
      endpoint: opts.endpoint,
      apiKey: opts.apiKey,
    };
    if (opts.fetchImpl !== undefined) {
      return createOpenAiCompatibleProvider({ ...httpOpts, fetchImpl: opts.fetchImpl });
    }
    return createOpenAiCompatibleProvider(httpOpts);
  }
  throw new Error(
    `unsupported LLM endpoint: ${opts.endpoint} (expected mock://, http://, or https://)`,
  );
}
