/**
 * Phase 4a.3 — generic enrichment runner tests.
 *
 * The runner is foundation-shaped (no kind-specific code), so this test
 * drives it against a `FixtureEntityModule` whose payload is just
 * `{ title, body }`. Companies-specific behavior lives in
 * `companies-enrichment.test.ts`.
 *
 * Surfaces under test:
 *   1. Subscribes to `entity.<kind>.{created,updated}` for modules that
 *      declare `enrichmentJobs`; subscribes to
 *      `entity.connector.sync.succeeded` once.
 *   2. Debounces multiple events for the same entity into one job run.
 *   3. Applies non-null fields of `result.patch` via `store.update` and
 *      bumps `version`.
 *   4. Emits `entity.enrichment.{started,succeeded}` with
 *      tokensIn/tokensOut/costUsd.
 *   5. A job that throws → `entity.enrichment.failed`, no patch
 *      applied, no version bump, sibling jobs still run.
 *   6. Per-layer rate limit kicks in → `entity.enrichment.deferred`,
 *      LLM not called.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import { z } from 'zod';
import { InMemoryMessageBus, type BusEvent } from '@bunny2/bus';
import { openDatabase } from '../../src/storage/sqlite';
import { createUsersRepo } from '../../src/repos/users-repo';
import { createLayersRepo } from '../../src/repos/layers-repo';
import {
  __resetEntityRegistryForTests,
  createEntityStore,
  createEnrichmentRunner,
  registerEntityModule,
  type EnrichmentJob,
  type EntityModule,
  type EntityStore,
} from '../../src/entities';
import { createLlmClient } from '../../src/llm/client';
import type { ChatRequest, ChatResponse, LlmClient } from '../../src/llm';
import { safeRmSync } from '../_helpers/temp-dir';

const FixturePayloadSchema = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
});
type FixturePayload = z.infer<typeof FixturePayloadSchema>;

function buildFixtureModule(
  jobs: readonly EnrichmentJob<FixturePayload>[],
): EntityModule<FixturePayload> {
  return {
    kind: 'fixture',
    tableName: 'fixture_entities',
    payloadSchema: FixturePayloadSchema,
    enrichmentJobs: jobs,
    toSummary({ ref, meta, payload, title }) {
      return {
        ...ref,
        meta,
        title,
        subtitle: null,
        searchableText: `${title}\n${payload.body ?? ''}`,
      };
    },
    searchableText(payload) {
      return `${payload.title}\n${payload.body ?? ''}`;
    },
  };
}

function createFixtureTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fixture_entities (
      id              TEXT PRIMARY KEY,
      layer_id        TEXT NOT NULL REFERENCES layers(id),
      slug            TEXT NOT NULL,
      title           TEXT NOT NULL,
      searchable_text TEXT NOT NULL,
      original_locale TEXT NOT NULL,
      payload_json    TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      created_by      TEXT NOT NULL REFERENCES users(id),
      updated_at      TEXT NOT NULL,
      updated_by      TEXT NOT NULL REFERENCES users(id),
      deleted_at      TEXT,
      deleted_by      TEXT REFERENCES users(id),
      version         INTEGER NOT NULL DEFAULT 1,
      UNIQUE (layer_id, slug)
    );
  `);
}

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
  readonly events: ReadonlyArray<BusEvent>;
  readonly llm: LlmClient;
  cleanup(): void;
}

function makeFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-enrich-'));
  const db = openDatabase(dir);
  createFixtureTable(db);
  const captured: BusEvent[] = [];
  const bus = new InMemoryMessageBus({
    middlewares: [
      async (event, next) => {
        captured.push(event);
        await next(event);
      },
    ],
  });
  const llm = createLlmClient({
    endpoint: 'mock://echo',
    apiKey: '',
    defaultModel: 'mock-default',
  });
  return {
    dir,
    db,
    bus,
    events: captured,
    llm,
    cleanup() {
      __resetEntityRegistryForTests();
      try {
        db.close();
      } catch {
        /* already closed */
      }
      try {
        safeRmSync(dir);
      } catch {
        /* best effort */
      }
    },
  };
}

function seedUser(db: Database, username: string): string {
  const id = crypto.randomUUID();
  createUsersRepo(db).createUser({
    id,
    username,
    displayName: username,
    passwordHash: 'h',
    mustChangePassword: false,
    now: new Date().toISOString(),
  });
  return id;
}

function seedLayer(db: Database, slug: string): string {
  const id = crypto.randomUUID();
  createLayersRepo(db).insertLayer({
    id,
    type: 'project',
    slug,
    name: slug,
    now: new Date().toISOString(),
  });
  return id;
}

let fx: Fixture | null = null;
beforeEach(() => {
  __resetEntityRegistryForTests();
  fx = makeFixture();
});
afterEach(() => {
  fx?.cleanup();
  fx = null;
});
function f(): Fixture {
  if (fx === null) throw new Error('enrichment fixture not initialised');
  return fx;
}

describe('enrichment runner :: subscribe + tickOnce', () => {
  it('runs an enrichment job on entity.<kind>.created and applies a non-null patch', async () => {
    const fixture = f();
    const job: EnrichmentJob<FixturePayload> = {
      id: 'fixture.bodyFill',
      runOn: ['created', 'updated'],
      async run(entity) {
        if (entity.payload.body !== undefined && entity.payload.body.length > 0) {
          return {};
        }
        return {
          patch: { body: 'generated body' },
          tokensIn: 10,
          tokensOut: 5,
          model: 'mock-default',
        };
      },
    };
    const module = buildFixtureModule([job]);
    registerEntityModule(module);
    const store = createEntityStore<FixturePayload>({
      module,
      db: fixture.db,
      bus: fixture.bus,
      llm: fixture.llm,
    });
    const layerId = seedLayer(fixture.db, 'lx');
    const userId = seedUser(fixture.db, 'u');
    const runner = createEnrichmentRunner({
      db: fixture.db,
      bus: fixture.bus,
      llm: fixture.llm,
      pricing: { 'mock-default': { inputPerMTokens: 2, outputPerMTokens: 4 } },
      resolveStore: () => store as EntityStore<unknown>,
    });
    runner.start();
    try {
      const created = await store.create({
        layerId,
        slug: 'one',
        title: 'One',
        originalLocale: 'en',
        payload: { title: 'One' },
        actorId: userId,
      });
      const ran = await runner.tickOnce();
      expect(ran).toBe(1);
      const refreshed = store.getById(created.id);
      expect(refreshed?.payload.body).toBe('generated body');
      expect(refreshed?.meta.version).toBe(2);
      const succeeded = fixture.events.filter((e) => e.type === 'entity.enrichment.succeeded');
      expect(succeeded.length).toBe(1);
      const payload = succeeded[0]?.payload as {
        jobId: string;
        tokensIn: number;
        tokensOut: number;
        costUsd: number | null;
        hasPatch: boolean;
      };
      expect(payload.jobId).toBe('fixture.bodyFill');
      expect(payload.tokensIn).toBe(10);
      expect(payload.tokensOut).toBe(5);
      expect(payload.hasPatch).toBe(true);
      expect(payload.costUsd).toBeCloseTo((10 * 2) / 1_000_000 + (5 * 4) / 1_000_000, 12);
      const started = fixture.events.filter((e) => e.type === 'entity.enrichment.started');
      expect(started.length).toBe(1);
    } finally {
      runner.stop();
    }
  });

  it('debounces multiple events for the same entity into one run', async () => {
    const fixture = f();
    let runs = 0;
    const job: EnrichmentJob<FixturePayload> = {
      id: 'fixture.count',
      runOn: ['created', 'updated'],
      async run() {
        runs += 1;
        return {};
      },
    };
    const module = buildFixtureModule([job]);
    registerEntityModule(module);
    const store = createEntityStore<FixturePayload>({
      module,
      db: fixture.db,
      bus: fixture.bus,
      llm: fixture.llm,
    });
    const layerId = seedLayer(fixture.db, 'l');
    const userId = seedUser(fixture.db, 'u');
    const runner = createEnrichmentRunner({
      db: fixture.db,
      bus: fixture.bus,
      llm: fixture.llm,
      resolveStore: () => store as EntityStore<unknown>,
    });
    runner.start();
    try {
      const created = await store.create({
        layerId,
        slug: 'a',
        title: 'A',
        originalLocale: 'en',
        payload: { title: 'A' },
        actorId: userId,
      });
      // Three rapid updates within debounce window — should collapse to
      // a single run when tickOnce flushes.
      await store.update({ id: created.id, payload: { title: 'A', body: 'b1' }, actorId: userId });
      await store.update({ id: created.id, payload: { title: 'A', body: 'b2' }, actorId: userId });
      await store.update({ id: created.id, payload: { title: 'A', body: 'b3' }, actorId: userId });
      const ran = await runner.tickOnce();
      expect(ran).toBe(1);
      expect(runs).toBe(1);
    } finally {
      runner.stop();
    }
  });

  it('emits enrichment.failed and does not bump version when a job throws', async () => {
    const fixture = f();
    const job: EnrichmentJob<FixturePayload> = {
      id: 'fixture.fail',
      runOn: ['created'],
      async run() {
        throw new Error('errors.entity.enrichment.failed');
      },
    };
    const module = buildFixtureModule([job]);
    registerEntityModule(module);
    const store = createEntityStore<FixturePayload>({
      module,
      db: fixture.db,
      bus: fixture.bus,
      llm: fixture.llm,
    });
    const layerId = seedLayer(fixture.db, 'lf');
    const userId = seedUser(fixture.db, 'uf');
    const runner = createEnrichmentRunner({
      db: fixture.db,
      bus: fixture.bus,
      llm: fixture.llm,
      resolveStore: () => store as EntityStore<unknown>,
    });
    runner.start();
    try {
      const created = await store.create({
        layerId,
        slug: 'x',
        title: 'X',
        originalLocale: 'en',
        payload: { title: 'X' },
        actorId: userId,
      });
      await runner.tickOnce();
      const failed = fixture.events.filter((e) => e.type === 'entity.enrichment.failed');
      expect(failed.length).toBe(1);
      const payload = failed[0]?.payload as { error: string; jobId: string };
      expect(payload.error).toBe('errors.entity.enrichment.failed');
      expect(payload.jobId).toBe('fixture.fail');
      const refreshed = store.getById(created.id);
      expect(refreshed?.meta.version).toBe(1);
    } finally {
      runner.stop();
    }
  });

  it('skips fields the patch sets to null/undefined and refuses to overwrite non-empty user fields not listed in module.enrichmentOverwriteFields', async () => {
    const fixture = f();
    const job: EnrichmentJob<FixturePayload> = {
      id: 'fixture.respect',
      runOn: ['updated'],
      async run() {
        // Try to overwrite an already-set title — runner should refuse.
        return {
          patch: { title: 'WOULD-OVERWRITE', body: null as unknown as undefined },
        };
      },
    };
    const module = buildFixtureModule([job]);
    registerEntityModule(module);
    const store = createEntityStore<FixturePayload>({
      module,
      db: fixture.db,
      bus: fixture.bus,
      llm: fixture.llm,
    });
    const layerId = seedLayer(fixture.db, 'lr');
    const userId = seedUser(fixture.db, 'ur');
    const runner = createEnrichmentRunner({
      db: fixture.db,
      bus: fixture.bus,
      llm: fixture.llm,
      resolveStore: () => store as EntityStore<unknown>,
    });
    runner.start();
    try {
      const created = await store.create({
        layerId,
        slug: 'r',
        title: 'Original',
        originalLocale: 'en',
        payload: { title: 'Original', body: 'user body' },
        actorId: userId,
      });
      await store.update({
        id: created.id,
        payload: { title: 'Original', body: 'user body' },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = store.getById(created.id);
      expect(refreshed?.payload.title).toBe('Original');
      expect(refreshed?.payload.body).toBe('user body');
      // version is 2 (from store.update); enrichment did not bump.
      expect(refreshed?.meta.version).toBe(2);
      const succeeded = fixture.events.filter((e) => e.type === 'entity.enrichment.succeeded');
      expect(succeeded.length).toBe(1);
      expect((succeeded[0]?.payload as { hasPatch: boolean }).hasPatch).toBe(false);
    } finally {
      runner.stop();
    }
  });
});

describe('enrichment runner :: per-module enrichmentOverwriteFields slot', () => {
  it('overwrites a non-empty field listed in enrichmentOverwriteFields and protects fields not listed', async () => {
    const fixture = f();
    const job: EnrichmentJob<FixturePayload> = {
      id: 'fixture.overwriteSlot',
      runOn: ['updated'],
      async run() {
        return {
          patch: { title: 'NEW-TITLE', body: 'NEW-BODY' },
        };
      },
    };
    // Fixture module declares ONLY `body` as overrideable. `title` is
    // not listed → must stay protected when already non-empty.
    const module: EntityModule<FixturePayload> = {
      ...buildFixtureModule([job]),
      enrichmentOverwriteFields: ['body'],
    };
    registerEntityModule(module);
    const store = createEntityStore<FixturePayload>({
      module,
      db: fixture.db,
      bus: fixture.bus,
      llm: fixture.llm,
    });
    const layerId = seedLayer(fixture.db, 'lo');
    const userId = seedUser(fixture.db, 'lo-u');
    const runner = createEnrichmentRunner({
      db: fixture.db,
      bus: fixture.bus,
      llm: fixture.llm,
      resolveStore: () => store as EntityStore<unknown>,
    });
    runner.start();
    try {
      const created = await store.create({
        layerId,
        slug: 'o',
        title: 'OriginalTitle',
        originalLocale: 'en',
        payload: { title: 'OriginalTitle', body: 'OriginalBody' },
        actorId: userId,
      });
      await store.update({
        id: created.id,
        payload: { title: 'OriginalTitle', body: 'OriginalBody' },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = store.getById(created.id);
      expect(refreshed?.payload.title).toBe('OriginalTitle');
      // body was listed → overwritten.
      expect(refreshed?.payload.body).toBe('NEW-BODY');
    } finally {
      runner.stop();
    }
  });
});

describe('enrichment runner :: rate limit', () => {
  it('publishes entity.enrichment.deferred when the per-layer cap is hit and does not call the LLM', async () => {
    const fixture = f();
    let chatCalls = 0;
    const stubLlm: LlmClient = {
      endpoint: 'mock://stub',
      defaultModel: 'mock-default',
      async chat(_req: ChatRequest): Promise<ChatResponse> {
        chatCalls += 1;
        return {
          id: 'r',
          model: 'mock-default',
          content: '',
          tokensIn: 1,
          tokensOut: 1,
          raw: null,
        };
      },
    };
    const job: EnrichmentJob<FixturePayload> = {
      id: 'fixture.callLlm',
      runOn: ['created'],
      async run(_entity, ctx) {
        const res = await ctx.llm.chat({ messages: [{ role: 'user', content: 'x' }] });
        return {
          tokensIn: res.tokensIn,
          tokensOut: res.tokensOut,
          model: res.model,
        };
      },
    };
    const module = buildFixtureModule([job]);
    registerEntityModule(module);
    const store = createEntityStore<FixturePayload>({
      module,
      db: fixture.db,
      bus: fixture.bus,
      llm: stubLlm,
    });
    const layerId = seedLayer(fixture.db, 'rl');
    const userId = seedUser(fixture.db, 'rl-u');
    const runner = createEnrichmentRunner({
      db: fixture.db,
      bus: fixture.bus,
      llm: stubLlm,
      config: { maxRunsPerLayerPerMinute: 2 },
      resolveStore: () => store as EntityStore<unknown>,
    });
    runner.start();
    try {
      const a = await store.create({
        layerId,
        slug: 'a',
        title: 'A',
        originalLocale: 'en',
        payload: { title: 'A' },
        actorId: userId,
      });
      const b = await store.create({
        layerId,
        slug: 'b',
        title: 'B',
        originalLocale: 'en',
        payload: { title: 'B' },
        actorId: userId,
      });
      const c = await store.create({
        layerId,
        slug: 'c',
        title: 'C',
        originalLocale: 'en',
        payload: { title: 'C' },
        actorId: userId,
      });
      void a;
      void b;
      void c;
      await runner.tickOnce();
      const deferred = fixture.events.filter((e) => e.type === 'entity.enrichment.deferred');
      expect(deferred.length).toBeGreaterThanOrEqual(1);
      const succeeded = fixture.events.filter((e) => e.type === 'entity.enrichment.succeeded');
      // Cap of 2 → at most 2 LLM-backed runs succeed.
      expect(succeeded.length).toBeLessThanOrEqual(2);
      expect(chatCalls).toBeLessThanOrEqual(2);
    } finally {
      runner.stop();
    }
  });
});
