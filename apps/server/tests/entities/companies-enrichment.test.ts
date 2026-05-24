/**
 * Phase 4a.3 — companies AI enrichment behavioral tests.
 *
 * Surfaces under test:
 *   1. `entity.company.created` triggers `companies.summary`. The
 *      generated description lands on the row; `entity.enrichment.
 *      succeeded` carries token + cost numbers.
 *   2. `entity.connector.sync.succeeded` for a KvK link triggers
 *      `companies.fillFields`. The patch applies and version bumps.
 *   3. An LLM that throws is surfaced as `entity.enrichment.failed`
 *      with no payload change and no version bump.
 *   4. Secret-strip invariant: configure a KvK link with a known
 *      apiKey; assert the LLM is NOT called with that string anywhere
 *      in the prompt (the dispatcher persists only the scrubbed patch).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { type BusEvent } from '@bunny2/bus';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import type { CompanyPayload } from '@bunny2/shared';
import { openDatabase } from '../../src/storage/sqlite';
import { createUsersRepo } from '../../src/repos/users-repo';
import { createLayersRepo } from '../../src/repos/layers-repo';
import { createLayerAttachmentsRepo } from '../../src/repos/layer-attachments-repo';
import type { ChatRequest, ChatResponse, LlmClient } from '../../src/llm';
import {
  __resetEntityRegistryForTests,
  createConnectorDispatcher,
  createEntityStore,
  createEnrichmentRunner,
  registerEntityModule,
  type EntityStore,
} from '../../src/entities';
import {
  createCompanyModule,
  createKvkConnector,
  KVK_CONNECTOR_ID,
} from '../../src/entities/companies';
import { safeRmSync } from '../_helpers/temp-dir';

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
  readonly events: ReadonlyArray<BusEvent>;
  cleanup(): void;
}

function makeFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-coenrich-'));
  const db = openDatabase(dir);
  const captured: BusEvent[] = [];
  const bus = new InMemoryMessageBus({
    middlewares: [
      async (event, next) => {
        captured.push(event);
        await next(event);
      },
    ],
  });
  return {
    dir,
    db,
    bus,
    events: captured,
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

function attachKvk(db: Database, layerId: string, apiKey: string): void {
  createLayerAttachmentsRepo(db).insertAttachment({
    id: crypto.randomUUID(),
    layerId,
    kind: 'connector',
    refId: KVK_CONNECTOR_ID,
    config: { apiKey, pollIntervalMinutes: 1440 },
    now: new Date().toISOString(),
  });
}

interface LlmStubOptions {
  readonly summary?: string;
  readonly fillFieldsJson?: string;
  readonly throwOn?: 'summary' | 'fillFields';
}

interface LlmStub {
  readonly llm: LlmClient;
  readonly calls: ReadonlyArray<{ flowId: string | undefined; messages: string }>;
}

function makeLlmStub(opts: LlmStubOptions = {}): LlmStub {
  const calls: { flowId: string | undefined; messages: string }[] = [];
  const llm: LlmClient = {
    endpoint: 'mock://stub',
    defaultModel: 'mock-default',
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const flowId = typeof req.metadata?.flowId === 'string' ? req.metadata.flowId : undefined;
      const messages = req.messages.map((m) => m.content).join('\n');
      calls.push({ flowId, messages });
      if (opts.throwOn === 'summary' && flowId === 'enrichment:companies.summary') {
        throw new Error('errors.entity.enrichment.failed');
      }
      if (opts.throwOn === 'fillFields' && flowId === 'enrichment:companies.fillFields') {
        throw new Error('errors.entity.enrichment.failed');
      }
      const content =
        flowId === 'enrichment:companies.fillFields'
          ? (opts.fillFieldsJson ?? '{}')
          : (opts.summary ?? 'A short summary.');
      return {
        id: crypto.randomUUID(),
        model: 'mock-default',
        content,
        tokensIn: 12,
        tokensOut: 7,
        raw: null,
      };
    },
  };
  return { llm, calls };
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
  if (fx === null) throw new Error('fixture missing');
  return fx;
}

function setup(stubFetch: typeof fetch | null, stub: LlmStub) {
  const fixture = f();
  const connector =
    stubFetch === null ? createKvkConnector() : createKvkConnector({ fetch: stubFetch });
  const module = createCompanyModule({ connectors: [connector] });
  registerEntityModule(module);
  const store = createEntityStore<CompanyPayload>({
    module,
    db: fixture.db,
    bus: fixture.bus,
    llm: stub.llm,
  });
  return { fixture, module, store, connector };
}

describe('companies enrichment :: summary on created', () => {
  it('runs companies.summary, sets payload.description, emits succeeded with token + cost numbers', async () => {
    const stub = makeLlmStub({ summary: 'AMI BV is a software company.' });
    const { fixture, store } = setup(null, stub);
    const layerId = seedLayer(fixture.db, 'sum');
    const userId = seedUser(fixture.db, 'sum-u');
    const runner = createEnrichmentRunner({
      db: fixture.db,
      bus: fixture.bus,
      llm: stub.llm,
      pricing: { 'mock-default': { inputPerMTokens: 2, outputPerMTokens: 4 } },
      resolveStore: () => store as EntityStore<unknown>,
    });
    runner.start();
    try {
      const created = await store.create({
        layerId,
        slug: 'ami',
        title: 'AMI BV',
        originalLocale: 'en',
        payload: {},
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = store.getById(created.id);
      expect(refreshed?.payload.description).toBe('AMI BV is a software company.');
      expect(refreshed?.meta.version).toBe(2);
      const succeeded = fixture.events.filter(
        (e) =>
          e.type === 'entity.enrichment.succeeded' &&
          (e.payload as { jobId: string }).jobId === 'companies.summary',
      );
      expect(succeeded.length).toBe(1);
      const sp = succeeded[0]?.payload as {
        tokensIn: number;
        tokensOut: number;
        costUsd: number | null;
        hasPatch: boolean;
      };
      expect(sp.tokensIn).toBe(12);
      expect(sp.tokensOut).toBe(7);
      expect(sp.hasPatch).toBe(true);
      expect(sp.costUsd).toBeCloseTo((12 * 2) / 1_000_000 + (7 * 4) / 1_000_000, 12);
    } finally {
      runner.stop();
    }
  });
});

describe('companies enrichment :: fillFields on sync.succeeded', () => {
  it('runs companies.fillFields after KvK pull and applies the patch with a version bump', async () => {
    const stub = makeLlmStub({
      fillFieldsJson: JSON.stringify({
        legalName: 'AMI BV',
        tradeName: 'AMI Trade',
        industry: 'Software development',
        description: null,
      }),
    });
    const SAMPLE_BASISPROFIEL = {
      kvkNummer: '12345678',
      handelsnaam: 'AMI Trade',
      statutaireNaam: 'AMI BV',
      _embedded: {
        hoofdvestiging: {
          websites: ['ami.example'],
          sbiActiviteiten: [{ sbiOmschrijving: 'Software development' }],
          adressen: [],
        },
      },
    };
    // stub KvK fetch
    const stubFetch = ((): typeof fetch => {
      const f = ((_req: string | URL | Request) => {
        return Promise.resolve(
          new Response(JSON.stringify(SAMPLE_BASISPROFIEL), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }) as typeof fetch;
      return f;
    })();
    const { fixture, store } = setup(stubFetch, stub);
    const layerId = seedLayer(fixture.db, 'ff');
    const userId = seedUser(fixture.db, 'ff-u');
    attachKvk(fixture.db, layerId, 'kvk-key');
    const runner = createEnrichmentRunner({
      db: fixture.db,
      bus: fixture.bus,
      llm: stub.llm,
      resolveStore: () => store as EntityStore<unknown>,
    });
    const dispatcher = createConnectorDispatcher({ db: fixture.db, bus: fixture.bus });
    runner.start();
    dispatcher.start();
    try {
      const created = await store.create({
        layerId,
        slug: 'ami-ff',
        title: 'AMI',
        originalLocale: 'en',
        payload: {},
        actorId: userId,
      });
      store.addExternalLink({
        ref: { id: created.id, kind: 'company', layerId, slug: 'ami-ff' },
        connector: KVK_CONNECTOR_ID,
        externalId: '12345678',
      });
      await dispatcher.handle({
        ref: { id: created.id, kind: 'company', layerId, slug: 'ami-ff' },
        connector: KVK_CONNECTOR_ID,
        externalId: '12345678',
      });
      // After dispatcher: the link payload now has lastPatch; the
      // bus has fired `sync.succeeded`. tickOnce runs the runner.
      await runner.tickOnce();
      const refreshed = store.getById(created.id);
      expect(refreshed?.payload.legalName).toBe('AMI BV');
      expect(refreshed?.payload.tradeName).toBe('AMI Trade');
      expect(refreshed?.payload.industry).toBe('Software development');
      // Version: 1 (create) + 1 (one enrichment update — summary + fillFields
      // merge into one applied update when triggered in the same debounce)
      expect(refreshed?.meta.version).toBeGreaterThan(1);
      const fillSucceeded = fixture.events.filter(
        (e) =>
          e.type === 'entity.enrichment.succeeded' &&
          (e.payload as { jobId: string }).jobId === 'companies.fillFields',
      );
      expect(fillSucceeded.length).toBe(1);
    } finally {
      runner.stop();
      dispatcher.stop();
    }
  });
});

describe('companies enrichment :: LLM failure', () => {
  it('publishes entity.enrichment.failed and does not apply a patch when the LLM throws', async () => {
    const stub = makeLlmStub({ throwOn: 'summary' });
    const { fixture, store } = setup(null, stub);
    const layerId = seedLayer(fixture.db, 'lf');
    const userId = seedUser(fixture.db, 'lf-u');
    const runner = createEnrichmentRunner({
      db: fixture.db,
      bus: fixture.bus,
      llm: stub.llm,
      resolveStore: () => store as EntityStore<unknown>,
    });
    runner.start();
    try {
      const created = await store.create({
        layerId,
        slug: 'fail',
        title: 'Fail',
        originalLocale: 'en',
        payload: {},
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = store.getById(created.id);
      expect(refreshed?.payload.description).toBeUndefined();
      expect(refreshed?.meta.version).toBe(1);
      const failed = fixture.events.filter(
        (e) =>
          e.type === 'entity.enrichment.failed' &&
          (e.payload as { jobId: string }).jobId === 'companies.summary',
      );
      expect(failed.length).toBe(1);
      const fp = failed[0]?.payload as { error: string };
      expect(fp.error).toBe('errors.entity.enrichment.failed');
    } finally {
      runner.stop();
    }
  });
});

describe('companies enrichment :: secret-strip invariant', () => {
  it('never includes a configured KvK apiKey in any LLM prompt or any bus event', async () => {
    const SECRET = 'leak-canary-supersecret-xyz';
    const stub = makeLlmStub({
      summary: 'desc',
      fillFieldsJson: JSON.stringify({ industry: 'IT' }),
    });
    const SAMPLE_BASISPROFIEL = {
      kvkNummer: '11112222',
      handelsnaam: 'Z',
      statutaireNaam: 'Z BV',
      _embedded: {
        hoofdvestiging: {
          websites: ['z.example'],
          sbiActiviteiten: [{ sbiOmschrijving: 'IT' }],
          adressen: [],
        },
      },
    };
    const stubFetch = ((): typeof fetch => {
      const f = ((_req: string | URL | Request) => {
        return Promise.resolve(
          new Response(JSON.stringify(SAMPLE_BASISPROFIEL), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }) as typeof fetch;
      return f;
    })();
    const { fixture, store } = setup(stubFetch, stub);
    const layerId = seedLayer(fixture.db, 'sec');
    const userId = seedUser(fixture.db, 'sec-u');
    attachKvk(fixture.db, layerId, SECRET);
    const runner = createEnrichmentRunner({
      db: fixture.db,
      bus: fixture.bus,
      llm: stub.llm,
      resolveStore: () => store as EntityStore<unknown>,
    });
    const dispatcher = createConnectorDispatcher({ db: fixture.db, bus: fixture.bus });
    runner.start();
    dispatcher.start();
    try {
      const created = await store.create({
        layerId,
        slug: 'z',
        title: 'Z',
        originalLocale: 'en',
        payload: {},
        actorId: userId,
      });
      store.addExternalLink({
        ref: { id: created.id, kind: 'company', layerId, slug: 'z' },
        connector: KVK_CONNECTOR_ID,
        externalId: '11112222',
      });
      await dispatcher.handle({
        ref: { id: created.id, kind: 'company', layerId, slug: 'z' },
        connector: KVK_CONNECTOR_ID,
        externalId: '11112222',
      });
      await runner.tickOnce();
      // No LLM call message ever contains the apiKey.
      for (const call of stub.calls) {
        expect(call.messages).not.toContain(SECRET);
      }
      // No bus event payload contains the apiKey.
      const haystack = JSON.stringify(
        fixture.events.map((e) => ({ type: e.type, payload: e.payload, metadata: e.metadata })),
      );
      expect(haystack).not.toContain(SECRET);
    } finally {
      runner.stop();
      dispatcher.stop();
    }
  });
});
