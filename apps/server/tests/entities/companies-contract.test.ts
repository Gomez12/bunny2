/**
 * Phase 4a.1 — runs the §4.0 reusable contract suite against the real
 * `companyModule` and the real `companies` table created by the
 * `0006_companies.sql` migration. No companies-specific hacks needed —
 * the suite is the same one the fixture module passes, parameterized
 * over a `CompanyPayload`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import type { CompanyPayload } from '@bunny2/shared';
import { openDatabase } from '../../src/storage/sqlite';
import { createUsersRepo } from '../../src/repos/users-repo';
import { createLayersRepo } from '../../src/repos/layers-repo';
import { createLayerLocalesRepo } from '../../src/repos/layer-locales-repo';
import { createLlmClient } from '../../src/llm/client';
import { createEntityStore, __resetEntityRegistryForTests } from '../../src/entities';
import { companyModule } from '../../src/entities/companies';
import { runEntityContractSuite } from '../entity-contract/suite';
import { safeRmSync } from '../_helpers/temp-dir';

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
  cleanup(): void;
}

function makeFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-companies-contract-'));
  const db = openDatabase(dir);
  const bus = new InMemoryMessageBus();
  return {
    dir,
    db,
    bus,
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

// ---------------------------------------------------------------------------
// Suite wiring — one fresh fixture per test (matches the fixture-module
// test pattern). The companies table comes from the real 0006 migration,
// not an inline `CREATE TABLE`.
// ---------------------------------------------------------------------------

interface SuiteState {
  fx: Fixture;
  store: ReturnType<typeof createEntityStore<CompanyPayload>>;
}

let suiteState: SuiteState | null = null;

beforeEach(() => {
  const fx = makeFixture();
  const store = createEntityStore<CompanyPayload>({
    module: companyModule,
    db: fx.db,
    bus: fx.bus,
    llm: createLlmClient({
      endpoint: 'mock://echo',
      apiKey: '',
      defaultModel: 'mock-default',
    }),
  });
  suiteState = { fx, store };
});

afterEach(() => {
  if (suiteState !== null) {
    suiteState.fx.cleanup();
    suiteState = null;
  }
});

function state(): SuiteState {
  if (suiteState === null) throw new Error('companies suite fixture not initialised');
  return suiteState;
}

runEntityContractSuite<CompanyPayload>({
  module: companyModule,
  get store() {
    return state().store;
  },
  get db() {
    return state().fx.db;
  },
  get bus() {
    return state().fx.bus;
  },
  createTwoLayers({ localesA, localesB, defaultLocaleA, defaultLocaleB }) {
    const s = state();
    const a = seedLayer(s.fx.db, `a-${crypto.randomUUID().slice(0, 6)}`);
    const b = seedLayer(s.fx.db, `b-${crypto.randomUUID().slice(0, 6)}`);
    const localesRepo = createLayerLocalesRepo(s.fx.db);
    const nowIso = new Date().toISOString();
    localesRepo.setLocales(a, localesA, defaultLocaleA, nowIso);
    localesRepo.setLocales(b, localesB, defaultLocaleB ?? localesB[0] ?? 'en', nowIso);
    return { layerAId: a, layerBId: b };
  },
  createUser(name) {
    return seedUser(state().fx.db, `${name}-${crypto.randomUUID().slice(0, 6)}`);
  },
  samplePayload(seed) {
    return {
      legalName: `Legal ${seed} BV`,
      tradeName: `Trade ${seed}`,
      kvkNumber: kvkNumberForSeed(seed),
      website: `https://example.com/${seed}`,
      address: {
        street: 'Hoofdweg',
        houseNumber: '1',
        postalCode: '1011AA',
        city: 'Amsterdam',
        country: 'NL',
      },
      phone: '+31201234567',
      email: `info+${seed.replace(/[^a-z0-9]/gi, '')}@example.com`,
      industry: 'software',
      description: `A sample company seeded with ${seed}.`,
    };
  },
  mutatePayload(payload, seed) {
    return {
      ...payload,
      description: `${payload.description ?? ''} :: ${seed}`,
    };
  },
});

// ---------------------------------------------------------------------------
// Per-kind indexed-column assertions. These are NOT part of the §4.0
// contract suite — they exercise the foundation tweak landed in 4a.1
// (EntityModule.indexedColumns) end-to-end against the real companies
// table.
// ---------------------------------------------------------------------------

describe('companies module :: indexed columns', () => {
  let fx: Fixture | null = null;
  afterEach(() => {
    if (fx !== null) {
      fx.cleanup();
      fx = null;
    }
  });

  it('writes kvk_number and website to the per-kind columns on create + update', async () => {
    fx = makeFixture();
    const layerId = seedLayer(fx.db, `c-${crypto.randomUUID().slice(0, 6)}`);
    const userId = seedUser(fx.db, `u-${crypto.randomUUID().slice(0, 6)}`);
    const store = createEntityStore<CompanyPayload>({
      module: companyModule,
      db: fx.db,
      bus: fx.bus,
      llm: createLlmClient({
        endpoint: 'mock://echo',
        apiKey: '',
        defaultModel: 'mock-default',
      }),
    });
    const created = await store.create({
      layerId,
      slug: 'ami-bv',
      title: 'AMI BV',
      originalLocale: 'en',
      payload: { kvkNumber: '12345678', website: 'https://ami.example' },
      actorId: userId,
    });

    const row = fx.db
      .query<
        { kvk_number: string | null; website: string | null },
        [string]
      >('SELECT kvk_number, website FROM companies WHERE id = ?')
      .get(created.id);
    expect(row).not.toBeNull();
    expect(row?.kvk_number).toBe('12345678');
    expect(row?.website).toBe('https://ami.example');

    await store.update({
      id: created.id,
      payload: { kvkNumber: '87654321', website: 'https://ami.example/new' },
      actorId: userId,
    });
    const rowAfter = fx.db
      .query<
        { kvk_number: string | null; website: string | null },
        [string]
      >('SELECT kvk_number, website FROM companies WHERE id = ?')
      .get(created.id);
    expect(rowAfter?.kvk_number).toBe('87654321');
    expect(rowAfter?.website).toBe('https://ami.example/new');

    // Clearing the payload fields writes NULL — sparse indexes (idx_companies_kvk)
    // depend on this.
    await store.update({
      id: created.id,
      payload: {},
      actorId: userId,
    });
    const rowCleared = fx.db
      .query<
        { kvk_number: string | null; website: string | null },
        [string]
      >('SELECT kvk_number, website FROM companies WHERE id = ?')
      .get(created.id);
    expect(rowCleared?.kvk_number).toBeNull();
    expect(rowCleared?.website).toBeNull();
  });
});

// `companyModule` is exported for inspection in higher-phase tests; assert
// the indexed-column declarations so a future refactor that accidentally
// drops one is caught here, not in production.
describe('companies module :: shape', () => {
  it('declares kvk_number and website as indexed columns', () => {
    const names = (companyModule.indexedColumns ?? []).map((c) => c.name).sort();
    expect(names).toEqual(['kvk_number', 'website']);
  });

  it('declares city and enrichmentLastRunAt as summary columns', () => {
    const ids = (companyModule.summaryColumns ?? []).map((c) => c.id).sort();
    expect(ids).toEqual(['city', 'enrichmentLastRunAt']);
  });
});

// ---------------------------------------------------------------------------
// companyModule.summaryColumns end-to-end — the §4.0 store projects city +
// enrichmentLastRunAt onto every list-summary `extras` object. The soul
// timestamp lookup is batched once per listing call (see
// `rowsToSummaries` in `apps/server/src/entities/store.ts`).
// ---------------------------------------------------------------------------

describe('companies module :: summary extras', () => {
  let fx: Fixture | null = null;
  afterEach(() => {
    if (fx !== null) {
      fx.cleanup();
      fx = null;
    }
  });

  it('projects city from payload.address.city and enrichmentLastRunAt from entity_souls.updated_at', async () => {
    fx = makeFixture();
    const layerId = seedLayer(fx.db, `e-${crypto.randomUUID().slice(0, 6)}`);
    const userId = seedUser(fx.db, `u-${crypto.randomUUID().slice(0, 6)}`);
    const store = createEntityStore<CompanyPayload>({
      module: companyModule,
      db: fx.db,
      bus: fx.bus,
      llm: createLlmClient({
        endpoint: 'mock://echo',
        apiKey: '',
        defaultModel: 'mock-default',
      }),
    });

    const withCity = await store.create({
      layerId,
      slug: 'with-city',
      title: 'With City',
      originalLocale: 'en',
      payload: {
        kvkNumber: kvkNumberForSeed('with-city'),
        address: { city: 'Rotterdam' },
      },
      actorId: userId,
    });
    const withoutCity = await store.create({
      layerId,
      slug: 'no-city',
      title: 'No City',
      originalLocale: 'en',
      payload: { kvkNumber: kvkNumberForSeed('no-city') },
      actorId: userId,
    });

    // Seed entity_souls for the WithCity row only — NoCity must
    // surface a null enrichmentLastRunAt.
    const soulIso = '2026-05-25T08:00:00.000Z';
    fx.db
      .query<unknown, [string, string, string, string]>(
        `INSERT INTO entity_souls (entity_id, entity_kind, memory_json, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(withCity.id, 'company', '{}', soulIso);

    const summaries = store.listSummaries([layerId]);
    const sorted = [...summaries].sort((a, b) => a.slug.localeCompare(b.slug));
    expect(sorted.length).toBe(2);

    const noCityRow = sorted.find((s) => s.slug === 'no-city');
    expect(noCityRow?.extras).toEqual({
      city: null,
      enrichmentLastRunAt: null,
    });
    const withCityRow = sorted.find((s) => s.slug === 'with-city');
    expect(withCityRow?.extras).toEqual({
      city: 'Rotterdam',
      enrichmentLastRunAt: soulIso,
    });
    // The unused withoutCity local satisfies eslint for the
    // soft-asserted "we created two rows above".
    expect(withoutCity.id).not.toBe(withCity.id);
  });
});

// Borrow a deterministic 8-digit KvK number from the seed string so the
// suite's UNIQUE (layer_id, slug) tests don't collide on kvkNumber too.
function kvkNumberForSeed(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return String(10_000_000 + (h % 90_000_000));
}
