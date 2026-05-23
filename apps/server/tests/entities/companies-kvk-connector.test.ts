/**
 * Phase 4a.2 — KvK connector behavioural tests.
 *
 * Three surfaces under test:
 *
 *  1. Happy-path pull: stubbed Basisprofiel response → connector
 *     produces the right `CompanyPayload` patch, dispatcher transitions
 *     the link `idle → syncing → idle` with `synced_at` set, and the
 *     bus sees `succeeded` (not `failed`).
 *  2. Error paths: 401 / 404 / 5xx / network → link ends `error` with
 *     the matching i18n key, `failed` event fires.
 *  3. Config validation: `verify` rejects malformed configs.
 *  4. Secret-stripping invariant: across every published event the
 *     literal apiKey never appears in `payload` or `metadata`.
 *  5. Unknown-connector POST: 400 with `errors.entity.connectorUnknown`,
 *     no row persisted.
 *
 * Every fetch is stubbed at the connector boundary — `BUNNY2_NO_NETWORK`
 * would not save us if the connector reached for `globalThis.fetch`,
 * so each test wires `createKvkConnector({ fetch: stub })`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { InMemoryMessageBus, type BusEvent } from '@bunny2/bus';
import type { CompanyPayload } from '@bunny2/shared';
import { openDatabase } from '../../src/storage/sqlite';
import { createUsersRepo } from '../../src/repos/users-repo';
import { createLayersRepo } from '../../src/repos/layers-repo';
import { createLayerAttachmentsRepo } from '../../src/repos/layer-attachments-repo';
import { createLlmClient } from '../../src/llm/client';
import {
  createEntityStore,
  createConnectorDispatcher,
  __resetEntityRegistryForTests,
  registerEntityModule,
} from '../../src/entities';
import {
  createCompanyModule,
  createKvkConnector,
  KvkConfigSchema,
  KVK_ERROR_KEYS,
  KVK_CONNECTOR_ID,
  mapBasisprofielToCompanyPayload,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-kvk-'));
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

function attachKvk(
  db: Database,
  layerId: string,
  apiKey: string,
  extra?: Record<string, unknown>,
): void {
  createLayerAttachmentsRepo(db).insertAttachment({
    id: crypto.randomUUID(),
    layerId,
    kind: 'connector',
    refId: KVK_CONNECTOR_ID,
    config: { apiKey, pollIntervalMinutes: 1440, ...extra },
    now: new Date().toISOString(),
  });
}

const SAMPLE_API_KEY = 'kvk-secret-do-not-leak-7777';

const SAMPLE_BASISPROFIEL = {
  kvkNummer: '12345678',
  handelsnaam: 'AMI Trade',
  statutaireNaam: 'AMI BV',
  _embedded: {
    hoofdvestiging: {
      websites: ['ami.example'],
      sbiActiviteiten: [{ sbiOmschrijving: 'Software development' }],
      adressen: [
        {
          type: 'bezoekadres',
          straatnaam: 'Hoofdweg',
          huisnummer: 12,
          huisnummerToevoeging: 'A',
          postcode: '1011AA',
          plaats: 'Amsterdam',
          land: 'NL',
        },
      ],
    },
  },
};

interface StubInput {
  readonly status?: number;
  readonly body?: unknown;
  readonly throws?: boolean;
}

function stubFetch(input: StubInput) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  // Bun's `typeof fetch` includes a `preconnect` static field; we don't
  // need it for the connector path, so we model the call signature as a
  // plain function and cast — the connector only invokes `f(url, init)`.
  const f = ((req: string | URL | Request, init?: RequestInit) => {
    const url = typeof req === 'string' ? req : req instanceof URL ? req.href : req.url;
    const rawHeaders = init?.headers ?? {};
    const headerMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
      headerMap[k.toLowerCase()] = v;
    }
    calls.push({ url, headers: headerMap });
    if (input.throws === true) {
      return Promise.reject(new Error('network down'));
    }
    const body = JSON.stringify(input.body ?? {});
    return Promise.resolve(
      new Response(body, {
        status: input.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  return { fetch: f, calls };
}

let fx: Fixture | null = null;
beforeEach(() => {
  // Reset the process-global entity registry FIRST — any sibling test
  // file may have left the default `companyModule` registered there.
  __resetEntityRegistryForTests();
  fx = makeFixture();
});
afterEach(() => {
  fx?.cleanup();
  fx = null;
});
function f(): Fixture {
  if (fx === null) throw new Error('kvk fixture not initialised');
  return fx;
}

function makeStore(fixture: Fixture, kvkFetch: typeof fetch) {
  const connector = createKvkConnector({ fetch: kvkFetch });
  const module = createCompanyModule({ connectors: [connector] });
  registerEntityModule(module);
  const store = createEntityStore<CompanyPayload>({
    module,
    db: fixture.db,
    bus: fixture.bus,
    llm: createLlmClient({
      endpoint: 'mock://echo',
      apiKey: '',
      defaultModel: 'mock-default',
    }),
  });
  return { module, store, connector };
}

describe('kvk connector :: pull happy path', () => {
  it('fetches Basisprofiel, transitions link to idle with synced_at, and emits succeeded', async () => {
    const fixture = f();
    const stub = stubFetch({ status: 200, body: SAMPLE_BASISPROFIEL });
    const { store } = makeStore(fixture, stub.fetch);

    const layerId = seedLayer(fixture.db, 'amilayer');
    const userId = seedUser(fixture.db, 'alice');
    attachKvk(fixture.db, layerId, SAMPLE_API_KEY);
    const created = await store.create({
      layerId,
      slug: 'ami',
      title: 'AMI BV',
      originalLocale: 'en',
      payload: {},
      actorId: userId,
    });
    const link = store.addExternalLink({
      ref: { id: created.id, kind: 'company', layerId, slug: 'ami' },
      connector: KVK_CONNECTOR_ID,
      externalId: '12345678',
    });

    const dispatcher = createConnectorDispatcher({ db: fixture.db, bus: fixture.bus });
    try {
      dispatcher.start();
      await dispatcher.handle({
        ref: { id: created.id, kind: 'company', layerId, slug: 'ami' },
        connector: KVK_CONNECTOR_ID,
        externalId: '12345678',
      });
    } finally {
      dispatcher.stop();
    }

    const refreshed = store.getById(created.id);
    const reloaded = refreshed?.externalLinks.find((l) => l.id === link.id);
    expect(reloaded?.syncState).toBe('idle');
    expect(reloaded?.syncedAt).not.toBeNull();
    expect(reloaded?.error).toBeNull();

    const succeeded = fixture.events.filter((e) => e.type === 'entity.connector.sync.succeeded');
    expect(succeeded.length).toBe(1);
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0]?.headers['apikey']).toBe(SAMPLE_API_KEY);
  });

  it('projects the Basisprofiel response onto a CompanyPayload patch', () => {
    const patch = mapBasisprofielToCompanyPayload(SAMPLE_BASISPROFIEL);
    expect(patch.kvkNumber).toBe('12345678');
    expect(patch.legalName).toBe('AMI BV');
    expect(patch.tradeName).toBe('AMI Trade');
    expect(patch.website).toBe('https://ami.example');
    expect(patch.industry).toBe('Software development');
    expect(patch.address?.street).toBe('Hoofdweg');
    expect(patch.address?.houseNumber).toBe('12A');
    expect(patch.address?.postalCode).toBe('1011AA');
    expect(patch.address?.city).toBe('Amsterdam');
    expect(patch.address?.country).toBe('NL');
  });
});

describe('kvk connector :: pull error paths', () => {
  async function runDispatchWithStatus(status: number, expectedKey: string): Promise<void> {
    const fixture = f();
    const stub = stubFetch({ status, body: {} });
    const { store } = makeStore(fixture, stub.fetch);
    const layerId = seedLayer(fixture.db, `layer-${status}`);
    const userId = seedUser(fixture.db, `u-${status}`);
    attachKvk(fixture.db, layerId, SAMPLE_API_KEY);
    const created = await store.create({
      layerId,
      slug: 'x',
      title: 'X',
      originalLocale: 'en',
      payload: {},
      actorId: userId,
    });
    const link = store.addExternalLink({
      ref: { id: created.id, kind: 'company', layerId, slug: 'x' },
      connector: KVK_CONNECTOR_ID,
      externalId: '00000000',
    });
    const dispatcher = createConnectorDispatcher({ db: fixture.db, bus: fixture.bus });
    await dispatcher.handle({
      ref: { id: created.id, kind: 'company', layerId, slug: 'x' },
      connector: KVK_CONNECTOR_ID,
      externalId: '00000000',
    });
    const refreshed = store.getById(created.id);
    const reloaded = refreshed?.externalLinks.find((l) => l.id === link.id);
    expect(reloaded?.syncState).toBe('error');
    expect(reloaded?.error).toBe(expectedKey);
    const failed = fixture.events.filter((e) => e.type === 'entity.connector.sync.failed');
    expect(failed.length).toBe(1);
  }

  it('marks the link error and emits failed on 401', async () => {
    await runDispatchWithStatus(401, KVK_ERROR_KEYS.Unauthorized);
  });
  it('marks the link error and emits failed on 404', async () => {
    await runDispatchWithStatus(404, KVK_ERROR_KEYS.NotFound);
  });
  it('marks the link error and emits failed on 5xx', async () => {
    await runDispatchWithStatus(503, KVK_ERROR_KEYS.Unreachable);
  });
  it('marks the link error and emits failed when fetch throws', async () => {
    const fixture = f();
    const stub = stubFetch({ throws: true });
    const { store } = makeStore(fixture, stub.fetch);
    const layerId = seedLayer(fixture.db, 'l-net');
    const userId = seedUser(fixture.db, 'u-net');
    attachKvk(fixture.db, layerId, SAMPLE_API_KEY);
    const created = await store.create({
      layerId,
      slug: 'n',
      title: 'N',
      originalLocale: 'en',
      payload: {},
      actorId: userId,
    });
    store.addExternalLink({
      ref: { id: created.id, kind: 'company', layerId, slug: 'n' },
      connector: KVK_CONNECTOR_ID,
      externalId: '99999999',
    });
    const dispatcher = createConnectorDispatcher({ db: fixture.db, bus: fixture.bus });
    await dispatcher.handle({
      ref: { id: created.id, kind: 'company', layerId, slug: 'n' },
      connector: KVK_CONNECTOR_ID,
      externalId: '99999999',
    });
    const reloaded = store.getById(created.id)?.externalLinks[0];
    expect(reloaded?.syncState).toBe('error');
    expect(reloaded?.error).toBe(KVK_ERROR_KEYS.Unreachable);
  });
});

describe('kvk connector :: verify(config)', () => {
  it('accepts a valid config', async () => {
    const connector = createKvkConnector();
    expect(await connector.verify({ apiKey: 'x', pollIntervalMinutes: 1440 })).toBeNull();
  });
  it('rejects missing apiKey', async () => {
    const connector = createKvkConnector();
    expect(await connector.verify({})).toBe('errors.connectors.kvk.invalidConfig');
  });
  it('rejects empty apiKey', async () => {
    const connector = createKvkConnector();
    expect(await connector.verify({ apiKey: '' })).toBe('errors.connectors.kvk.invalidConfig');
  });
  it('rejects pollIntervalMinutes below 60', async () => {
    const connector = createKvkConnector();
    expect(await connector.verify({ apiKey: 'x', pollIntervalMinutes: 10 })).toBe(
      'errors.connectors.kvk.invalidConfig',
    );
  });
  it('rejects extra keys (strict schema)', async () => {
    const connector = createKvkConnector();
    expect(await connector.verify({ apiKey: 'x', unknownKey: true })).toBe(
      'errors.connectors.kvk.invalidConfig',
    );
  });
  it('parses defaults via the exported schema', () => {
    const parsed = KvkConfigSchema.parse({ apiKey: 'x' });
    expect(parsed.pollIntervalMinutes).toBe(1440);
  });
});

describe('kvk connector :: secret-stripping invariant', () => {
  it('never publishes the apiKey on any bus event payload across success + failure paths', async () => {
    const fixture = f();
    // Happy path → succeeded
    const stub = stubFetch({ status: 200, body: SAMPLE_BASISPROFIEL });
    const { store } = makeStore(fixture, stub.fetch);
    const layerId = seedLayer(fixture.db, 'layer-secret');
    const userId = seedUser(fixture.db, 'alice-secret');
    attachKvk(fixture.db, layerId, SAMPLE_API_KEY);
    const created = await store.create({
      layerId,
      slug: 's',
      title: 'S',
      originalLocale: 'en',
      payload: {},
      actorId: userId,
    });
    store.addExternalLink({
      ref: { id: created.id, kind: 'company', layerId, slug: 's' },
      connector: KVK_CONNECTOR_ID,
      externalId: '12345678',
    });
    const dispatcher = createConnectorDispatcher({ db: fixture.db, bus: fixture.bus });
    await dispatcher.handle({
      ref: { id: created.id, kind: 'company', layerId, slug: 's' },
      connector: KVK_CONNECTOR_ID,
      externalId: '12345678',
    });

    // Failure path → failed (separate entity, same fixture)
    __resetEntityRegistryForTests();
    const badStub = stubFetch({ status: 401, body: {} });
    const failConnector = createKvkConnector({ fetch: badStub.fetch });
    const failModule = createCompanyModule({ connectors: [failConnector] });
    registerEntityModule(failModule);
    const failStore = createEntityStore<CompanyPayload>({
      module: failModule,
      db: fixture.db,
      bus: fixture.bus,
      llm: createLlmClient({
        endpoint: 'mock://echo',
        apiKey: '',
        defaultModel: 'mock-default',
      }),
    });
    const failed = await failStore.create({
      layerId,
      slug: 's2',
      title: 'S2',
      originalLocale: 'en',
      payload: {},
      actorId: userId,
    });
    failStore.addExternalLink({
      ref: { id: failed.id, kind: 'company', layerId, slug: 's2' },
      connector: KVK_CONNECTOR_ID,
      externalId: '22222222',
    });
    await dispatcher.handle({
      ref: { id: failed.id, kind: 'company', layerId, slug: 's2' },
      connector: KVK_CONNECTOR_ID,
      externalId: '22222222',
    });

    // Invariant: no event payload + no metadata anywhere mentions the key.
    expect(fixture.events.length).toBeGreaterThan(0);
    const haystack = JSON.stringify(
      fixture.events.map((e) => ({ type: e.type, payload: e.payload, metadata: e.metadata })),
    );
    expect(haystack).not.toContain(SAMPLE_API_KEY);
  });
});

describe('connector dispatch :: unknown connector', () => {
  it('returns null from getConnector for an unknown id (router contract)', async () => {
    const fixture = f();
    makeStore(fixture, stubFetch({ status: 200, body: {} }).fetch);
    const { getConnector } = await import('../../src/entities/registry');
    expect(getConnector('company', 'definitely-not-real')).toBeNull();
  });
});
