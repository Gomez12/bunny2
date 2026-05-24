/**
 * Phase 6.2 — entity-event → LanceDB write subscriber.
 *
 * Pins the contract the read path (phase 7) depends on:
 *  - `entity.<kind>.created` writes a row with `layer_id` set to the
 *    entity's authoritative layer (auth_tag invariant — ADR 0021).
 *  - The same event delivered twice yields ONE row (idempotency).
 *  - `entity.<kind>.deleted` (the only delete event we have today —
 *    it IS the soft-delete event; see `entities/store.ts:545`)
 *    removes the row.
 *  - `entity.<kind>.restored` re-creates the row by fetching the
 *    entity through the supplied `fetchEntity` shim.
 *  - The subscriber NEVER throws into the bus chain even when the
 *    embedder fails.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import { z } from 'zod';
import type { EntityRef } from '@bunny2/shared';
import {
  createEmbeddingSubscriber,
  type EmbeddingSubscriberDeps,
} from '../src/chat/embeddings/subscriber';
import {
  createInMemoryLanceWriter,
  ENTITY_KIND_TO_LANCE_TABLE,
  getLanceTableForKind,
} from '../src/chat/embeddings/lance-tables';
import { createMockEmbedder, type Embedder } from '../src/chat/embeddings/embedder';
import type { EntityModule } from '../src/entities';
import {
  entityEventType,
  type EntityCreatedPayload,
  type EntityDeletedPayload,
  type EntityRestoredPayload,
  type EntityUpdatedPayload,
} from '../src/entities';

/**
 * Stub `EntityModule` for `company`. We don't exercise the per-kind
 * store; the subscriber only needs `kind` for routing. The widened
 * `EntityModule<unknown>` shape sidesteps the contravariant
 * `payloadSchema` parameter under `exactOptionalPropertyTypes`.
 */
function companyModule(): EntityModule<unknown> {
  return {
    kind: 'company',
    tableName: 'companies',
    payloadSchema: z.object({ name: z.string() }) as unknown as EntityModule<unknown>['payloadSchema'],
    toSummary({ ref, meta, payload, title }) {
      const text = ((payload as { name?: string }).name ?? '').toLowerCase();
      return {
        ...ref,
        meta,
        title,
        subtitle: null,
        searchableText: text,
      };
    },
    searchableText(payload) {
      return ((payload as { name?: string }).name ?? '').toLowerCase();
    },
  };
}

function makeRef(layerId: string, id: string): EntityRef {
  return {
    id,
    kind: 'company',
    layerId,
    slug: id,
  };
}

interface SilentLogger {
  info: () => void;
  warn: () => void;
  error: () => void;
}

const silentLogger: SilentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('phase 6.2 — embedding subscriber', () => {
  let bus: InMemoryMessageBus;
  let writer: ReturnType<typeof createInMemoryLanceWriter>;
  let counters: { values: Map<string, number>; inc: (name: string, by?: number) => void };
  let embedder: Embedder;

  beforeEach(() => {
    bus = new InMemoryMessageBus();
    writer = createInMemoryLanceWriter();
    counters = {
      values: new Map<string, number>(),
      inc(name: string, by = 1) {
        counters.values.set(name, (counters.values.get(name) ?? 0) + by);
      },
    };
    embedder = createMockEmbedder();
  });

  afterEach(() => {
    // Nothing to clean — `InMemoryMessageBus` is GC'd; the writer is
    // a Map and goes with it.
  });

  function startSubscriber(
    fetchEntity: EmbeddingSubscriberDeps['fetchEntity'] = () => null,
  ): void {
    const sub = createEmbeddingSubscriber({
      bus,
      embedder,
      writer,
      modules: [companyModule()],
      fetchEntity,
      logger: silentLogger,
      counters,
    });
    sub.start();
  }

  it('writes a row with the entity layer_id on entity.<kind>.created (auth-tag invariant)', async () => {
    startSubscriber();
    const ref = makeRef('layer-A', 'entity-1');
    const created: EntityCreatedPayload = {
      ref,
      version: 1,
      originalLocale: 'en',
      searchableText: 'acme corp',
    };
    await bus.publish({ type: entityEventType('company', 'created'), payload: created });
    const row = await writer.getById(getLanceTableForKind('company')!, 'entity-1');
    expect(row).not.toBeNull();
    expect(row!.layer_id).toBe('layer-A');
    expect(row!.text).toBe('acme corp');
    expect(row!.kind).toBe('company');
    expect(row!.slug).toBe('entity-1');
    expect(row!.vector.length).toBe(embedder.dimensions);
  });

  it('writes exactly one row when the same created event is delivered twice (idempotency)', async () => {
    startSubscriber();
    const ref = makeRef('layer-A', 'entity-1');
    const created: EntityCreatedPayload = {
      ref,
      version: 1,
      originalLocale: 'en',
      searchableText: 'acme corp',
    };
    await bus.publish({ type: entityEventType('company', 'created'), payload: created });
    await bus.publish({ type: entityEventType('company', 'created'), payload: created });
    const count = await writer.countRows(getLanceTableForKind('company')!);
    expect(count).toBe(1);
  });

  it('replaces the row text on entity.<kind>.updated', async () => {
    startSubscriber();
    const ref = makeRef('layer-A', 'entity-1');
    await bus.publish({
      type: entityEventType('company', 'created'),
      payload: { ref, version: 1, originalLocale: 'en', searchableText: 'acme corp' },
    });
    const updated: EntityUpdatedPayload = {
      ref,
      version: 2,
      previousVersion: 1,
      searchableText: 'acme corp v2',
    };
    await bus.publish({ type: entityEventType('company', 'updated'), payload: updated });
    const row = await writer.getById(getLanceTableForKind('company')!, 'entity-1');
    expect(row?.text).toBe('acme corp v2');
    const count = await writer.countRows(getLanceTableForKind('company')!);
    expect(count).toBe(1);
  });

  it('removes the row on entity.<kind>.deleted (soft-delete is the only delete event today)', async () => {
    startSubscriber();
    const ref = makeRef('layer-A', 'entity-1');
    await bus.publish({
      type: entityEventType('company', 'created'),
      payload: { ref, version: 1, originalLocale: 'en', searchableText: 'acme corp' },
    });
    const deleted: EntityDeletedPayload = { ref, version: 2, deletedBy: 'user-1' };
    await bus.publish({ type: entityEventType('company', 'deleted'), payload: deleted });
    const row = await writer.getById(getLanceTableForKind('company')!, 'entity-1');
    expect(row).toBeNull();
    const count = await writer.countRows(getLanceTableForKind('company')!);
    expect(count).toBe(0);
  });

  it('re-creates the row on entity.<kind>.restored using fetchEntity', async () => {
    const ref = makeRef('layer-A', 'entity-1');
    startSubscriber(() => ({
      id: ref.id,
      layerId: ref.layerId,
      kind: 'company',
      slug: ref.slug,
      searchableText: 'restored corp',
    }));
    // Pre-populate by created → deleted, then restored should re-add.
    await bus.publish({
      type: entityEventType('company', 'created'),
      payload: { ref, version: 1, originalLocale: 'en', searchableText: 'acme corp' },
    });
    await bus.publish({
      type: entityEventType('company', 'deleted'),
      payload: { ref, version: 2, deletedBy: 'u' } satisfies EntityDeletedPayload,
    });
    expect(await writer.getById(getLanceTableForKind('company')!, 'entity-1')).toBeNull();

    const restored: EntityRestoredPayload = { ref, version: 3 };
    await bus.publish({ type: entityEventType('company', 'restored'), payload: restored });
    const row = await writer.getById(getLanceTableForKind('company')!, 'entity-1');
    expect(row).not.toBeNull();
    expect(row!.text).toBe('restored corp');
    expect(row!.layer_id).toBe('layer-A');
  });

  it('skips unknown entity kinds — no row written, no subscription registered', async () => {
    // No `mystery` module is registered, so the subscriber never
    // installs a handler for it. The event has nowhere to land.
    startSubscriber();
    const ref: EntityRef = {
      id: 'entity-x',
      kind: 'mystery',
      layerId: 'layer-A',
      slug: 'entity-x',
    };
    await bus.publish({
      type: entityEventType('mystery', 'created'),
      payload: { ref, version: 1, originalLocale: 'en', searchableText: 'whatever' },
    });
    // The known table stays empty; nothing was routed.
    for (const table of Object.values(ENTITY_KIND_TO_LANCE_TABLE)) {
      expect(await writer.countRows(table)).toBe(0);
    }
  });

  it('absorbs embedder failures without throwing into the bus chain', async () => {
    // Replace the embedder with a throwing one and start the
    // subscriber. The bus.publish call must not bubble the error;
    // the row simply doesn't land.
    embedder = {
      id: 'broken',
      dimensions: 4,
      encode: async () => {
        throw new Error('boom');
      },
    };
    startSubscriber();
    const ref = makeRef('layer-A', 'entity-1');
    await bus.publish({
      type: entityEventType('company', 'created'),
      payload: { ref, version: 1, originalLocale: 'en', searchableText: 'acme' },
    });
    const row = await writer.getById(getLanceTableForKind('company')!, 'entity-1');
    expect(row).toBeNull();
    expect(counters.values.get('chat.embeddings.upsert.failed') ?? 0).toBe(1);
  });

  it('does not leak layer_id across entities on the same kind', async () => {
    startSubscriber();
    await bus.publish({
      type: entityEventType('company', 'created'),
      payload: {
        ref: makeRef('layer-A', 'a-1'),
        version: 1,
        originalLocale: 'en',
        searchableText: 'a',
      },
    });
    await bus.publish({
      type: entityEventType('company', 'created'),
      payload: {
        ref: makeRef('layer-B', 'b-1'),
        version: 1,
        originalLocale: 'en',
        searchableText: 'b',
      },
    });
    const rowA = await writer.getById(getLanceTableForKind('company')!, 'a-1');
    const rowB = await writer.getById(getLanceTableForKind('company')!, 'b-1');
    expect(rowA?.layer_id).toBe('layer-A');
    expect(rowB?.layer_id).toBe('layer-B');
  });
});
