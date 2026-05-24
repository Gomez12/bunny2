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
  /**
   * Phase 6.4 — optional caller-provided abort signal. The streaming
   * variant (`chatStream`) wires this into its `fetch` request so a
   * mid-stream client disconnect, a hard timeout, or any
   * `AbortController.abort()` cancels the upstream HTTP call and
   * stops yielding chunks. The non-streaming `chat` path accepts the
   * same signal for symmetry; providers that do not yet honour it
   * still satisfy the type.
   */
  readonly signal?: AbortSignal;
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
 * Phase 6.4 — one frame of a streamed chat response.
 *
 * The wire shape mirrors the OpenAI chat-completions SSE stream:
 *  - non-terminal frames carry a `delta` (incremental text).
 *  - the terminal frame carries `done: true` and optional final
 *    token counts when the upstream provides them.
 *
 * Each chunk is one of the two shapes; combining them into one
 * union keeps the consumer's `for await` loop free of separate
 * "final" callbacks.
 */
export type ChatChunk =
  | {
      readonly done?: false;
      readonly delta: string;
    }
  | {
      readonly done: true;
      readonly delta?: string;
      readonly tokensIn?: number;
      readonly tokensOut?: number;
      readonly model?: string;
    };

/**
 * A concrete backend that knows how to talk to one endpoint shape (mock,
 * openai-compatible, etc.). The provider receives the model name already
 * resolved (per-call override → client default) so it never has to know
 * about the default.
 *
 * `chatStream` is optional — providers that cannot stream (or have not
 * implemented it yet) simply omit the method; callers fall back to
 * `chat()`.
 */
export interface LlmProvider {
  readonly endpoint: string;
  chat(req: ChatRequest & { model: string }): Promise<ChatResponse>;
  chatStream?(req: ChatRequest & { model: string }): AsyncIterable<ChatChunk>;
}

/**
 * The thing the rest of the app talks to. Has a stable `endpoint` and
 * `defaultModel` for telemetry/observability, and resolves the per-call
 * `model` override before delegating to the underlying provider.
 *
 * Phase 6.4 — `chatStream` is OPTIONAL. The chat-pipeline answer step
 * checks for it at runtime and uses streaming when the caller (the
 * SSE route) also provides a chunk sink; otherwise it falls back to
 * `chat()`. Telemetry's `withTelemetry` wrapper preserves the optional
 * method through wrapping so the answer step sees streaming on
 * production providers that declare it.
 */
export interface LlmClient {
  readonly endpoint: string;
  readonly defaultModel: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
  chatStream?(req: ChatRequest): AsyncIterable<ChatChunk>;
}
