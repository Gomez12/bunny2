/**
 * Phase 11.3 — whiteboards AI enrichment behavioral tests.
 *
 * Surfaces under test:
 *   1. Scene summary writes `summary` to `entity_souls.memory_json`
 *      with a stamped `summarySourceVersion`.
 *   2. Scene summary is idempotent — a second tick at the same
 *      version does not call the LLM.
 *   3. Mention resolver links `@AMI BV` to a same-name contact in
 *      the same layer (deterministic, no LLM call).
 *   4. Mention resolver respects layer isolation — a same-name
 *      contact in a DIFFERENT layer is never linked.
 *   5. Mention resolver is idempotent — a second tick does not
 *      double-insert `entity_external_links` rows.
 *   6. Runner-level coalescing — multiple `entity.whiteboard.updated`
 *      events for the same whiteboard collapse into a single
 *      enrichment pass (the runner's debounce window is the
 *      coalesce window — see `enrichment-runner.ts`).
 *   7. Secret-strip canary — connector apiKey held on
 *      `layer_attachments.config` never reaches an LLM prompt; the
 *      summary prompt contains only scene-text excerpts.
 *   8. Scheduled-task sweep — `entity.whiteboards.enrich` re-runs
 *      both jobs for whiteboards whose soul stamp is stale.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import type { ContactPayload, WhiteboardPayload } from '@bunny2/shared';
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
import { createContactModule } from '../../src/entities/contacts';
import {
  createWhiteboardModule,
  whiteboardSceneSummaryJob,
  whiteboardMentionResolverJob,
  whiteboardEnrichmentJobs,
  WHITEBOARD_MENTION_CONNECTOR_ID,
  WHITEBOARD_SCENE_SUMMARY_JOB_ID,
  readWhiteboardSummary,
  runWhiteboardsEnrichSweep,
  listStaleWhiteboards,
} from '../../src/entities/whiteboards';
import { safeRmSync } from '../_helpers/temp-dir';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
  cleanup(): void;
}

function makeFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-whiteenrich-'));
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

interface LlmStubOptions {
  readonly response?: string;
}

interface RecordedCall {
  readonly flowId: string | undefined;
  readonly messages: string;
}

interface LlmStub {
  readonly llm: LlmClient;
  readonly calls: ReadonlyArray<RecordedCall>;
}

function makeLlmStub(opts: LlmStubOptions = {}): LlmStub {
  const calls: RecordedCall[] = [];
  const llm: LlmClient = {
    endpoint: 'mock://stub',
    defaultModel: 'mock-default',
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const flowId = typeof req.metadata?.flowId === 'string' ? req.metadata.flowId : undefined;
      const messages = req.messages.map((m) => `${m.role}:${m.content}`).join('\n');
      calls.push({ flowId, messages });
      return {
        id: crypto.randomUUID(),
        model: 'mock-default',
        content: opts.response ?? 'A whiteboard summarising onboarding steps and Q3 retro topics.',
        tokensIn: 12,
        tokensOut: 9,
        raw: null,
      };
    },
  };
  return { llm, calls };
}

interface Stores {
  readonly whiteboards: EntityStore<WhiteboardPayload>;
  readonly contacts: EntityStore<ContactPayload>;
}

function setup(stub: LlmStub): { fixture: Fixture; stores: Stores } {
  const fixture = fx();
  const contactMod = createContactModule({ connectors: [], enrichmentJobs: [] });
  const whiteboardMod = createWhiteboardModule({
    connectors: [],
    enrichmentJobs: whiteboardEnrichmentJobs,
  });
  registerEntityModule(contactMod);
  registerEntityModule(whiteboardMod);
  const contacts = createEntityStore<ContactPayload>({
    module: contactMod,
    db: fixture.db,
    bus: fixture.bus,
    llm: stub.llm,
  });
  const whiteboards = createEntityStore<WhiteboardPayload>({
    module: whiteboardMod,
    db: fixture.db,
    bus: fixture.bus,
    llm: stub.llm,
  });
  return { fixture, stores: { whiteboards, contacts } };
}

function makeRunner(fixture: Fixture, stub: LlmStub, stores: Stores) {
  return createEnrichmentRunner({
    db: fixture.db,
    bus: fixture.bus,
    llm: stub.llm,
    resolveStore: (module) => {
      if (module.kind === 'whiteboard') return stores.whiteboards as EntityStore<unknown>;
      if (module.kind === 'contact') return stores.contacts as EntityStore<unknown>;
      return null;
    },
  });
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

function textElement(id: string, text: string): Record<string, unknown> {
  return { version: 1, type: 'text', id, text };
}

function nonTextElement(id: string, type: string): Record<string, unknown> {
  return { version: 1, type, id };
}

function withScene(elements: ReadonlyArray<Record<string, unknown>>): WhiteboardPayload {
  return {
    scene: { elements: elements as unknown as WhiteboardPayload['scene']['elements'] },
    files: {},
  } as WhiteboardPayload;
}

// ---------------------------------------------------------------------------
// Scene summary
// ---------------------------------------------------------------------------

describe('whiteboards enrichment :: scene summary', () => {
  it('writes a summary into entity_souls.memory_json for a fixture whiteboard', async () => {
    const stub = makeLlmStub({ response: 'Onboarding map for new joiners.' });
    const { fixture: f, stores } = setup(stub);
    const layerId = seedLayer(f.db, 'sum');
    const userId = seedUser(f.db, 'sum-u');
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      const created = await stores.whiteboards.create({
        layerId,
        slug: 'onboarding',
        title: 'Onboarding map',
        originalLocale: 'en',
        payload: withScene([
          textElement('e1', 'Welcome to the team'),
          textElement('e2', 'Step 1: read the handbook'),
          nonTextElement('arrow1', 'arrow'),
        ]),
        actorId: userId,
      });
      await runner.tickOnce();
      const soul = readWhiteboardSummary(f.db, created.id);
      expect(soul?.summary).toBe('Onboarding map for new joiners.');
      expect(soul?.sourceVersion).toBe(created.meta.version);
      // Exactly one LLM call: the summary job. The mention resolver
      // never calls the LLM.
      const summaryCalls = stub.calls.filter(
        (c) => c.flowId === `enrichment:${WHITEBOARD_SCENE_SUMMARY_JOB_ID}`,
      );
      expect(summaryCalls.length).toBe(1);
    } finally {
      runner.stop();
    }
  });

  it('does not call the LLM when the whiteboard has no text elements', async () => {
    const stub = makeLlmStub();
    const { fixture: f, stores } = setup(stub);
    const layerId = seedLayer(f.db, 'notext');
    const userId = seedUser(f.db, 'notext-u');
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      const created = await stores.whiteboards.create({
        layerId,
        slug: 'arrows-only',
        title: 'Arrows only',
        originalLocale: 'en',
        payload: withScene([nonTextElement('a1', 'arrow'), nonTextElement('r1', 'rectangle')]),
        actorId: userId,
      });
      await runner.tickOnce();
      expect(stub.calls.length).toBe(0);
      // No soul row was created — nothing to summarise.
      expect(readWhiteboardSummary(f.db, created.id)).toBeNull();
    } finally {
      runner.stop();
    }
  });

  it('is idempotent: a second tick at the same version does not re-call the LLM', async () => {
    const stub = makeLlmStub({ response: 'Stable summary.' });
    const { fixture: f, stores } = setup(stub);
    const layerId = seedLayer(f.db, 'idem');
    const userId = seedUser(f.db, 'idem-u');
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      const created = await stores.whiteboards.create({
        layerId,
        slug: 'idem-wb',
        title: 'Idempotent board',
        originalLocale: 'en',
        payload: withScene([textElement('t1', 'Stable text content.')]),
        actorId: userId,
      });
      await runner.tickOnce();
      const firstCount = stub.calls.length;
      // Re-run the job directly (the runner already cleared its
      // pending entry). The idempotence gate uses the soul-recorded
      // version, not the runner's internal state.
      await whiteboardSceneSummaryJob.run(stores.whiteboards.getById(created.id)!, {
        db: f.db,
        bus: f.bus,
        llm: stub.llm,
        layerId: created.layerId,
        trigger: 'updated',
        module: createWhiteboardModule({ enrichmentJobs: whiteboardEnrichmentJobs }),
      });
      expect(stub.calls.length).toBe(firstCount);
    } finally {
      runner.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Mention resolver
// ---------------------------------------------------------------------------

async function seedContact(
  stores: Stores,
  layerId: string,
  userId: string,
  args: { slug: string; title: string; payload?: ContactPayload },
) {
  return stores.contacts.create({
    layerId,
    slug: args.slug,
    title: args.title,
    originalLocale: 'en',
    payload: args.payload ?? { displayName: args.title },
    actorId: userId,
  });
}

function listMentionLinks(
  db: Database,
  entityId: string,
): readonly { externalId: string; payload: Record<string, unknown> }[] {
  return db
    .query<{ external_id: string; payload_json: string }, [string, string]>(
      'SELECT external_id, payload_json FROM entity_external_links WHERE entity_id = ? AND connector = ?',
    )
    .all(entityId, WHITEBOARD_MENTION_CONNECTOR_ID)
    .map((r) => ({
      externalId: r.external_id,
      payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    }));
}

describe('whiteboards enrichment :: mention resolver', () => {
  it('links an @AMI BV mention to a same-name contact in the same layer (no LLM call)', async () => {
    const stub = makeLlmStub({ response: 'Whiteboard mentioning AMI BV.' });
    const { fixture: f, stores } = setup(stub);
    const layerId = seedLayer(f.db, 'mention');
    const userId = seedUser(f.db, 'mention-u');
    const contact = await seedContact(stores, layerId, userId, {
      slug: 'ami-bv',
      title: 'AMI BV',
    });
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      const created = await stores.whiteboards.create({
        layerId,
        slug: 'kickoff',
        title: 'Kickoff notes',
        originalLocale: 'en',
        payload: withScene([textElement('t1', 'Discussed contract with @AMI BV today.')]),
        actorId: userId,
      });
      await runner.tickOnce();
      const links = listMentionLinks(f.db, created.id);
      expect(links.length).toBe(1);
      expect(links[0]?.externalId).toBe(`contact:${contact.id}`);
      expect(links[0]?.payload['targetKind']).toBe('contact');
      expect(links[0]?.payload['targetId']).toBe(contact.id);
      // The mention resolver itself never calls the LLM.
      const resolverCalls = stub.calls.filter((c) => c.flowId?.includes('mentionResolver'));
      expect(resolverCalls.length).toBe(0);
    } finally {
      runner.stop();
    }
  });

  it('also matches the [[name]] mention syntax', async () => {
    const stub = makeLlmStub();
    const { fixture: f, stores } = setup(stub);
    const layerId = seedLayer(f.db, 'bracket');
    const userId = seedUser(f.db, 'bracket-u');
    const contact = await seedContact(stores, layerId, userId, {
      slug: 'jane-doe',
      title: 'Jane Doe',
    });
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      const created = await stores.whiteboards.create({
        layerId,
        slug: 'sprint',
        title: 'Sprint planning',
        originalLocale: 'en',
        payload: withScene([textElement('t1', 'Owner: [[Jane Doe]]')]),
        actorId: userId,
      });
      await runner.tickOnce();
      const links = listMentionLinks(f.db, created.id);
      expect(links.length).toBe(1);
      expect(links[0]?.externalId).toBe(`contact:${contact.id}`);
    } finally {
      runner.stop();
    }
  });

  it('does NOT link a same-name contact that lives in a different layer', async () => {
    const stub = makeLlmStub();
    const { fixture: f, stores } = setup(stub);
    const layerA = seedLayer(f.db, 'lay-a');
    const layerB = seedLayer(f.db, 'lay-b');
    const userId = seedUser(f.db, 'iso-u');
    // Contact lives in layer B — the whiteboard lives in layer A.
    await seedContact(stores, layerB, userId, {
      slug: 'invisible',
      title: 'Invisible Co',
    });
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      const created = await stores.whiteboards.create({
        layerId: layerA,
        slug: 'cross',
        title: 'Cross-layer test',
        originalLocale: 'en',
        payload: withScene([textElement('t1', 'Note about @Invisible Co')]),
        actorId: userId,
      });
      await runner.tickOnce();
      const links = listMentionLinks(f.db, created.id);
      expect(links.length).toBe(0);
    } finally {
      runner.stop();
    }
  });

  it('is idempotent: rerunning the resolver does not double-insert links', async () => {
    const stub = makeLlmStub();
    const { fixture: f, stores } = setup(stub);
    const layerId = seedLayer(f.db, 'dup');
    const userId = seedUser(f.db, 'dup-u');
    const contact = await seedContact(stores, layerId, userId, {
      slug: 'dup-co',
      title: 'Dup Co',
    });
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      const created = await stores.whiteboards.create({
        layerId,
        slug: 'dup-wb',
        title: 'Dup whiteboard',
        originalLocale: 'en',
        payload: withScene([textElement('t1', 'Linked to @Dup Co.')]),
        actorId: userId,
      });
      await runner.tickOnce();
      // Re-run the job directly (the runner already drained).
      await whiteboardMentionResolverJob.run(stores.whiteboards.getById(created.id)!, {
        db: f.db,
        bus: f.bus,
        llm: stub.llm,
        layerId: created.layerId,
        trigger: 'updated',
        module: createWhiteboardModule({ enrichmentJobs: whiteboardEnrichmentJobs }),
      });
      const links = listMentionLinks(f.db, created.id);
      expect(links.length).toBe(1);
      expect(links[0]?.externalId).toBe(`contact:${contact.id}`);
    } finally {
      runner.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Coalescing (runner-level)
// ---------------------------------------------------------------------------

describe('whiteboards enrichment :: subscriber coalescing', () => {
  it('coalesces multiple entity.whiteboard.updated events into a single enrichment pass', async () => {
    const stub = makeLlmStub({ response: 'Coalesced.' });
    const { fixture: f, stores } = setup(stub);
    const layerId = seedLayer(f.db, 'coal');
    const userId = seedUser(f.db, 'coal-u');
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      const created = await stores.whiteboards.create({
        layerId,
        slug: 'coalesced',
        title: 'Coalesced whiteboard',
        originalLocale: 'en',
        payload: withScene([textElement('t1', 'Initial text')]),
        actorId: userId,
      });
      // Three quick updates land within the runner's debounce window.
      // The pending Map keys on (kind, entityId), so all three collapse
      // into one entry — and one summary LLM call after `tickOnce`.
      await stores.whiteboards.update({
        id: created.id,
        payload: withScene([textElement('t1', 'Updated once')]),
        actorId: userId,
      });
      await stores.whiteboards.update({
        id: created.id,
        payload: withScene([textElement('t1', 'Updated twice')]),
        actorId: userId,
      });
      await stores.whiteboards.update({
        id: created.id,
        payload: withScene([textElement('t1', 'Updated three times')]),
        actorId: userId,
      });
      await runner.tickOnce();
      const summaryCalls = stub.calls.filter(
        (c) => c.flowId === `enrichment:${WHITEBOARD_SCENE_SUMMARY_JOB_ID}`,
      );
      expect(summaryCalls.length).toBe(1);
    } finally {
      runner.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Secret-strip canary
// ---------------------------------------------------------------------------

describe('whiteboards enrichment :: secret-strip canary', () => {
  it('never sends the layer attachment apiKey into an LLM prompt', async () => {
    const stub = makeLlmStub({ response: 'Sanitised summary.' });
    const { fixture: f, stores } = setup(stub);
    const layerId = seedLayer(f.db, 'sec');
    const userId = seedUser(f.db, 'sec-u');
    // Plant a connector attachment with a fake API key. The whiteboards
    // module does not have a real connector in v1 (the placeholder
    // refuses sync), but the prompt MUST never include connector
    // configs regardless. Storing the attachment alongside proves we
    // are not accidentally widening the prompt surface to other rows.
    const attachmentsRepo = createLayerAttachmentsRepo(f.db);
    attachmentsRepo.insertAttachment({
      id: crypto.randomUUID(),
      kind: 'connector',
      refId: 'whiteboard.mention.placeholder',
      layerId,
      config: { apiKey: 'super-secret-do-not-leak' },
      now: new Date().toISOString(),
    });
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      const created = await stores.whiteboards.create({
        layerId,
        slug: 'leak-canary',
        title: 'Leak canary',
        originalLocale: 'en',
        payload: withScene([textElement('t1', 'Public scene text — nothing secret.')]),
        actorId: userId,
      });
      await runner.tickOnce();
      // Audit every captured prompt. The secret string must not appear
      // anywhere — system, user, or any other role.
      for (const call of stub.calls) {
        expect(call.messages.includes('super-secret-do-not-leak')).toBe(false);
        // Defence in depth: the prompt must include only scene-text
        // (or the system instruction). It must not include connector
        // names, attachment ids, or our internal mention payload.
        expect(call.messages.includes('apiKey')).toBe(false);
      }
      // The whiteboard's scene text DID make it into a prompt — confirm
      // the canary is meaningful.
      const summaryCall = stub.calls.find(
        (c) => c.flowId === `enrichment:${WHITEBOARD_SCENE_SUMMARY_JOB_ID}`,
      );
      expect(summaryCall?.messages.includes('Public scene text')).toBe(true);
      // The summary did get written.
      expect(readWhiteboardSummary(f.db, created.id)?.summary).toBe('Sanitised summary.');
    } finally {
      runner.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Scheduled-task sweep
// ---------------------------------------------------------------------------

describe('whiteboards enrichment :: scheduled sweep', () => {
  it('lists whiteboards whose soul stamp is stale', async () => {
    const stub = makeLlmStub();
    const { fixture: f, stores } = setup(stub);
    const layerId = seedLayer(f.db, 'sweep');
    const userId = seedUser(f.db, 'sweep-u');
    const created = await stores.whiteboards.create({
      layerId,
      slug: 'never-enriched',
      title: 'Never enriched',
      originalLocale: 'en',
      payload: withScene([textElement('t1', 'Hi')]),
      actorId: userId,
    });
    const stale = listStaleWhiteboards(f.db, 50);
    expect(stale.map((r) => r.id)).toContain(created.id);
  });

  it('runWhiteboardsEnrichSweep enriches stale whiteboards', async () => {
    const stub = makeLlmStub({ response: 'Swept summary.' });
    const { fixture: f, stores } = setup(stub);
    const layerId = seedLayer(f.db, 'sw2');
    const userId = seedUser(f.db, 'sw2-u');
    const contact = await seedContact(stores, layerId, userId, {
      slug: 'sw-co',
      title: 'Swept Co',
    });
    const created = await stores.whiteboards.create({
      layerId,
      slug: 'swept-wb',
      title: 'Swept whiteboard',
      originalLocale: 'en',
      payload: withScene([textElement('t1', 'See @Swept Co for details')]),
      actorId: userId,
    });
    const result = await runWhiteboardsEnrichSweep({
      db: f.db,
      bus: f.bus,
      llm: stub.llm,
      config: { maxPerSweep: 10 },
    });
    expect(result.considered).toBeGreaterThanOrEqual(1);
    expect(result.enriched).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);
    expect(readWhiteboardSummary(f.db, created.id)?.summary).toBe('Swept summary.');
    const links = listMentionLinks(f.db, created.id);
    expect(links.map((l) => l.externalId)).toContain(`contact:${contact.id}`);
    // A second sweep is a no-op (idempotent on the version stamp).
    const callsAfterFirst = stub.calls.length;
    const second = await runWhiteboardsEnrichSweep({
      db: f.db,
      bus: f.bus,
      llm: stub.llm,
      config: { maxPerSweep: 10 },
    });
    expect(second.considered).toBe(0);
    expect(stub.calls.length).toBe(callsAfterFirst);
  });
});
