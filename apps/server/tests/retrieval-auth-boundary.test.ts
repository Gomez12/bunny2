/**
 * Phase 7.1 — retrieval auth-boundary regression.
 *
 * `overall.md` §5 invariant 8 / ADR 0021 §1:
 *   "Vector / semantic search must filter on the caller's effective
 *    layer / group access BEFORE retrieval, never after."
 *
 * The phase-6 LIKE path satisfies this by appending `layer_id IN (?)`
 * to its SQL WHERE before the LIKE comparison. The phase-7 vector path
 * satisfies it by passing the layer set as a pre-filter to
 * `LanceWriter.searchByVector`, which in turn passes it to LanceDB's
 * `.search(vec).where(...)` (pre-filter by default unless
 * `.postfilter()` is called — we never do).
 *
 * This file is the regression that pins the boundary in BOTH directions:
 *
 *   1. With the vector path engaged (real-ish embedder, populated
 *      LanceDB corpus), a query that the cross-layer row matches
 *      MORE closely than any visible row still returns only the
 *      visible row. The vector path is what runs — verified by
 *      `helper.lastFallbackReason('company') === null` after the
 *      call.
 *   2. With the LIKE fallback engaged (MockEmbedder), the same query
 *      against the same data returns only the visible row via the
 *      per-kind SQLite store. The fallback path is what runs —
 *      verified by `helper.lastFallbackReason('company') === 'mock-embedder'`.
 *
 * Both modes share the same fixture so a divergence in either path
 * fails this test, not somewhere downstream.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import { openDatabase } from '../src/storage/sqlite';
import { createLayersRepo } from '../src/repos/layers-repo';
import { createUsersRepo } from '../src/repos/users-repo';
import {
  createInMemoryLanceWriter,
  createVectorSearch,
  ENTITY_KIND_TO_LANCE_TABLE,
  type VectorSearchHelper,
  type LanceWriter,
} from '../src/chat/embeddings';
import { createMockEmbedder, type Embedder } from '../src/chat/embeddings/embedder';
import { createEntityStore } from '../src/entities/store';
import type { EntityModule } from '../src/entities/module';

interface CompanyPayload {
  readonly name: string;
}

function companyModule(): EntityModule<CompanyPayload> {
  return {
    kind: 'company',
    tableName: 'companies',
    payloadSchema: z.object({ name: z.string() }),
    toSummary({ ref, meta, payload, title }) {
      return {
        ...ref,
        meta,
        title,
        subtitle: null,
        searchableText: payload.name.toLowerCase(),
      };
    },
    searchableText(payload) {
      return payload.name.toLowerCase();
    },
  };
}

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
  readonly layerAId: string;
  readonly layerBId: string;
  readonly userId: string;
}

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-retrieval-auth-'));
}

function newFixture(): Fixture {
  const dir = mkTmp();
  const db = openDatabase(dir);
  const now = new Date().toISOString();
  const layersRepo = createLayersRepo(db);
  const usersRepo = createUsersRepo(db);
  const layerA = layersRepo.insertLayer({
    id: crypto.randomUUID(),
    type: 'project',
    slug: 'layer-a',
    name: 'Layer A',
    now,
  });
  const layerB = layersRepo.insertLayer({
    id: crypto.randomUUID(),
    type: 'project',
    slug: 'layer-b',
    name: 'Layer B',
    now,
  });
  // The per-kind `companies` table has a FK on `users(id)` for
  // `created_by`/`updated_by`; seed a real user so the entity-store
  // create() doesn't trip the FK.
  const user = usersRepo.createUser({
    id: crypto.randomUUID(),
    username: 'tester',
    displayName: 'Tester',
    passwordHash: 'h',
    mustChangePassword: false,
    now,
  });
  return {
    dir,
    db,
    bus: new InMemoryMessageBus(),
    layerAId: layerA.id,
    layerBId: layerB.id,
    userId: user.id,
  };
}

function closeFixture(fx: Fixture): void {
  fx.db.close();
  try {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function fakeOpenAiEmbedder(map: Readonly<Record<string, readonly number[]>>): Embedder {
  return {
    id: 'openai:test',
    dimensions: 4,
    async encode(text) {
      const vec = map[text.toLowerCase()] ?? [0, 0, 0, 0];
      const out = new Float32Array(4);
      for (let i = 0; i < 4; i += 1) out[i] = vec[i] ?? 0;
      return out;
    },
  };
}

/**
 * Mirrors the production orchestrator adapter at
 * `apps/server/src/http/router.ts` — runs the vector path first,
 * defensively re-checks the `layerIds` filter on every hit, drops
 * soft-deleted rows (overall.md §5 invariant 5), dehydrates IDs back
 * via the underlying store, and falls back to the SQLite LIKE path on
 * any null result. Inlined here so this regression test pins the
 * adapter contract WITHOUT mounting the full HTTP app.
 */
async function adapterSearch(opts: {
  readonly kind: string;
  readonly helper: VectorSearchHelper;
  readonly store: ReturnType<typeof createEntityStore<CompanyPayload>>;
  readonly layerIds: readonly string[];
  readonly term: string;
  readonly limit: number;
}): Promise<
  readonly {
    readonly id: string;
    readonly layerId: string;
    readonly title: string;
  }[]
> {
  const allowed = new Set(opts.layerIds);
  const hits = await opts.helper.searchByKind(opts.kind, opts.layerIds, opts.term, opts.limit);
  if (hits !== null) {
    const out: Array<{ id: string; layerId: string; title: string }> = [];
    for (const hit of hits) {
      if (!allowed.has(hit.layer_id)) continue; // defensive
      const entity = opts.store.getById(hit.id);
      if (entity === null) continue;
      // Soft-delete invisibility — mirrors the LIKE path's
      // `WHERE deleted_at IS NULL` clause; the vector path would
      // otherwise surface a tombstoned row whose LanceDB row had not
      // yet been removed by the embedding subscriber.
      if (entity.meta.deletedAt !== null) continue;
      out.push({ id: entity.id, layerId: entity.layerId, title: entity.title });
    }
    return out;
  }
  // LIKE fallback.
  const rows = opts.store.searchSummaries(opts.layerIds, opts.term, { limit: opts.limit });
  return rows.map((r) => ({ id: r.id, layerId: r.layerId, title: r.title }));
}

describe('phase 7.1 — retrieval auth boundary', () => {
  let fx: Fixture;
  let writer: LanceWriter;
  let store: ReturnType<typeof createEntityStore<CompanyPayload>>;
  let visibleId: string;
  let hiddenId: string;

  beforeEach(async () => {
    fx = newFixture();
    writer = createInMemoryLanceWriter();
    store = createEntityStore<CompanyPayload>({
      module: companyModule(),
      db: fx.db,
      bus: fx.bus,
      // Retrieval never touches the LLM — a sentinel client is fine.
      llm: {
        endpoint: 'mock://retrieval-auth',
        defaultModel: 'mock-default',
        chat: async () => {
          throw new Error('llm.chat must not run on a retrieval-only path');
        },
      },
    });

    // Two companies sharing the search term. Layer A is the caller's
    // visible layer; layer B is the cross-layer row the auth boundary
    // must hide.
    const visible = await store.create({
      layerId: fx.layerAId,
      slug: 'visible',
      title: 'Visible Corp',
      originalLocale: 'en',
      payload: { name: 'shared keyword visible' },
      actorId: fx.userId,
    });
    visibleId = visible.id;
    const hidden = await store.create({
      layerId: fx.layerBId,
      slug: 'hidden',
      title: 'Hidden Corp',
      originalLocale: 'en',
      payload: { name: 'shared keyword hidden' },
      actorId: fx.userId,
    });
    hiddenId = hidden.id;

    // Seed BOTH rows into the LanceDB table. The hidden row gets the
    // closer vector — if the pre-filter ever fails, the vector path
    // would rank the cross-layer row first and surface it.
    const table = ENTITY_KIND_TO_LANCE_TABLE['company'] as string;
    await writer.upsert(table, {
      id: visibleId,
      layer_id: fx.layerAId,
      kind: 'company',
      slug: 'visible',
      text: 'shared keyword visible',
      vector: new Float32Array([0.2, 0.9, 0, 0]),
    });
    await writer.upsert(table, {
      id: hiddenId,
      layer_id: fx.layerBId,
      kind: 'company',
      slug: 'hidden',
      // EXACTLY the query vector — would dominate any post-filter.
      text: 'shared keyword hidden',
      vector: new Float32Array([1, 0, 0, 0]),
    });
  });

  afterEach(() => {
    closeFixture(fx);
  });

  it('vector path: only the layer-A row is returned even though the layer-B vector is closer', async () => {
    const helper = createVectorSearch({
      embedder: fakeOpenAiEmbedder({ shared: [1, 0, 0, 0] }),
      reader: writer,
      logger: { info: () => undefined, warn: () => undefined },
    });

    const rows = await adapterSearch({
      kind: 'company',
      helper,
      store,
      layerIds: [fx.layerAId],
      term: 'shared',
      limit: 5,
    });

    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe(visibleId);
    expect(rows[0]?.layerId).toBe(fx.layerAId);
    // Pin that the vector path is what ran (no fallback).
    expect(helper.lastFallbackReason('company')).toBeNull();
    // Hidden row never appears regardless of how the result is read.
    expect(rows.some((r) => r.id === hiddenId)).toBe(false);
  });

  it('vector path: a soft-deleted entity with a stale LanceDB row stays hidden (overall §5 invariant 5)', async () => {
    // Soft-delete the visible row in the SQLite primary store. The
    // LanceDB row is intentionally NOT removed — production removes
    // it via the embedding subscriber, but the durable bus's
    // at-least-once delivery leaves a race window we must close
    // adapter-side. The vector helper still hands the (stale) hit to
    // the adapter; the adapter must drop it.
    await store.softDelete({ id: visibleId, actorId: fx.userId });

    const helper = createVectorSearch({
      embedder: fakeOpenAiEmbedder({ shared: [0.2, 0.9, 0, 0] }),
      reader: writer,
      logger: { info: () => undefined, warn: () => undefined },
    });

    const rows = await adapterSearch({
      kind: 'company',
      helper,
      store,
      layerIds: [fx.layerAId],
      term: 'shared',
      limit: 5,
    });

    expect(rows.length).toBe(0);
    expect(helper.lastFallbackReason('company')).toBeNull(); // vector path ran
  });

  it('LIKE fallback: same boundary holds when the MockEmbedder forces the fallback path', async () => {
    const helper = createVectorSearch({
      embedder: createMockEmbedder(),
      reader: writer,
      logger: { info: () => undefined, warn: () => undefined },
    });

    const rows = await adapterSearch({
      kind: 'company',
      helper,
      store,
      layerIds: [fx.layerAId],
      term: 'shared',
      limit: 5,
    });

    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe(visibleId);
    expect(rows[0]?.layerId).toBe(fx.layerAId);
    // Pin that the LIKE fallback is what ran.
    expect(helper.lastFallbackReason('company')).toBe('mock-embedder');
    expect(rows.some((r) => r.id === hiddenId)).toBe(false);
  });
});
