/**
 * Phase 6.2 — `chat.embeddings.backfill` scheduled-task handler.
 *
 * Pins the contract phase 7 depends on:
 *  - Encodes only entities not already represented in LanceDB
 *    (idempotency by id + text — re-running the handler against a
 *    fully-indexed corpus is a no-op).
 *  - Respects the `task.config.rateLimitPerMinute` knob.
 *  - Skips entities whose `searchableText` is empty (no noise rows).
 *  - The auth_tag (`layer_id`) round-trips from the seed into the
 *    LanceDB row.
 */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  createChatEmbeddingsBackfillHandler,
  type BackfillSummary,
} from '../src/chat/embeddings/backfill-handler';
import {
  createInMemoryLanceWriter,
  getLanceTableForKind,
} from '../src/chat/embeddings/lance-tables';
import { createMockEmbedder } from '../src/chat/embeddings/embedder';
import type { EntityModule } from '../src/entities';
import type { ScheduledTask, ScheduledTaskRun, ScheduledTaskRunContext } from '../src/scheduled';

function fakeModule(kind: string): EntityModule<unknown> {
  return {
    kind,
    tableName: `${kind}s_table`,
    payloadSchema: z.object({
      name: z.string(),
    }) as unknown as EntityModule<unknown>['payloadSchema'],
    toSummary({ ref, meta, payload, title }) {
      const name = (payload as { name?: string }).name ?? '';
      return {
        ...ref,
        meta,
        title,
        subtitle: null,
        searchableText: name,
      };
    },
    searchableText(payload) {
      return (payload as { name?: string }).name ?? '';
    },
  };
}

function fakeTask(config: Readonly<Record<string, unknown>> = {}): ScheduledTask {
  const now = new Date().toISOString();
  return {
    id: 'task-1',
    layerId: 'layer-system',
    slug: 'chat-embeddings-backfill',
    kind: 'chat.embeddings.backfill',
    name: 'Backfill',
    status: 'active',
    pauseReason: null,
    schedule: { kind: 'interval', intervalMinutes: 60 },
    config,
    maxAttempts: 1,
    backoffBaseMs: 1000,
    backoffMaxMs: 10_000,
    nextRunAt: now,
    lastRunAt: null,
    attempt: 0,
    claimedAt: null,
    claimedByPid: null,
    version: 1,
    createdAt: now,
    createdBy: 'admin',
    updatedAt: now,
    updatedBy: 'admin',
    deletedAt: null,
    deletedBy: null,
  };
}

function fakeRun(): ScheduledTaskRun {
  const now = new Date().toISOString();
  return {
    id: 'run-1',
    taskId: 'task-1',
    status: 'started',
    attempt: 1,
    triggeredBy: 'schedule',
    requestedAt: now,
    startedAt: now,
    finishedAt: null,
    durationMs: null,
    error: null,
    correlationId: 'cor-1',
  };
}

function ctxWith(task: ScheduledTask): ScheduledTaskRunContext {
  const logger = {
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
  };
  return {
    task,
    run: fakeRun(),
    correlationId: 'cor-1',
    now: () => new Date().toISOString(),
    // The handler we built does not read from `db` / `bus` / `llm` —
    // it goes through the injected `listSummaries` seam.
    db: null as never,
    bus: null as never,
    llm: null as never,
    logger,
  };
}

describe('phase 6.2 — chat.embeddings.backfill handler', () => {
  it('encodes only entities that are missing from LanceDB (idempotency by id + text)', async () => {
    const embedder = createMockEmbedder();
    const writer = createInMemoryLanceWriter();
    const seed: readonly BackfillSummary[] = [
      { id: 'co-1', layerId: 'L1', slug: 'co-1', searchableText: 'acme corp' },
      { id: 'co-2', layerId: 'L1', slug: 'co-2', searchableText: 'globex' },
    ];
    let encodes = 0;
    const trackedEmbedder = {
      ...embedder,
      async encode(text: string): Promise<Float32Array> {
        encodes += 1;
        return embedder.encode(text);
      },
    };
    const handler = createChatEmbeddingsBackfillHandler({
      embedder: trackedEmbedder,
      writer,
      listModules: () => [fakeModule('company')],
      listSummaries: () => seed,
      sleep: async () => undefined,
      listActiveLayerIds: () => ['L1', 'layer-A', 'layer-B'],
    });
    await handler.run(ctxWith(fakeTask()));
    expect(encodes).toBe(2);
    expect(await writer.countRows(getLanceTableForKind('company')!)).toBe(2);
    // Run a second time → zero new encodes.
    await handler.run(ctxWith(fakeTask()));
    expect(encodes).toBe(2);
    expect(await writer.countRows(getLanceTableForKind('company')!)).toBe(2);
  });

  it('preserves the auth_tag (layer_id) on the written row', async () => {
    const writer = createInMemoryLanceWriter();
    const handler = createChatEmbeddingsBackfillHandler({
      embedder: createMockEmbedder(),
      writer,
      listModules: () => [fakeModule('company')],
      listSummaries: () => [
        { id: 'co-A', layerId: 'layer-A', slug: 'co-A', searchableText: 'a' },
        { id: 'co-B', layerId: 'layer-B', slug: 'co-B', searchableText: 'b' },
      ],
      sleep: async () => undefined,
      listActiveLayerIds: () => ['L1', 'layer-A', 'layer-B'],
    });
    await handler.run(ctxWith(fakeTask()));
    const a = await writer.getById(getLanceTableForKind('company')!, 'co-A');
    const b = await writer.getById(getLanceTableForKind('company')!, 'co-B');
    expect(a?.layer_id).toBe('layer-A');
    expect(b?.layer_id).toBe('layer-B');
  });

  it('skips rows whose searchable_text is empty', async () => {
    const writer = createInMemoryLanceWriter();
    let encodes = 0;
    const embedder = createMockEmbedder();
    const tracked = {
      ...embedder,
      async encode(text: string): Promise<Float32Array> {
        encodes += 1;
        return embedder.encode(text);
      },
    };
    const handler = createChatEmbeddingsBackfillHandler({
      embedder: tracked,
      writer,
      listModules: () => [fakeModule('company')],
      listSummaries: () => [
        { id: 'co-1', layerId: 'L1', slug: 'co-1', searchableText: '' },
        { id: 'co-2', layerId: 'L1', slug: 'co-2', searchableText: 'globex' },
      ],
      sleep: async () => undefined,
      listActiveLayerIds: () => ['L1', 'layer-A', 'layer-B'],
    });
    await handler.run(ctxWith(fakeTask()));
    expect(encodes).toBe(1);
    expect(await writer.getById(getLanceTableForKind('company')!, 'co-1')).toBeNull();
    expect(await writer.getById(getLanceTableForKind('company')!, 'co-2')).not.toBeNull();
  });

  it('rate-limits via configurable rateLimitPerMinute', async () => {
    const writer = createInMemoryLanceWriter();
    const sleepCalls: number[] = [];
    const handler = createChatEmbeddingsBackfillHandler({
      embedder: createMockEmbedder(),
      writer,
      listModules: () => [fakeModule('company')],
      listSummaries: () => [
        { id: 'co-1', layerId: 'L1', slug: 'co-1', searchableText: 'a' },
        { id: 'co-2', layerId: 'L1', slug: 'co-2', searchableText: 'b' },
        { id: 'co-3', layerId: 'L1', slug: 'co-3', searchableText: 'c' },
      ],
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      listActiveLayerIds: () => ['L1'],
    });
    await handler.run(ctxWith(fakeTask({ rateLimitPerMinute: 60 })));
    expect(sleepCalls.length).toBe(3);
    // 60 per minute → 1000 ms between encodes.
    expect(sleepCalls[0]).toBe(1000);
    // Same shape with a different rate.
    sleepCalls.length = 0;
    // Reset writer state so the second run encodes again.
    const writer2 = createInMemoryLanceWriter();
    const handler2 = createChatEmbeddingsBackfillHandler({
      embedder: createMockEmbedder(),
      writer: writer2,
      listModules: () => [fakeModule('company')],
      listSummaries: () => [
        { id: 'co-1', layerId: 'L1', slug: 'co-1', searchableText: 'a' },
        { id: 'co-2', layerId: 'L1', slug: 'co-2', searchableText: 'b' },
      ],
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      listActiveLayerIds: () => ['L1'],
    });
    await handler2.run(ctxWith(fakeTask({ rateLimitPerMinute: 6000 })));
    expect(sleepCalls[0]).toBe(10);
  });

  it('only writes to tables for kinds in ENTITY_KIND_TO_LANCE_TABLE', async () => {
    const writer = createInMemoryLanceWriter();
    const handler = createChatEmbeddingsBackfillHandler({
      embedder: createMockEmbedder(),
      writer,
      listModules: () => [fakeModule('company'), fakeModule('unknown_kind')],
      listSummaries: (_db, module) =>
        module.kind === 'company'
          ? [{ id: 'co-1', layerId: 'L1', slug: 'co-1', searchableText: 'a' }]
          : [{ id: 'x-1', layerId: 'L1', slug: 'x-1', searchableText: 'x' }],
      sleep: async () => undefined,
      listActiveLayerIds: () => ['L1', 'layer-A', 'layer-B'],
    });
    await handler.run(ctxWith(fakeTask()));
    expect(await writer.countRows(getLanceTableForKind('company')!)).toBe(1);
    // No table was created for `unknown_kind` — there is no entry in
    // the lance-tables map.
  });

  it('re-encodes when the existing row has stale text (text-keyed idempotency)', async () => {
    const writer = createInMemoryLanceWriter();
    const embedder = createMockEmbedder();
    let encodes = 0;
    const tracked = {
      ...embedder,
      async encode(text: string): Promise<Float32Array> {
        encodes += 1;
        return embedder.encode(text);
      },
    };
    // Pre-seed the writer with an out-of-date row.
    await writer.upsert(getLanceTableForKind('company')!, {
      id: 'co-1',
      layer_id: 'L1',
      kind: 'company',
      slug: 'co-1',
      text: 'old text',
      vector: new Float32Array(32),
    });
    const handler = createChatEmbeddingsBackfillHandler({
      embedder: tracked,
      writer,
      listModules: () => [fakeModule('company')],
      listSummaries: () => [
        { id: 'co-1', layerId: 'L1', slug: 'co-1', searchableText: 'new text' },
      ],
      sleep: async () => undefined,
      listActiveLayerIds: () => ['L1', 'layer-A', 'layer-B'],
    });
    await handler.run(ctxWith(fakeTask()));
    expect(encodes).toBe(1);
    const row = await writer.getById(getLanceTableForKind('company')!, 'co-1');
    expect(row?.text).toBe('new text');
  });
});
