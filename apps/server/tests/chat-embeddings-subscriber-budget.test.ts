/**
 * Per-layer embedding budget — subscriber behaviour.
 *
 * Asserts that:
 *   - With no settings row, the subscriber's behaviour matches the
 *     phase-6 baseline (encode runs, spend row appears).
 *   - When the layer's daily cap is exceeded, the encode is SKIPPED
 *     (LanceDB row stays absent) and a `chat.embeddings.deferred`
 *     counter increments.
 *   - On a successful encode, `layer_embedding_spend.tokens_spent`
 *     increments by the chars/4 estimate.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import { z } from 'zod';
import { openDatabase } from '../src/storage/sqlite';
import { createLayersRepo } from '../src/repos/layers-repo';
import {
  createEmbeddingSubscriber,
} from '../src/chat/embeddings/subscriber';
import {
  createInMemoryLanceWriter,
  getLanceTableForKind,
} from '../src/chat/embeddings/lance-tables';
import { createMockEmbedder } from '../src/chat/embeddings/embedder';
import {
  createLayerChatSettingsRepo,
} from '../src/chat/repos/layer-chat-settings-repo';
import {
  createLayerEmbeddingSpendRepo,
  isoDay,
} from '../src/chat/repos/layer-embedding-spend-repo';
import type { EntityModule } from '../src/entities';
import { entityEventType, type EntityCreatedPayload } from '../src/entities';

const now = (): string => new Date().toISOString();

function companyModule(): EntityModule<unknown> {
  return {
    kind: 'company',
    tableName: 'companies',
    payloadSchema: z.object({ name: z.string() }) as unknown as EntityModule<unknown>['payloadSchema'],
    toSummary({ ref, meta, payload, title }) {
      const text = ((payload as { name?: string }).name ?? '').toLowerCase();
      return { ...ref, meta, title, subtitle: null, searchableText: text };
    },
    searchableText(payload) {
      return ((payload as { name?: string }).name ?? '').toLowerCase();
    },
  };
}

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly layerId: string;
  readonly bus: InMemoryMessageBus;
  readonly writer: ReturnType<typeof createInMemoryLanceWriter>;
  readonly counters: { values: Map<string, number>; inc: (name: string, by?: number) => void };
}

function mkFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-chat-embeddings-budget-'));
  const db = openDatabase(dir);
  const layer = createLayersRepo(db).insertLayer({
    id: crypto.randomUUID(),
    type: 'everyone',
    slug: 'everyone',
    name: 'Everyone',
    now: now(),
  });
  const counters = {
    values: new Map<string, number>(),
    inc(name: string, by = 1): void {
      counters.values.set(name, (counters.values.get(name) ?? 0) + by);
    },
  };
  return {
    dir,
    db,
    layerId: layer.id,
    bus: new InMemoryMessageBus(),
    writer: createInMemoryLanceWriter(),
    counters,
  };
}

function close(fx: Fixture): void {
  fx.db.close();
  try {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe('embedding subscriber — per-layer budget', () => {
  let fx: Fixture;
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

  beforeEach(() => {
    fx = mkFixture();
  });
  afterEach(() => {
    close(fx);
  });

  it('encodes and records spend when no cap is configured', async () => {
    const settingsRepo = createLayerChatSettingsRepo(fx.db);
    const spendRepo = createLayerEmbeddingSpendRepo(fx.db);

    const sub = createEmbeddingSubscriber({
      bus: fx.bus,
      embedder: createMockEmbedder(),
      writer: fx.writer,
      modules: [companyModule()],
      fetchEntity: () => null,
      settingsRepo,
      spendRepo,
      counters: fx.counters,
      logger: silent,
    });
    sub.start();

    const ref = { id: 'e1', kind: 'company', layerId: fx.layerId, slug: 'e1' };
    const payload: EntityCreatedPayload = {
      ref,
      version: 1,
      originalLocale: 'en',
      // 32 chars → ceil(32/4) = 8 tokens.
      searchableText: 'acme corporation in amsterdam ok',
    };
    await fx.bus.publish({ type: entityEventType('company', 'created'), payload });

    const row = await fx.writer.getById(getLanceTableForKind('company')!, 'e1');
    expect(row).not.toBeNull();
    expect(fx.counters.values.get('chat.embeddings.upsert.ok')).toBe(1);
    const day = isoDay(new Date());
    expect(spendRepo.getDayTokens(fx.layerId, day)).toBe(8);
    expect(fx.counters.values.get('embedding.tokens.spent')).toBe(8);
  });

  it('defers the encode when the daily cap is exceeded', async () => {
    const settingsRepo = createLayerChatSettingsRepo(fx.db);
    const spendRepo = createLayerEmbeddingSpendRepo(fx.db);

    // Daily cap = 4 tokens. The 8-token encode trips the gate.
    settingsRepo.upsert({
      layerId: fx.layerId,
      model: null,
      embeddingDailyCap: 4,
      embeddingMonthlyCap: null,
      now: now(),
    });

    const sub = createEmbeddingSubscriber({
      bus: fx.bus,
      embedder: createMockEmbedder(),
      writer: fx.writer,
      modules: [companyModule()],
      fetchEntity: () => null,
      settingsRepo,
      spendRepo,
      counters: fx.counters,
      logger: silent,
    });
    sub.start();

    const ref = { id: 'e1', kind: 'company', layerId: fx.layerId, slug: 'e1' };
    const payload: EntityCreatedPayload = {
      ref,
      version: 1,
      originalLocale: 'en',
      searchableText: 'acme corporation in amsterdam ok',
    };
    await fx.bus.publish({ type: entityEventType('company', 'created'), payload });

    // LanceDB row never landed.
    const row = await fx.writer.getById(getLanceTableForKind('company')!, 'e1');
    expect(row).toBeNull();
    expect(fx.counters.values.get('chat.embeddings.upsert.ok') ?? 0).toBe(0);
    expect(fx.counters.values.get('chat.embeddings.deferred')).toBe(1);
    // No spend is recorded on a deferred encode.
    const day = isoDay(new Date());
    expect(spendRepo.getDayTokens(fx.layerId, day)).toBe(0);
  });
});
