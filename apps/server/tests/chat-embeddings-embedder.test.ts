/**
 * Phase 6.2 — `MockEmbedder` determinism + `OpenAiEmbedder` shape.
 *
 * Pins the contract the LanceDB write path depends on:
 *  - same text → same vector (byte-for-byte).
 *  - different text → different vector.
 *  - vector dim matches `embedder.dimensions`.
 *
 * The `OpenAiEmbedder` test uses an injected `fetchImpl` so the suite
 * stays offline and does not leak request bodies into a real
 * endpoint.
 */
import { describe, expect, it } from 'bun:test';
import {
  createMockEmbedder,
  createOpenAiEmbedder,
  MOCK_EMBEDDER_DIMENSIONS,
} from '../src/chat/embeddings/embedder';

describe('phase 6.2 — MockEmbedder', () => {
  it('produces a deterministic 32-dim vector for the same text', async () => {
    const embedder = createMockEmbedder();
    expect(embedder.dimensions).toBe(MOCK_EMBEDDER_DIMENSIONS);
    const a = await embedder.encode('meeting with Acme');
    const b = await embedder.encode('meeting with Acme');
    expect(a.length).toBe(MOCK_EMBEDDER_DIMENSIONS);
    expect(b.length).toBe(MOCK_EMBEDDER_DIMENSIONS);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('produces a different vector for different text', async () => {
    const embedder = createMockEmbedder();
    const a = await embedder.encode('meeting with Acme');
    const b = await embedder.encode('meeting with Globex');
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('returns a zero vector for the empty string without throwing', async () => {
    const embedder = createMockEmbedder();
    const v = await embedder.encode('');
    expect(v.length).toBe(MOCK_EMBEDDER_DIMENSIONS);
    expect(Array.from(v).every((x) => x === 0)).toBe(true);
  });

  it('never produces NaN or non-finite values', async () => {
    const embedder = createMockEmbedder();
    const v = await embedder.encode('a tricky payload with unicode ✓ and emoji 🦊');
    for (const x of v) {
      expect(Number.isFinite(x)).toBe(true);
    }
  });
});

describe('phase 6.2 — OpenAiEmbedder', () => {
  it('POSTs to <endpoint>/v1/embeddings and returns a Float32Array of the configured size', async () => {
    let capturedUrl = '';
    let capturedBody: unknown = null;
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(
        JSON.stringify({
          data: [{ embedding: new Array(4).fill(0).map((_, i) => i * 0.1) }],
          model: 'test-model',
          usage: { total_tokens: 3 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const embedder = createOpenAiEmbedder({
      endpoint: 'https://example.test/v1',
      apiKey: 'sk-test',
      model: 'test-model',
      dimensions: 4,
      fetchImpl,
    });
    const v = await embedder.encode('hello');
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(4);
    expect(capturedUrl).toBe('https://example.test/v1/embeddings');
    expect((capturedBody as { model: string }).model).toBe('test-model');
    expect((capturedBody as { input: string }).input).toBe('hello');
    expect(capturedHeaders['Authorization']).toBe('Bearer sk-test');
  });

  it('throws a redacted error on non-2xx without leaking the response body', async () => {
    const fetchImpl = (async () =>
      new Response('something with a secret', { status: 401 })) as unknown as typeof fetch;
    const embedder = createOpenAiEmbedder({
      endpoint: 'https://example.test/v1',
      apiKey: 'sk-test',
      model: 'test-model',
      dimensions: 4,
      fetchImpl,
    });
    let thrown: unknown = null;
    try {
      await embedder.encode('hi');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain('HTTP 401');
    expect(String(thrown)).not.toContain('secret');
  });
});
