/**
 * Public types for the LLM client.
 *
 * The shape mirrors the OpenAI Chat Completions API closely enough to drop
 * straight into an OpenAI-compatible endpoint (OpenAI, Ollama, LM Studio,
 * etc.) without provider-specific glue. Phase 1.4 only ships `mock://` and
 * `openai-compatible`; later phases add adapters behind the same interface.
 */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

/**
 * Optional, free-form bag of context flags that the caller wants threaded
 * into telemetry. Phase 1.4 recognises `correlationId`, `flowId`, `layerId`,
 * and `userId`; unknown keys are kept in the request JSON but not promoted
 * to columns.
 */
export interface ChatMetadata {
  readonly correlationId?: string;
  readonly flowId?: string;
  readonly layerId?: string;
  readonly userId?: string;
  readonly [key: string]: unknown;
}

export interface ChatRequest {
  readonly model?: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly metadata?: ChatMetadata;
}

export interface ChatResponse {
  readonly id: string;
  readonly model: string;
  readonly content: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly raw: unknown;
}

/**
 * A concrete backend that knows how to talk to one endpoint shape (mock,
 * openai-compatible, etc.). The provider receives the model name already
 * resolved (per-call override → client default) so it never has to know
 * about the default.
 */
export interface LlmProvider {
  readonly endpoint: string;
  chat(req: ChatRequest & { model: string }): Promise<ChatResponse>;
}

/**
 * The thing the rest of the app talks to. Has a stable `endpoint` and
 * `defaultModel` for telemetry/observability, and resolves the per-call
 * `model` override before delegating to the underlying provider.
 */
export interface LlmClient {
  readonly endpoint: string;
  readonly defaultModel: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}
