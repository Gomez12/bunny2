/**
 * Phase 4c.3 — calendar AI enrichment behavioral tests.
 *
 * Surfaces under test:
 *   1. Attendee resolution by exact email match (no LLM call).
 *   2. Attendee resolution by display-name match (no LLM call).
 *   3. Attendee resolution by LLM fallback (one LLM call, high confidence
 *      applied).
 *   4. No-overwrite invariant — attendees with `contactEntityId` already
 *      set are not touched even if the link points to a soft-deleted
 *      contact.
 *   5. Summary job applies a description-style note.
 *   6. Summary skip-on-no-content (no LLM call).
 *   7. Summary idempotence (no re-run when nothing changed).
 *   8. Secret-strip canary — refresh-token canary stays out of every LLM
 *      prompt and every bus event payload.
 *   9. Cross-layer isolation — contacts in layer A are not candidates
 *      for attendees in layer B.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { type BusEvent } from '@bunny2/bus';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import type { CalendarEventPayload, ContactPayload } from '@bunny2/shared';
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
  calendarAttendeeContactsJob,
  calendarSummaryJob,
  createCalendarEventModule,
} from '../../src/entities/calendar';
import { safeRmSync } from '../_helpers/temp-dir';

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
  readonly events: ReadonlyArray<BusEvent>;
  cleanup(): void;
}

function makeFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-calenrich-'));
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

interface LlmStubOptions {
  readonly response?: string;
  readonly summary?: string;
  readonly throwOn?: 'summary' | 'attendees';
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
      if (opts.throwOn === 'summary' && flowId === 'enrichment:calendar.summary') {
        throw new Error('errors.entity.enrichment.failed');
      }
      if (opts.throwOn === 'attendees' && flowId === 'enrichment:calendar.attendeeContacts') {
        throw new Error('errors.entity.enrichment.failed');
      }
      const content =
        flowId === 'enrichment:calendar.summary'
          ? (opts.summary ?? 'Short meeting note about the agenda.')
          : (opts.response ?? '{"id":"none","confidence":0.0}');
      return {
        id: crypto.randomUUID(),
        model: 'mock-default',
        content,
        tokensIn: 11,
        tokensOut: 5,
        raw: null,
      };
    },
  };
  return { llm, calls };
}

interface Stores {
  readonly events: EntityStore<CalendarEventPayload>;
  readonly contacts: EntityStore<ContactPayload>;
}

interface SetupOptions {
  readonly enrichmentJobs?: 'attendees' | 'summary' | 'both';
}

function setup(stub: LlmStub, opts: SetupOptions = {}): { fixture: Fixture; stores: Stores } {
  const fixture = fx();
  // Contacts module: no enrichment jobs (we only need it as a candidate
  // source) and no connectors.
  const contactMod = createContactModule({ connectors: [], enrichmentJobs: [] });
  const jobsChoice = opts.enrichmentJobs ?? 'both';
  const jobs =
    jobsChoice === 'attendees'
      ? [calendarAttendeeContactsJob]
      : jobsChoice === 'summary'
        ? [calendarSummaryJob]
        : [calendarAttendeeContactsJob, calendarSummaryJob];
  const calendarMod = createCalendarEventModule({ connectors: [], enrichmentJobs: jobs });
  registerEntityModule(contactMod);
  registerEntityModule(calendarMod);
  const contacts = createEntityStore<ContactPayload>({
    module: contactMod,
    db: fixture.db,
    bus: fixture.bus,
    llm: stub.llm,
  });
  const events = createEntityStore<CalendarEventPayload>({
    module: calendarMod,
    db: fixture.db,
    bus: fixture.bus,
    llm: stub.llm,
  });
  return { fixture, stores: { events, contacts } };
}

function makeRunner(fixture: Fixture, stub: LlmStub, stores: Stores) {
  return createEnrichmentRunner({
    db: fixture.db,
    bus: fixture.bus,
    llm: stub.llm,
    resolveStore: (module) => {
      if (module.kind === 'calendar_event') return stores.events as EntityStore<unknown>;
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

async function seedContact(
  stores: Stores,
  layerId: string,
  userId: string,
  args: {
    slug: string;
    title: string;
    payload: ContactPayload;
  },
) {
  return stores.contacts.create({
    layerId,
    slug: args.slug,
    title: args.title,
    originalLocale: 'en',
    payload: args.payload,
    actorId: userId,
  });
}

// ---------------------------------------------------------------------------
// Job A — attendeeContacts
// ---------------------------------------------------------------------------

describe('calendar enrichment :: attendee resolution by exact email', () => {
  it('links an attendee via case-insensitive email match without calling the LLM', async () => {
    const stub = makeLlmStub();
    const { fixture: f, stores } = setup(stub, { enrichmentJobs: 'attendees' });
    const layerId = seedLayer(f.db, 'le');
    const userId = seedUser(f.db, 'le-u');
    const alice = await seedContact(stores, layerId, userId, {
      slug: 'alice',
      title: 'Alice',
      payload: {
        givenName: 'Alice',
        emails: [{ value: 'alice@example.com', isPrimary: true }],
      },
    });
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      const created = await stores.events.create({
        layerId,
        slug: 'meet',
        title: 'Project sync',
        originalLocale: 'en',
        payload: {
          startsAt: '2026-06-01T09:00:00Z',
          allDay: false,
          attendees: [{ value: 'Alice@Example.com', status: 'needs_action' }],
        },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = stores.events.getById(created.id);
      expect(refreshed?.payload.attendees?.[0]?.contactEntityId).toBe(alice.id);
      expect(stub.calls.length).toBe(0);
    } finally {
      runner.stop();
    }
  });
});

describe('calendar enrichment :: attendee resolution by display name', () => {
  it('links an attendee via display-name fuzzy match without calling the LLM', async () => {
    const stub = makeLlmStub();
    const { fixture: f, stores } = setup(stub, { enrichmentJobs: 'attendees' });
    const layerId = seedLayer(f.db, 'ln');
    const userId = seedUser(f.db, 'ln-u');
    const bob = await seedContact(stores, layerId, userId, {
      slug: 'bob',
      title: 'Bob Smith',
      payload: {
        givenName: 'Bob',
        familyName: 'Smith',
        displayName: 'Bob Smith',
      },
    });
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      const created = await stores.events.create({
        layerId,
        slug: 'planning',
        title: 'Planning',
        originalLocale: 'en',
        payload: {
          startsAt: '2026-06-02T09:00:00Z',
          allDay: false,
          attendees: [
            { value: 'Conference Room A', displayName: 'Bob Smyth', status: 'needs_action' },
          ],
        },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = stores.events.getById(created.id);
      expect(refreshed?.payload.attendees?.[0]?.contactEntityId).toBe(bob.id);
      // Free-text value → no LLM step even if name match was ambiguous.
      expect(stub.calls.length).toBe(0);
    } finally {
      runner.stop();
    }
  });
});

describe('calendar enrichment :: attendee LLM fallback', () => {
  it('applies a high-confidence LLM pick when deterministic steps did not converge', async () => {
    // Two contacts share the same email-domain story but neither has
    // an exact-email match for the attendee value.
    const layerId = 'placeholder';
    void layerId;
    const stubResponse = (id: string): string => JSON.stringify({ id, confidence: 0.95 });
    // We need to know the id of the target contact AFTER it's created
    // to put it in the stub response. Two-phase setup.
    const stub: { current: LlmStub } = { current: makeLlmStub() };
    const { fixture: f, stores } = setup(stub.current, { enrichmentJobs: 'attendees' });
    const lid = seedLayer(f.db, 'llmfb');
    const userId = seedUser(f.db, 'llmfb-u');
    const eve = await seedContact(stores, lid, userId, {
      slug: 'eve',
      title: 'Eve',
      payload: {
        givenName: 'Eve',
        displayName: 'Eve Verylongname',
        emails: [{ value: 'eve@somewhere.example', isPrimary: true }],
      },
    });
    // Replace stub with one that knows eve.id.
    stub.current = makeLlmStub({ response: stubResponse(eve.id) });
    const runner = makeRunner(f, stub.current, stores);
    runner.start();
    try {
      const created = await stores.events.create({
        layerId: lid,
        slug: 'llmfb',
        title: 'Architecture sync',
        originalLocale: 'en',
        payload: {
          startsAt: '2026-06-03T09:00:00Z',
          allDay: false,
          // Email-shaped but does not match Eve's email. Display name
          // is too distant to fuzzy-match.
          attendees: [{ value: 'eve+work@elsewhere.example', status: 'needs_action' }],
        },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = stores.events.getById(created.id);
      expect(refreshed?.payload.attendees?.[0]?.contactEntityId).toBe(eve.id);
      const llmCalls = stub.current.calls.filter(
        (c) => c.flowId === 'enrichment:calendar.attendeeContacts',
      );
      expect(llmCalls.length).toBe(1);
    } finally {
      runner.stop();
    }
  });
});

describe('calendar enrichment :: no-overwrite for already-linked attendees', () => {
  it('never touches an attendee whose contactEntityId is already set, even if the contact was soft-deleted', async () => {
    const stub = makeLlmStub();
    const { fixture: f, stores } = setup(stub, { enrichmentJobs: 'attendees' });
    const lid = seedLayer(f.db, 'nov');
    const userId = seedUser(f.db, 'nov-u');
    const ghost = await seedContact(stores, lid, userId, {
      slug: 'ghost',
      title: 'Ghost',
      payload: {
        givenName: 'Ghost',
        emails: [{ value: 'ghost@example.com', isPrimary: true }],
      },
    });
    // Soft-delete ghost.
    await stores.contacts.softDelete({ id: ghost.id, actorId: userId });
    // Also seed a real contact that WOULD match by email.
    await seedContact(stores, lid, userId, {
      slug: 'real',
      title: 'Real',
      payload: {
        givenName: 'Real',
        emails: [{ value: 'real@example.com', isPrimary: true }],
      },
    });
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      const created = await stores.events.create({
        layerId: lid,
        slug: 'nov',
        title: 'Triage',
        originalLocale: 'en',
        payload: {
          startsAt: '2026-06-04T09:00:00Z',
          allDay: false,
          attendees: [
            { value: 'real@example.com', contactEntityId: ghost.id, status: 'needs_action' },
          ],
        },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = stores.events.getById(created.id);
      expect(refreshed?.payload.attendees?.[0]?.contactEntityId).toBe(ghost.id);
      expect(stub.calls.length).toBe(0);
    } finally {
      runner.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Job B — summary
// ---------------------------------------------------------------------------

describe('calendar enrichment :: summary applies note', () => {
  it('writes a meetingSummaryNote when the meeting has summarisable content', async () => {
    const stub = makeLlmStub({ summary: 'Discuss the Q3 roadmap.' });
    const { fixture: f, stores } = setup(stub, { enrichmentJobs: 'summary' });
    const lid = seedLayer(f.db, 'sum');
    const userId = seedUser(f.db, 'sum-u');
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      const created = await stores.events.create({
        layerId: lid,
        slug: 'q3',
        title: 'Q3 roadmap',
        originalLocale: 'en',
        payload: {
          startsAt: '2026-06-05T09:00:00Z',
          allDay: false,
          description: 'Walk through the Q3 plan in detail.',
          location: 'Room 1',
        },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = stores.events.getById(created.id);
      expect(refreshed?.payload.meetingSummaryNote).toBe('Discuss the Q3 roadmap.');
      const calls = stub.calls.filter((c) => c.flowId === 'enrichment:calendar.summary');
      expect(calls.length).toBe(1);
    } finally {
      runner.stop();
    }
  });
});

describe('calendar enrichment :: summary skip on no content', () => {
  it('does not call the LLM when there is nothing summarisable', async () => {
    const stub = makeLlmStub({ summary: 'Should not see me.' });
    const { fixture: f, stores } = setup(stub, { enrichmentJobs: 'summary' });
    const lid = seedLayer(f.db, 'noc');
    const userId = seedUser(f.db, 'noc-u');
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      const created = await stores.events.create({
        layerId: lid,
        slug: 'noc',
        title: 'Bare',
        originalLocale: 'en',
        payload: {
          startsAt: '2026-06-06T09:00:00Z',
          allDay: false,
        },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = stores.events.getById(created.id);
      expect(refreshed?.payload.meetingSummaryNote).toBeUndefined();
      const calls = stub.calls.filter((c) => c.flowId === 'enrichment:calendar.summary');
      expect(calls.length).toBe(0);
    } finally {
      runner.stop();
    }
  });
});

describe('calendar enrichment :: summary idempotence', () => {
  it('does not re-run the LLM when the summary already exists at the current version', async () => {
    const stub = makeLlmStub({ summary: 'First summary.' });
    const { fixture: f, stores } = setup(stub, { enrichmentJobs: 'summary' });
    const lid = seedLayer(f.db, 'idem');
    const userId = seedUser(f.db, 'idem-u');
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      const created = await stores.events.create({
        layerId: lid,
        slug: 'idem',
        title: 'Repeat',
        originalLocale: 'en',
        payload: {
          startsAt: '2026-06-07T09:00:00Z',
          allDay: false,
          description: 'Recurring sync.',
        },
        actorId: userId,
      });
      await runner.tickOnce();
      const firstCallCount = stub.calls.filter(
        (c) => c.flowId === 'enrichment:calendar.summary',
      ).length;
      expect(firstCallCount).toBe(1);
      // Re-trigger by emitting another created/updated for the same
      // entity. The summary is now set at version N; the soul stamp
      // matches N; the job MUST skip.
      // We mimic the bus path by calling tickOnce after a fresh
      // update that does not change the entity in a way that requires
      // a new summary — but every update bumps version, so we instead
      // assert idempotence by reading the same entity again under a
      // tick without prior new events. The pending queue is empty, so
      // tickOnce is a no-op, which is itself the trivially correct
      // assertion. Better: drive a sync.succeeded for this entity
      // explicitly. The runner subscribes to sync.succeeded for any
      // kind; manually re-arm pending by publishing a created event
      // again is not idiomatic. Instead: after the first run, run
      // again with NO new events — calls remain 1.
      const refreshed = stores.events.getById(created.id);
      expect(refreshed?.payload.meetingSummaryNote).toBe('First summary.');
      await runner.tickOnce();
      const secondCallCount = stub.calls.filter(
        (c) => c.flowId === 'enrichment:calendar.summary',
      ).length;
      expect(secondCallCount).toBe(1);
    } finally {
      runner.stop();
    }
  });

  it('skips the LLM when a fresh trigger re-queues an entity whose summary stamp still matches its version', async () => {
    // This test exercises `lastSummaryVersion` directly. After the
    // first run the entity is at version 2 with the soul stamp at 2.
    // We then re-publish a created event for the same entity (forcing
    // the runner to re-queue it), and assert the LLM is NOT called a
    // second time — that branch lives inside the job, not the runner.
    const stub = makeLlmStub({ summary: 'Initial.' });
    const { fixture: f, stores } = setup(stub, { enrichmentJobs: 'summary' });
    const lid = seedLayer(f.db, 'idemu');
    const userId = seedUser(f.db, 'idemu-u');
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      const created = await stores.events.create({
        layerId: lid,
        slug: 'idemu',
        title: 'Pulse',
        originalLocale: 'en',
        payload: {
          startsAt: '2026-06-08T09:00:00Z',
          allDay: false,
          description: 'Weekly pulse.',
        },
        actorId: userId,
      });
      await runner.tickOnce();
      const callsAfterFirst = stub.calls.filter(
        (c) => c.flowId === 'enrichment:calendar.summary',
      ).length;
      expect(callsAfterFirst).toBe(1);
      const refreshed = stores.events.getById(created.id);
      expect(refreshed?.payload.meetingSummaryNote).toBe('Initial.');
      expect(refreshed?.meta.version).toBe(2);

      // Re-publish a created event for the same entity. The runner
      // re-queues the job; the job MUST consult `entity_souls` and
      // skip because the stamp at version 2 already matches.
      await f.bus.publish({
        type: 'entity.calendar_event.created',
        payload: {
          ref: {
            id: created.id,
            kind: 'calendar_event',
            layerId: lid,
            slug: created.slug,
          },
          actorId: userId,
        },
      });
      await runner.tickOnce();
      const callsAfterReplay = stub.calls.filter(
        (c) => c.flowId === 'enrichment:calendar.summary',
      ).length;
      // Critical: the LLM was NOT called a second time. The guard
      // inside `calendarSummaryJob.run` (via `lastSummaryVersion`)
      // short-circuited.
      expect(callsAfterReplay).toBe(1);
    } finally {
      runner.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Secret-strip + cross-layer
// ---------------------------------------------------------------------------

describe('calendar enrichment :: secret-strip canary', () => {
  it('never leaks a layer-attachment canary token into LLM prompts or bus events', async () => {
    const CANARY = 'gcal-refresh-canary-z9k-deadbeef';
    const stub = makeLlmStub({ summary: 'Bland summary.' });
    const { fixture: f, stores } = setup(stub);
    const lid = seedLayer(f.db, 'sec');
    const userId = seedUser(f.db, 'sec-u');
    // Plant the canary in a layer-attachment config field — exactly
    // the shape the Google Calendar connector uses for tokens. The
    // calendar enrichment surface never reads attachments, so the
    // canary MUST stay out of every prompt + every event.
    createLayerAttachmentsRepo(f.db).insertAttachment({
      id: crypto.randomUUID(),
      layerId: lid,
      kind: 'connector',
      refId: 'google.calendar',
      config: {
        clientId: 'canary-client',
        clientSecret: CANARY,
        refreshToken: CANARY,
        calendarId: 'primary',
        pollIntervalMinutes: 1440,
      },
      now: new Date().toISOString(),
    });
    await seedContact(stores, lid, userId, {
      slug: 'alice',
      title: 'Alice',
      payload: {
        givenName: 'Alice',
        emails: [{ value: 'alice@example.com', isPrimary: true }],
      },
    });
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      const _ = await stores.events.create({
        layerId: lid,
        slug: 'sec',
        title: 'Secret retro',
        originalLocale: 'en',
        payload: {
          startsAt: '2026-06-09T09:00:00Z',
          allDay: false,
          description: 'Bland safe content.',
          attendees: [{ value: 'alice@example.com', status: 'needs_action' }],
        },
        actorId: userId,
      });
      void _;
      await runner.tickOnce();
      for (const call of stub.calls) {
        expect(call.messages).not.toContain(CANARY);
      }
      const haystack = JSON.stringify(
        f.events.map((e) => ({ type: e.type, payload: e.payload, metadata: e.metadata })),
      );
      expect(haystack).not.toContain(CANARY);
    } finally {
      runner.stop();
    }
  });
});

describe('calendar enrichment :: cross-layer isolation', () => {
  it('does not link attendees against contacts living in a different layer', async () => {
    const stub = makeLlmStub({ response: JSON.stringify({ id: 'x', confidence: 0.99 }) });
    const { fixture: f, stores } = setup(stub, { enrichmentJobs: 'attendees' });
    const layerA = seedLayer(f.db, 'la');
    const layerB = seedLayer(f.db, 'lb');
    const userId = seedUser(f.db, 'iso-u');
    // Contact lives in layer A only.
    await seedContact(stores, layerA, userId, {
      slug: 'alice',
      title: 'Alice',
      payload: {
        givenName: 'Alice',
        emails: [{ value: 'alice@example.com', isPrimary: true }],
      },
    });
    const runner = makeRunner(f, stub, stores);
    runner.start();
    try {
      // Event in layer B with the same email — the contact must NOT be
      // suggested because it's in a different layer.
      const created = await stores.events.create({
        layerId: layerB,
        slug: 'iso',
        title: 'Iso',
        originalLocale: 'en',
        payload: {
          startsAt: '2026-06-10T09:00:00Z',
          allDay: false,
          attendees: [{ value: 'alice@example.com', status: 'needs_action' }],
        },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = stores.events.getById(created.id);
      expect(refreshed?.payload.attendees?.[0]?.contactEntityId).toBeUndefined();
      // No candidates → no LLM call.
      expect(stub.calls.length).toBe(0);
    } finally {
      runner.stop();
    }
  });
});
