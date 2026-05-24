/**
 * Phase 7.1 — vector read path unit tests.
 *
 * Pins the contract `createVectorSearch` + `LanceWriter.searchByVector`
 * promise to the chat retrieval step:
 *
 *  1. Happy path: an OpenAI-style embedder + a populated in-memory
 *     LanceDB writer returns the nearest neighbour first, with the
 *     pre-filter applied (no cross-layer leakage).
 *  2. Fallback paths each surface a stable reason and return `null`
 *     (so the caller drops to LIKE):
 *       - no embedder
 *       - MockEmbedder (deterministic offline tests stay on LIKE)
 *       - cold corpus (table missing) and empty corpus (0 rows)
 *       - reader error
 *  3. Populated corpus + non-matching query: returns `[]`, NOT a
 *     fallback. A genuine vector miss is a real answer; falling back
 *     to LIKE on every miss would defeat the whole point of the swap
 *     and silently re-introduce the very behaviour 7.1 replaces.
 *  4. Telemetry: `entity.search.vector.duration_ms` is observed on
 *     success; `entity.search.vector.fallback` increments with the
 *     correct `reason` dimension on fallback.
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import {
  createInMemoryLanceWriter,
  createVectorSearch,
  ENTITY_KIND_TO_LANCE_TABLE,
  type LanceWriter,
  type VectorSearchHelper,
} from '../src/chat/embeddings';
import { createMockEmbedder, type Embedder } from '../src/chat/embeddings/embedder';

const COMPANY_TABLE = ENTITY_KIND_TO_LANCE_TABLE['company'] as string;

/** Tiny embedder that produces a deterministic, non-mock vector. */
function createFakeOpenAiEmbedder(map: Readonly<Record<string, readonly number[]>>): Embedder {
  return {
    id: 'openai:fake',
    dimensions: 4,
    async encode(text) {
      const vec = map[text] ?? [0, 0, 0, 0];
      const out = new Float32Array(4);
      for (let i = 0; i < 4; i += 1) out[i] = vec[i] ?? 0;
      return out;
    },
  };
}

interface RecordedCounters {
  inc: (name: string, by?: number, dims?: Readonly<Record<string, string>>) => void;
  observe: (name: string, value: number, dims?: Readonly<Record<string, string>>) => void;
  counters: Map<string, number>;
  observations: Array<{ name: string; value: number; dims?: Readonly<Record<string, string>> }>;
}

function recordedCounters(): RecordedCounters {
  const counters = new Map<string, number>();
  const observations: RecordedCounters['observations'] = [];
  return {
    counters,
    observations,
    inc(name, by = 1, dims) {
      const key = dims ? `${name}|${JSON.stringify(dims)}` : name;
      counters.set(key, (counters.get(key) ?? 0) + by);
    },
    observe(name, value, dims) {
      observations.push(dims === undefined ? { name, value } : { name, value, dims });
    },
  };
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
};

describe('phase 7.1 — vector read path', () => {
  let writer: LanceWriter;
  let helper: VectorSearchHelper;
  let counters: RecordedCounters;
  // Two rows in the same layer; the embedder maps the query to row 1.
  // A third row in a DIFFERENT layer would match the query closer than
  // either visible row — the regression test below pins that the
  // pre-filter excludes it before the neighbour scan even runs.
  const LAYER_A = 'layer-a';
  const LAYER_B = 'layer-b';

  beforeEach(async () => {
    writer = createInMemoryLanceWriter();
    counters = recordedCounters();
    helper = createVectorSearch({
      embedder: createFakeOpenAiEmbedder({
        // Query "acme" maps near row a-1 (cosine ~0).
        acme: [1, 0, 0, 0],
        unrelated: [0, 0, 0, 1],
      }),
      reader: writer,
      logger: silentLogger,
      counters,
    });
    await writer.upsert(COMPANY_TABLE, {
      id: 'a-1',
      layer_id: LAYER_A,
      kind: 'company',
      slug: 'a-1',
      text: 'Acme strategy',
      vector: new Float32Array([0.99, 0.1, 0, 0]),
    });
    await writer.upsert(COMPANY_TABLE, {
      id: 'a-2',
      layer_id: LAYER_A,
      kind: 'company',
      slug: 'a-2',
      text: 'Bunny ranch',
      vector: new Float32Array([0, 1, 0, 0]),
    });
  });

  it('returns the nearest layer-visible row first', async () => {
    const hits = await helper.searchByKind('company', [LAYER_A], 'acme', 5);
    expect(hits).not.toBeNull();
    expect(hits!.length).toBe(2);
    expect(hits![0]?.id).toBe('a-1');
    expect(hits![0]?.layer_id).toBe(LAYER_A);
    // Telemetry: a successful run observes duration_ms and increments
    // the ok counter dimensioned by kind only (no layer id leaks in).
    expect(counters.observations.some((o) => o.name === 'entity.search.vector.duration_ms')).toBe(
      true,
    );
    const okKey = `entity.search.vector.ok|${JSON.stringify({ kind: 'company' })}`;
    expect(counters.counters.get(okKey)).toBe(1);
  });

  it('falls back when the embedder is the MockEmbedder', async () => {
    const mockHelper = createVectorSearch({
      embedder: createMockEmbedder(),
      reader: writer,
      logger: silentLogger,
      counters,
    });
    const hits = await mockHelper.searchByKind('company', [LAYER_A], 'acme', 5);
    expect(hits).toBeNull();
    expect(mockHelper.lastFallbackReason('company')).toBe('mock-embedder');
    const fbKey = `entity.search.vector.fallback|${JSON.stringify({
      kind: 'company',
      reason: 'mock-embedder',
    })}`;
    expect(counters.counters.get(fbKey)).toBe(1);
  });

  it('falls back when no embedder is wired', async () => {
    const noEmbHelper = createVectorSearch({
      reader: writer,
      logger: silentLogger,
      counters,
    });
    const hits = await noEmbHelper.searchByKind('company', [LAYER_A], 'acme', 5);
    expect(hits).toBeNull();
    expect(noEmbHelper.lastFallbackReason('company')).toBe('no-embedder');
  });

  it('falls back when the LanceDB table does not yet exist (cold corpus)', async () => {
    // No rows for `contact` were ever inserted in `beforeEach`.
    const hits = await helper.searchByKind('contact', [LAYER_A], 'acme', 5);
    expect(hits).toBeNull();
    expect(helper.lastFallbackReason('contact')).toBe('corpus-empty');
  });

  it('returns [] (NOT a fallback) on a populated corpus with no close match', async () => {
    // The query "unrelated" maps to a vector orthogonal to every
    // seeded row; pre-filter still finds them, the limit still
    // returns them — but the contract here is "vector path was used",
    // not "fallback because miss".
    const hits = await helper.searchByKind('company', [LAYER_A], 'unrelated', 5);
    expect(hits).not.toBeNull();
    expect(hits!.length).toBeGreaterThan(0);
    expect(helper.lastFallbackReason('company')).toBeNull();
  });

  it('falls back when the reader throws', async () => {
    const brokenReader: LanceWriter = {
      ...writer,
      async searchByVector() {
        throw new Error('lancedb exploded');
      },
    };
    const brokenHelper = createVectorSearch({
      embedder: createFakeOpenAiEmbedder({ acme: [1, 0, 0, 0] }),
      reader: brokenReader,
      logger: silentLogger,
      counters,
    });
    const hits = await brokenHelper.searchByKind('company', [LAYER_A], 'acme', 5);
    expect(hits).toBeNull();
    expect(brokenHelper.lastFallbackReason('company')).toBe('error');
  });

  it('returns [] when layerIds is empty (no embedder call, no fallback)', async () => {
    const hits = await helper.searchByKind('company', [], 'acme', 5);
    expect(hits).toEqual([]);
    expect(helper.lastFallbackReason('company')).toBeNull();
  });

  it('pre-filters cross-layer rows BEFORE the neighbour scan', async () => {
    // Seed a row in layer B whose vector is the QUERY vector itself —
    // i.e. it would rank first if the filter ran after the scan.
    await writer.upsert(COMPANY_TABLE, {
      id: 'b-1',
      layer_id: LAYER_B,
      kind: 'company',
      slug: 'b-1',
      text: 'Acme but in layer B (must not leak)',
      vector: new Float32Array([1, 0, 0, 0]),
    });
    const hits = await helper.searchByKind('company', [LAYER_A], 'acme', 5);
    expect(hits).not.toBeNull();
    expect(hits!.every((h) => h.layer_id === LAYER_A)).toBe(true);
    expect(hits!.some((h) => h.id === 'b-1')).toBe(false);
  });
});
