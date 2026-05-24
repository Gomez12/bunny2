/**
 * Phase 6.2 — embedder interface + the two concrete implementations.
 *
 * The plan (`docs/dev/plans/phase-06-super-chat.md` §4.3) calls for:
 *  - `MockEmbedder` — deterministic hash → 32-dim Float32 vector.
 *    Default when no embeddings endpoint is configured (tests / CI /
 *    offline dev). Same `text` always produces the same vector; the
 *    output is bounded, never NaN, never random.
 *  - `OpenAiEmbedder` — reuses the same config-style secret machinery
 *    as the chat LLM (`config.embeddings.endpoint|model|apiKey`). It
 *    POSTs to `/v1/embeddings` directly — the existing `LlmClient`
 *    type only exposes `chat()`, and OpenAI's embeddings endpoint is
 *    a separate surface, so we keep this thin rather than overload
 *    the chat client.
 *
 * No reads — this phase is write-only into LanceDB. The vector is
 * stored alongside the entity's `searchable_text` so phase 7 can
 * swap the read path later without re-encoding.
 *
 * Privacy: the OpenAI implementation never logs the prompt or the
 * vector; it logs `tokens` (when the response includes a usage block)
 * and the model name. Errors get the HTTP status, never the body —
 * a misconfigured endpoint must not leak tokens or keys.
 */

export interface Embedder {
  /** Stable, human-readable id for logs and telemetry. */
  readonly id: string;
  /** Dimensionality of the produced vectors. Constant per embedder. */
  readonly dimensions: number;
  encode(text: string): Promise<Float32Array>;
}

export const MOCK_EMBEDDER_DIMENSIONS = 32;

/**
 * Deterministic hash → 32-dim Float32 vector.
 *
 * The hash is a simple multiplicative mix per byte (FNV-1a inspired)
 * seeded by the dimension index, mapped to [-1, 1] via division by
 * 2^31. Same input always yields the same output, byte-for-byte —
 * the unit test pins this contract.
 *
 * Why 32 dimensions: small enough to keep LanceDB writes cheap in
 * tests, large enough to round-trip through a Float32Array sanity
 * check. Real deployments swap in `OpenAiEmbedder` whose dimension
 * count is governed by the model.
 */
export function createMockEmbedder(): Embedder {
  return {
    id: 'mock',
    dimensions: MOCK_EMBEDDER_DIMENSIONS,
    async encode(text: string): Promise<Float32Array> {
      const out = new Float32Array(MOCK_EMBEDDER_DIMENSIONS);
      // The empty string maps to the zero vector. That's intentional —
      // callers shouldn't pass empty strings (the subscriber filters
      // them out), but if one slips through we don't want NaN.
      if (text.length === 0) return out;
      const bytes = new TextEncoder().encode(text);
      for (let dim = 0; dim < MOCK_EMBEDDER_DIMENSIONS; dim += 1) {
        // Seed varies per dimension so the same byte does not produce
        // the same value across every slot.
        let h = (2166136261 ^ (dim + 1)) >>> 0;
        for (let i = 0; i < bytes.length; i += 1) {
          h ^= bytes[i] ?? 0;
          // FNV prime; the `Math.imul` keeps the multiplication safe
          // in JS's 32-bit integer arithmetic regime.
          h = Math.imul(h, 16777619) >>> 0;
        }
        // Map to a signed 32-bit range, then to [-1, 1].
        const signed = h | 0;
        out[dim] = signed / 0x80000000;
      }
      return out;
    },
  };
}

export interface OpenAiEmbedderOpts {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly dimensions: number;
  /** Override for tests. */
  readonly fetchImpl?: typeof fetch;
}

interface OpenAiEmbeddingsResponse {
  data: ReadonlyArray<{ embedding: readonly number[] }>;
  model?: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

/**
 * OpenAI-compatible embeddings client. POSTs to `${endpoint}/embeddings`
 * — the configured `endpoint` already includes the `/v1` (or
 * equivalent) prefix, matching the chat-side convention in
 * `apps/server/src/llm/providers/openai-compatible.ts`, which does
 * `${endpoint}/chat/completions`. The Authorization header is set
 * only when `apiKey` is non-empty, matching the chat-client behavior
 * for self-hosted endpoints (Ollama / LM Studio) that accept any key.
 */
export function createOpenAiEmbedder(opts: OpenAiEmbedderOpts): Embedder {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = joinUrl(opts.endpoint, '/embeddings');
  return {
    id: `openai:${opts.model}`,
    dimensions: opts.dimensions,
    async encode(text: string): Promise<Float32Array> {
      if (text.length === 0) return new Float32Array(opts.dimensions);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (opts.apiKey.length > 0) headers['Authorization'] = `Bearer ${opts.apiKey}`;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: opts.model, input: text }),
      });
      if (!res.ok) {
        // Never include the body — it can echo the prompt back on
        // some self-hosted providers.
        throw new Error(`embeddings: HTTP ${res.status} from ${opts.endpoint}`);
      }
      const json = (await res.json()) as OpenAiEmbeddingsResponse;
      const first = json.data[0];
      if (!first || !Array.isArray(first.embedding)) {
        throw new Error(`embeddings: missing data[0].embedding in response from ${opts.endpoint}`);
      }
      const vec = first.embedding;
      if (vec.length !== opts.dimensions) {
        throw new Error(
          `embeddings: expected ${opts.dimensions} dims, got ${vec.length} from ${opts.endpoint}`,
        );
      }
      const out = new Float32Array(opts.dimensions);
      for (let i = 0; i < opts.dimensions; i += 1) {
        out[i] = vec[i] ?? 0;
      }
      return out;
    },
  };
}

function joinUrl(base: string, path: string): string {
  const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base;
  const trimmedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}
