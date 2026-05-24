/**
 * Phase 4b.3 — contacts AI enrichment behavioral tests.
 *
 * Surfaces under test:
 *   1. Domain-match deterministic path: a contact with `cs@ami.nl` is
 *      linked to the AMI BV company in the same layer without any LLM
 *      call.
 *   2. ORG-hint deterministic path: a contact with notes `ORG: Acme
 *      Holdings` is linked to the Acme company without any LLM call.
 *   3. LLM fallback: when 1 and 2 yield a weak candidate set, the LLM
 *      is consulted exactly once and a confident response applies the
 *      link.
 *   4. Low-confidence LLM: a `confidence < threshold` response leaves
 *      `companyEntityId` untouched.
 *   5. No-overwrite invariant: a contact with an explicit
 *      `companyEntityId` is never relinked, and the LLM is never called.
 *   6. Secret-strip invariant: a configured KvK apiKey on the layer
 *      never reaches the LLM prompt or any bus event payload.
 *   7. Cross-layer isolation: companies in another layer are not
 *      candidates and the LLM is never called.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { InMemoryMessageBus, type BusEvent } from '@bunny2/bus';
import type { CompanyPayload, ContactPayload } from '@bunny2/shared';
import { openDatabase } from '../../src/storage/sqlite';
import { createUsersRepo } from '../../src/repos/users-repo';
import { createLayersRepo } from '../../src/repos/layers-repo';
import { createLayerAttachmentsRepo } from '../../src/repos/layer-attachments-repo';
import type { ChatRequest, ChatResponse, LlmClient } from '../../src/llm';
import {
  __resetEntityRegistryForTests,
  createEntityStore,
  createEnrichmentRunner,
  registerEntityModule,
  type EntityStore,
} from '../../src/entities';
import { createCompanyModule, KVK_CONNECTOR_ID } from '../../src/entities/companies';
import { createContactModule, contactsSuggestCompanyJob } from '../../src/entities/contacts';
import { safeRmSync } from '../_helpers/temp-dir';

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
  readonly events: ReadonlyArray<BusEvent>;
  cleanup(): void;
}

function makeFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-contenrich-'));
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
  readonly response?: string;
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
      return {
        id: crypto.randomUUID(),
        model: 'mock-default',
        content: opts.response ?? '{"slug":"none","confidence":0.0}',
        tokensIn: 21,
        tokensOut: 9,
        raw: null,
      };
    },
  };
  return { llm, calls };
}

interface Stores {
  readonly companies: EntityStore<CompanyPayload>;
  readonly contacts: EntityStore<ContactPayload>;
}

function setup(stub: LlmStub): { fixture: Fixture; stores: Stores } {
  const fixture = fx();
  const companyMod = createCompanyModule({ connectors: [], enrichmentJobs: [] });
  // Contacts module: ship the production suggestCompany job; tests
  // explicitly drive the runner via `tickOnce()`.
  const contactMod = createContactModule({
    connectors: [],
    enrichmentJobs: [contactsSuggestCompanyJob],
  });
  registerEntityModule(companyMod);
  registerEntityModule(contactMod);
  const companies = createEntityStore<CompanyPayload>({
    module: companyMod,
    db: fixture.db,
    bus: fixture.bus,
    llm: stub.llm,
  });
  const contacts = createEntityStore<ContactPayload>({
    module: contactMod,
    db: fixture.db,
    bus: fixture.bus,
    llm: stub.llm,
  });
  return { fixture, stores: { companies, contacts } };
}

function makeRunner(fixture: Fixture, stub: LlmStub, stores: Stores) {
  return createEnrichmentRunner({
    db: fixture.db,
    bus: fixture.bus,
    llm: stub.llm,
    resolveStore: (module) => {
      if (module.kind === 'contact') return stores.contacts as EntityStore<unknown>;
      if (module.kind === 'company') return stores.companies as EntityStore<unknown>;
      return null;
    },
  });
}

async function seedTwoCompanies(stores: Stores, layerId: string, userId: string) {
  const ami = await stores.companies.create({
    layerId,
    slug: 'ami-bv',
    title: 'AMI BV',
    originalLocale: 'en',
    payload: {
      legalName: 'AMI BV',
      website: 'https://ami.nl',
    },
    actorId: userId,
  });
  const acme = await stores.companies.create({
    layerId,
    slug: 'acme-holdings',
    title: 'Acme Holdings',
    originalLocale: 'en',
    payload: {
      legalName: 'Acme Holdings',
      website: 'https://acme.example.com',
    },
    actorId: userId,
  });
  return { ami, acme };
}

let fixture: Fixture | null = null;
beforeEach(() => {
  __resetEntityRegistryForTests();
  fixture = makeFixture();
});
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});
function fx(): Fixture {
  if (fixture === null) throw new Error('fixture missing');
  return fixture;
}

describe('contacts enrichment :: domain match (deterministic)', () => {
  it('links a contact via email-domain match without any LLM call', async () => {
    const stub = makeLlmStub();
    const { fixture: f, stores } = setup(stub);
    const layerId = seedLayer(f.db, 'dom');
    const userId = seedUser(f.db, 'dom-u');
    const { ami } = await seedTwoCompanies(stores, layerId, userId);
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      const created = await stores.contacts.create({
        layerId,
        slug: 'cs',
        title: 'CS',
        originalLocale: 'en',
        payload: {
          givenName: 'Christiaan',
          emails: [{ value: 'cs@ami.nl', isPrimary: true }],
        },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = stores.contacts.getById(created.id);
      expect(refreshed?.payload.companyEntityId).toBe(ami.id);
      // Deterministic path: no LLM call.
      expect(stub.calls.length).toBe(0);
    } finally {
      runner.stop();
    }
  });
});

describe('contacts enrichment :: ORG hint (deterministic)', () => {
  it('links a contact via vCard ORG hint without any LLM call', async () => {
    const stub = makeLlmStub();
    const { fixture: f, stores } = setup(stub);
    const layerId = seedLayer(f.db, 'org');
    const userId = seedUser(f.db, 'org-u');
    const { acme } = await seedTwoCompanies(stores, layerId, userId);
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      const created = await stores.contacts.create({
        layerId,
        slug: 'jane',
        title: 'Jane Doe',
        originalLocale: 'en',
        payload: {
          givenName: 'Jane',
          familyName: 'Doe',
          notes: 'ORG: Acme Holdings\nNOTE: met at conference',
        },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = stores.contacts.getById(created.id);
      expect(refreshed?.payload.companyEntityId).toBe(acme.id);
      expect(stub.calls.length).toBe(0);
    } finally {
      runner.stop();
    }
  });
});

describe('contacts enrichment :: LLM fallback', () => {
  it('applies the link when the LLM returns a high-confidence slug', async () => {
    const stub = makeLlmStub({
      response: JSON.stringify({ slug: 'acme-holdings', confidence: 0.92 }),
    });
    const { fixture: f, stores } = setup(stub);
    const layerId = seedLayer(f.db, 'llm');
    const userId = seedUser(f.db, 'llm-u');
    const { acme } = await seedTwoCompanies(stores, layerId, userId);
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      // No exact name match — `ORG: Acme` is close (Lev=8 to "Acme
      // Holdings"? No — `acme` vs `acme holdings` is Lev=9). Adjust:
      // use a hint that triggers the fuzzy path. "Acme Holding" (drop
      // the trailing 's') has Lev=1 vs "acme holdings".
      const created = await stores.contacts.create({
        layerId,
        slug: 'john',
        title: 'John',
        originalLocale: 'en',
        payload: {
          givenName: 'John',
          emails: [{ value: 'john@example.org', isPrimary: true }],
          notes: 'ORG: Acme Holding',
        },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = stores.contacts.getById(created.id);
      expect(refreshed?.payload.companyEntityId).toBe(acme.id);
      expect(stub.calls.length).toBe(1);
      expect(stub.calls[0]?.flowId).toBe('enrichment:contacts.suggestCompany');
    } finally {
      runner.stop();
    }
  });

  it('leaves the link unset when the LLM returns low confidence', async () => {
    const stub = makeLlmStub({
      response: JSON.stringify({ slug: 'acme-holdings', confidence: 0.4 }),
    });
    const { fixture: f, stores } = setup(stub);
    const layerId = seedLayer(f.db, 'llmlow');
    const userId = seedUser(f.db, 'llmlow-u');
    await seedTwoCompanies(stores, layerId, userId);
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      const created = await stores.contacts.create({
        layerId,
        slug: 'mira',
        title: 'Mira',
        originalLocale: 'en',
        payload: {
          givenName: 'Mira',
          emails: [{ value: 'mira@example.org', isPrimary: true }],
          notes: 'ORG: Acme Holding',
        },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = stores.contacts.getById(created.id);
      expect(refreshed?.payload.companyEntityId).toBeUndefined();
      // The LLM WAS called (a candidate set existed) but its answer was
      // rejected by the threshold.
      expect(stub.calls.length).toBe(1);
    } finally {
      runner.stop();
    }
  });

  it('leaves the link unset when the LLM returns "none"', async () => {
    const stub = makeLlmStub({
      response: JSON.stringify({ slug: 'none', confidence: 0.0 }),
    });
    const { fixture: f, stores } = setup(stub);
    const layerId = seedLayer(f.db, 'llmnone');
    const userId = seedUser(f.db, 'llmnone-u');
    await seedTwoCompanies(stores, layerId, userId);
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      const created = await stores.contacts.create({
        layerId,
        slug: 'pat',
        title: 'Pat',
        originalLocale: 'en',
        payload: {
          emails: [{ value: 'pat@example.org', isPrimary: true }],
          notes: 'ORG: Acme Holding',
        },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = stores.contacts.getById(created.id);
      expect(refreshed?.payload.companyEntityId).toBeUndefined();
      expect(stub.calls.length).toBe(1);
    } finally {
      runner.stop();
    }
  });
});

describe('contacts enrichment :: no-overwrite invariant', () => {
  it('never re-links a contact whose companyEntityId is already set', async () => {
    const stub = makeLlmStub();
    const { fixture: f, stores } = setup(stub);
    const layerId = seedLayer(f.db, 'nov');
    const userId = seedUser(f.db, 'nov-u');
    const { ami, acme } = await seedTwoCompanies(stores, layerId, userId);
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      // Pre-stamp the AMI link manually.
      const created = await stores.contacts.create({
        layerId,
        slug: 'preset',
        title: 'Preset',
        originalLocale: 'en',
        payload: {
          givenName: 'Pre',
          emails: [{ value: 'pre@acme.example.com', isPrimary: true }],
          companyEntityId: ami.id,
        },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = stores.contacts.getById(created.id);
      // Domain says Acme, but the link must stay AMI (user-set).
      expect(refreshed?.payload.companyEntityId).toBe(ami.id);
      expect(refreshed?.payload.companyEntityId).not.toBe(acme.id);
      // LLM should not have been called: the job exits before
      // candidate enumeration.
      expect(stub.calls.length).toBe(0);
    } finally {
      runner.stop();
    }
  });
});

describe('contacts enrichment :: secret-strip invariant', () => {
  it('never includes a configured KvK apiKey in any LLM prompt or any bus event', async () => {
    const SECRET = 'leak-canary-contacts-supersecret';
    const stub = makeLlmStub({
      response: JSON.stringify({ slug: 'acme-holdings', confidence: 0.95 }),
    });
    const { fixture: f, stores } = setup(stub);
    const layerId = seedLayer(f.db, 'sec');
    const userId = seedUser(f.db, 'sec-u');
    attachKvk(f.db, layerId, SECRET);
    await seedTwoCompanies(stores, layerId, userId);
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      const created = await stores.contacts.create({
        layerId,
        slug: 'sec',
        title: 'Sec',
        originalLocale: 'en',
        payload: {
          emails: [{ value: 'sec@example.org', isPrimary: true }],
          notes: 'ORG: Acme Holding',
        },
        actorId: userId,
      });
      await runner.tickOnce();
      // The link must apply.
      const refreshed = stores.contacts.getById(created.id);
      expect(refreshed?.payload.companyEntityId).toBeDefined();
      // No LLM call message contains the apiKey.
      for (const call of stub.calls) {
        expect(call.messages).not.toContain(SECRET);
      }
      // No bus event payload contains the apiKey.
      const haystack = JSON.stringify(
        f.events.map((e) => ({ type: e.type, payload: e.payload, metadata: e.metadata })),
      );
      expect(haystack).not.toContain(SECRET);
    } finally {
      runner.stop();
    }
  });
});

describe('contacts enrichment :: cross-layer isolation', () => {
  it('does not suggest a company from a different layer', async () => {
    const stub = makeLlmStub({
      response: JSON.stringify({ slug: 'acme-holdings', confidence: 0.99 }),
    });
    const { fixture: f, stores } = setup(stub);
    const layerA = seedLayer(f.db, 'la');
    const layerB = seedLayer(f.db, 'lb');
    const userId = seedUser(f.db, 'iso-u');
    // Companies live in layer A only.
    await seedTwoCompanies(stores, layerA, userId);
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      // Contact in layer B; the email and ORG hint would both match
      // AMI / Acme if companies leaked across layers.
      const created = await stores.contacts.create({
        layerId: layerB,
        slug: 'iso',
        title: 'Iso',
        originalLocale: 'en',
        payload: {
          emails: [{ value: 'iso@ami.nl', isPrimary: true }],
          notes: 'ORG: Acme Holdings',
        },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = stores.contacts.getById(created.id);
      expect(refreshed?.payload.companyEntityId).toBeUndefined();
      // No candidates → no LLM call.
      expect(stub.calls.length).toBe(0);
    } finally {
      runner.stop();
    }
  });
});
