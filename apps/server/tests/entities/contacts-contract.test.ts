/**
 * Phase 4b.1 — runs the §4.0 reusable contract suite against the real
 * `contactModule` and the real `contacts` table created by the
 * `0008_contacts.sql` migration. Mirrors `companies-contract.test.ts`
 * one-for-one: no kind-specific hacks; no foundation gaps. The fact
 * that 4b.1 needs zero new suite hooks is the empirical proof that the
 * §4.0 contract takes a clean second consumer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { InMemoryMessageBus } from '@bunny2/bus';
import type { ContactPayload } from '@bunny2/shared';
import { openDatabase } from '../../src/storage/sqlite';
import { createUsersRepo } from '../../src/repos/users-repo';
import { createLayersRepo } from '../../src/repos/layers-repo';
import { createLayerLocalesRepo } from '../../src/repos/layer-locales-repo';
import { createLlmClient } from '../../src/llm/client';
import { createEntityStore, __resetEntityRegistryForTests } from '../../src/entities';
import { contactModule } from '../../src/entities/contacts';
import { runEntityContractSuite } from '../entity-contract/suite';
import { safeRmSync } from '../_helpers/temp-dir';

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
  cleanup(): void;
}

function makeFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-contacts-contract-'));
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
// Suite wiring — one fresh fixture per test (matches the companies + fixture-
// module test pattern). The contacts table comes from the real 0008 migration,
// not an inline `CREATE TABLE`.
// ---------------------------------------------------------------------------

interface SuiteState {
  fx: Fixture;
  store: ReturnType<typeof createEntityStore<ContactPayload>>;
}

let suiteState: SuiteState | null = null;

beforeEach(() => {
  const fx = makeFixture();
  const store = createEntityStore<ContactPayload>({
    module: contactModule,
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
  if (suiteState === null) throw new Error('contacts suite fixture not initialised');
  return suiteState;
}

runEntityContractSuite<ContactPayload>({
  module: contactModule,
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
    const safe = seed.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'x';
    return {
      givenName: `Given ${seed}`,
      familyName: `Family ${seed}`,
      displayName: `Display ${seed}`,
      emails: [
        { value: `primary+${safe}@example.com`, label: 'work', isPrimary: true },
        { value: `secondary+${safe}@example.com`, label: 'personal' },
      ],
      phones: [{ value: '+31201234567', label: 'work', isPrimary: true }],
      jobTitle: 'Engineer',
      notes: `A sample contact seeded with ${seed}.`,
    };
  },
  mutatePayload(payload, seed) {
    return {
      ...payload,
      notes: `${payload.notes ?? ''} :: ${seed}`,
    };
  },
});

// ---------------------------------------------------------------------------
// Per-kind indexed-column assertions. These are NOT part of the §4.0 contract
// suite — they exercise the 4b.1 projection rules end-to-end against the real
// contacts table:
//   - `primary_email` picks `isPrimary=true` first, then falls back to the
//     first entry overall.
//   - `primary_phone` follows the same rule.
//   - `company_entity_id` mirrors the payload field verbatim.
// Clearing the payload writes NULL — the sparse indexes depend on this.
// ---------------------------------------------------------------------------

describe('contacts module :: indexed columns', () => {
  let fx: Fixture | null = null;
  afterEach(() => {
    if (fx !== null) {
      fx.cleanup();
      fx = null;
    }
  });

  it('writes primary_email/primary_phone/company_entity_id on create + update', async () => {
    fx = makeFixture();
    const layerId = seedLayer(fx.db, `c-${crypto.randomUUID().slice(0, 6)}`);
    const userId = seedUser(fx.db, `u-${crypto.randomUUID().slice(0, 6)}`);
    const store = createEntityStore<ContactPayload>({
      module: contactModule,
      db: fx.db,
      bus: fx.bus,
      llm: createLlmClient({
        endpoint: 'mock://echo',
        apiKey: '',
        defaultModel: 'mock-default',
      }),
    });
    const companyId = crypto.randomUUID();
    const created = await store.create({
      layerId,
      slug: 'alice',
      title: 'Alice',
      originalLocale: 'en',
      payload: {
        emails: [
          { value: 'alt@example.com', label: 'personal' },
          { value: 'alice@example.com', label: 'work', isPrimary: true },
        ],
        phones: [{ value: '+31201234567' }],
        companyEntityId: companyId,
      },
      actorId: userId,
    });

    type Row = {
      primary_email: string | null;
      primary_phone: string | null;
      company_entity_id: string | null;
    };
    const row = fx.db
      .query<
        Row,
        [string]
      >('SELECT primary_email, primary_phone, company_entity_id FROM contacts WHERE id = ?')
      .get(created.id);
    expect(row).not.toBeNull();
    // `isPrimary=true` wins over the array order.
    expect(row?.primary_email).toBe('alice@example.com');
    // First-entry fallback when no entry is flagged.
    expect(row?.primary_phone).toBe('+31201234567');
    expect(row?.company_entity_id).toBe(companyId);

    // First-entry fallback for emails when nothing is flagged.
    await store.update({
      id: created.id,
      payload: {
        emails: [{ value: 'first@example.com' }, { value: 'second@example.com' }],
      },
      actorId: userId,
    });
    const after = fx.db
      .query<
        Row,
        [string]
      >('SELECT primary_email, primary_phone, company_entity_id FROM contacts WHERE id = ?')
      .get(created.id);
    expect(after?.primary_email).toBe('first@example.com');
    expect(after?.primary_phone).toBeNull();
    expect(after?.company_entity_id).toBeNull();

    // Clearing all payload fields writes NULL across the board — the
    // sparse indexes (idx_contacts_primary_email, idx_contacts_company)
    // depend on this.
    await store.update({
      id: created.id,
      payload: {},
      actorId: userId,
    });
    const cleared = fx.db
      .query<
        Row,
        [string]
      >('SELECT primary_email, primary_phone, company_entity_id FROM contacts WHERE id = ?')
      .get(created.id);
    expect(cleared?.primary_email).toBeNull();
    expect(cleared?.primary_phone).toBeNull();
    expect(cleared?.company_entity_id).toBeNull();
  });
});

// `contactModule` is exported for inspection in higher-phase tests; assert
// the indexed-column declarations so a future refactor that accidentally
// drops one is caught here, not in production.
describe('contacts module :: shape', () => {
  it('declares primary_email, primary_phone, and company_entity_id as indexed columns', () => {
    const names = (contactModule.indexedColumns ?? []).map((c) => c.name).sort();
    expect(names).toEqual(['company_entity_id', 'primary_email', 'primary_phone']);
  });

  it('uses the primary email / phone / jobTitle order for the summary subtitle', () => {
    const ref = {
      id: 'id',
      kind: 'contact',
      layerId: 'layer',
      slug: 'slug',
    };
    const meta = {
      createdAt: '2020-01-01T00:00:00.000Z',
      createdBy: 'u',
      updatedAt: '2020-01-01T00:00:00.000Z',
      updatedBy: 'u',
      deletedAt: null,
      deletedBy: null,
      version: 1,
      originalLocale: 'en',
    };
    const withEmail = contactModule.toSummary({
      ref,
      meta,
      title: 'Alice',
      payload: {
        emails: [{ value: 'a@example.com', isPrimary: true }],
        phones: [{ value: '+1', isPrimary: true }],
        jobTitle: 'Engineer',
      },
    });
    expect(withEmail.subtitle).toBe('a@example.com');

    const withPhone = contactModule.toSummary({
      ref,
      meta,
      title: 'Bob',
      payload: {
        phones: [{ value: '+1', isPrimary: true }],
        jobTitle: 'Engineer',
      },
    });
    expect(withPhone.subtitle).toBe('+1');

    const withJobTitle = contactModule.toSummary({
      ref,
      meta,
      title: 'Carol',
      payload: { jobTitle: 'Engineer' },
    });
    expect(withJobTitle.subtitle).toBe('Engineer');

    const empty = contactModule.toSummary({
      ref,
      meta,
      title: 'Dave',
      payload: {},
    });
    expect(empty.subtitle).toBeNull();
  });
});
