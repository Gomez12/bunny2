/**
 * Phase 4d.3 — todos AI enrichment behavioral tests.
 *
 * Surfaces under test:
 *   1. Auto-priority via keyword scan (no LLM call).
 *   2. Auto-priority via tag scan (no LLM call).
 *   3. Auto-priority via due-date proximity (no LLM call).
 *   4. Auto-priority LLM fallback — high confidence applied (one call).
 *   5. Auto-priority LLM fallback — low confidence rejected.
 *   6. Auto-priority no-overwrite invariant — user-set priority survives.
 *   7. Auto-priority skip on done / cancelled status.
 *   8. Auto-due via Dutch "morgen" keyword (no LLM call).
 *   9. Auto-due via English "next monday" keyword (no LLM call).
 *  10. Auto-due no-overwrite invariant — user-set dueAt survives.
 *  11. Auto-due NO LLM fallback — title without phrase yields nothing, no LLM call.
 *  12. Secret-strip canary — connector apiKey never reaches an LLM prompt
 *      or any bus event payload.
 *
 * Two production jobs ship; both deterministic-first. `todos.autoDue`
 * deliberately omits the LLM fallback because date hallucination has
 * user-visible side effects (a wrong date is worse than no date).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { type BusEvent } from '@bunny2/bus';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import type { TodoPayload } from '@bunny2/shared';
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
import { createTodoModule, todoAutoPriorityJob, todoAutoDueJob } from '../../src/entities/todos';
import { safeRmSync } from '../_helpers/temp-dir';

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
  readonly events: ReadonlyArray<BusEvent>;
  cleanup(): void;
}

function makeFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-todoenrich-'));
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
        content: opts.response ?? '{"priority":"keep","confidence":0.0}',
        tokensIn: 7,
        tokensOut: 3,
        raw: null,
      };
    },
  };
  return { llm, calls };
}

function setup(stub: LlmStub): { fixture: Fixture; store: EntityStore<TodoPayload> } {
  const fixture = fx();
  // Ship both production jobs by default — the tests explicitly
  // exercise the gating rules.
  const todoMod = createTodoModule({
    enrichmentJobs: [todoAutoPriorityJob, todoAutoDueJob],
  });
  registerEntityModule(todoMod);
  const store = createEntityStore<TodoPayload>({
    module: todoMod,
    db: fixture.db,
    bus: fixture.bus,
    llm: stub.llm,
  });
  return { fixture, store };
}

function makeRunner(fixture: Fixture, stub: LlmStub, store: EntityStore<TodoPayload>) {
  return createEnrichmentRunner({
    db: fixture.db,
    bus: fixture.bus,
    llm: stub.llm,
    resolveStore: (module) => {
      if (module.kind === 'todo') return store as EntityStore<unknown>;
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

function formatDateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isoWeekdayOf(d: Date): number {
  const wd = d.getDay();
  return wd === 0 ? 7 : wd;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setDate(out.getDate() + days);
  return out;
}

function expectedNextWeekdayAfter(from: Date, targetIso: number): string {
  const today = isoWeekdayOf(from);
  let delta = targetIso - today;
  if (delta < 0) delta += 7;
  if (delta === 0) delta = 7;
  return formatDateOnly(addDays(from, delta));
}

// ---------------------------------------------------------------------------
// auto-priority — keyword scan
// ---------------------------------------------------------------------------

describe('todos enrichment :: auto-priority via keyword (deterministic)', () => {
  it('promotes a todo whose title contains "URGENT" to priority 1 without any LLM call', async () => {
    const stub = makeLlmStub();
    const { fixture: f, store } = setup(stub);
    const layerId = seedLayer(f.db, 'kw');
    const userId = seedUser(f.db, 'kw-u');
    const runner = makeRunner(f, stub, store);
    runner.start();
    try {
      const created = await store.create({
        layerId,
        slug: 'ship-ci',
        title: 'URGENT: ship CI pipeline',
        originalLocale: 'en',
        payload: { status: 'open', priority: 3 },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = store.getById(created.id);
      expect(refreshed?.payload.priority).toBe(1);
      expect(stub.calls.length).toBe(0);
    } finally {
      runner.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// auto-priority — tag scan
// ---------------------------------------------------------------------------

describe('todos enrichment :: auto-priority via tags (deterministic)', () => {
  it('promotes a todo tagged "p1" to priority 1 without any LLM call', async () => {
    const stub = makeLlmStub();
    const { fixture: f, store } = setup(stub);
    const layerId = seedLayer(f.db, 'tag');
    const userId = seedUser(f.db, 'tag-u');
    const runner = makeRunner(f, stub, store);
    runner.start();
    try {
      const created = await store.create({
        layerId,
        slug: 'review-docs',
        title: 'Review the docs',
        originalLocale: 'en',
        payload: { status: 'open', priority: 3, tags: ['p1'] },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = store.getById(created.id);
      expect(refreshed?.payload.priority).toBe(1);
      expect(stub.calls.length).toBe(0);
    } finally {
      runner.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// auto-priority — due proximity
// ---------------------------------------------------------------------------

describe('todos enrichment :: auto-priority via due proximity (deterministic)', () => {
  it('promotes a todo whose dueAt is 12 hours from now to priority 1 without any LLM call', async () => {
    const stub = makeLlmStub();
    const { fixture: f, store } = setup(stub);
    const layerId = seedLayer(f.db, 'due');
    const userId = seedUser(f.db, 'due-u');
    const runner = makeRunner(f, stub, store);
    runner.start();
    try {
      const dueAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
      const created = await store.create({
        layerId,
        slug: 'soon',
        title: 'Call the supplier',
        originalLocale: 'en',
        payload: { status: 'open', priority: 3, dueAt },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = store.getById(created.id);
      expect(refreshed?.payload.priority).toBe(1);
      expect(stub.calls.length).toBe(0);
    } finally {
      runner.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// auto-priority — LLM fallback
// ---------------------------------------------------------------------------

describe('todos enrichment :: auto-priority LLM fallback', () => {
  it('applies a priority when the fake LLM returns a high-confidence value', async () => {
    const stub = makeLlmStub({
      response: JSON.stringify({ priority: 2, confidence: 0.9 }),
    });
    const { fixture: f, store } = setup(stub);
    const layerId = seedLayer(f.db, 'llm');
    const userId = seedUser(f.db, 'llm-u');
    const runner = makeRunner(f, stub, store);
    runner.start();
    try {
      // Ambiguous title: no keyword, no tag, no due. The job exhausts
      // the deterministic strategies and falls back to the LLM.
      const created = await store.create({
        layerId,
        slug: 'amb',
        title: 'Follow up with vendor',
        originalLocale: 'en',
        payload: { status: 'open', priority: 3 },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = store.getById(created.id);
      expect(refreshed?.payload.priority).toBe(2);
      // Exactly one LLM call (auto-due has no LLM fallback).
      expect(stub.calls.length).toBe(1);
      expect(stub.calls[0]?.flowId).toBe('enrichment:todos.autoPriority');
    } finally {
      runner.stop();
    }
  });

  it('leaves the priority unchanged when the fake LLM returns low confidence', async () => {
    const stub = makeLlmStub({
      response: JSON.stringify({ priority: 2, confidence: 0.4 }),
    });
    const { fixture: f, store } = setup(stub);
    const layerId = seedLayer(f.db, 'llmlow');
    const userId = seedUser(f.db, 'llmlow-u');
    const runner = makeRunner(f, stub, store);
    runner.start();
    try {
      const created = await store.create({
        layerId,
        slug: 'amb2',
        title: 'Follow up with vendor',
        originalLocale: 'en',
        payload: { status: 'open', priority: 3 },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = store.getById(created.id);
      // Default 3 remains.
      expect(refreshed?.payload.priority).toBe(3);
      // The LLM WAS called — the threshold rejected the result.
      expect(stub.calls.length).toBe(1);
    } finally {
      runner.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// auto-priority — no-overwrite invariant
// ---------------------------------------------------------------------------

describe('todos enrichment :: auto-priority no-overwrite', () => {
  it('never overwrites a user-set priority — keyword and LLM both ignored', async () => {
    const stub = makeLlmStub({
      response: JSON.stringify({ priority: 1, confidence: 0.99 }),
    });
    const { fixture: f, store } = setup(stub);
    const layerId = seedLayer(f.db, 'nov');
    const userId = seedUser(f.db, 'nov-u');
    const runner = makeRunner(f, stub, store);
    runner.start();
    try {
      const created = await store.create({
        layerId,
        slug: 'urgent-but-low',
        title: 'urgent task',
        originalLocale: 'en',
        // User explicitly set priority 4 — must not be touched.
        payload: { status: 'open', priority: 4 },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = store.getById(created.id);
      expect(refreshed?.payload.priority).toBe(4);
      // No LLM call — the job short-circuited on the priority gate.
      expect(stub.calls.length).toBe(0);
    } finally {
      runner.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// auto-priority — skip on done / cancelled
// ---------------------------------------------------------------------------

describe('todos enrichment :: auto-priority skip on done', () => {
  it('does not enrich a done todo even when the title contains "urgent"', async () => {
    const stub = makeLlmStub({
      response: JSON.stringify({ priority: 1, confidence: 0.99 }),
    });
    const { fixture: f, store } = setup(stub);
    const layerId = seedLayer(f.db, 'done');
    const userId = seedUser(f.db, 'done-u');
    const runner = makeRunner(f, stub, store);
    runner.start();
    try {
      const created = await store.create({
        layerId,
        slug: 'finished',
        title: 'urgent: finalize report',
        originalLocale: 'en',
        payload: { status: 'done', priority: 3 },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = store.getById(created.id);
      expect(refreshed?.payload.priority).toBe(3);
      expect(stub.calls.length).toBe(0);
    } finally {
      runner.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// auto-due — natural-language phrase scan
// ---------------------------------------------------------------------------

describe('todos enrichment :: auto-due via "morgen" (Dutch)', () => {
  it('sets dueAt to tomorrow when the title contains "morgen"', async () => {
    const stub = makeLlmStub();
    const { fixture: f, store } = setup(stub);
    const layerId = seedLayer(f.db, 'morgen');
    const userId = seedUser(f.db, 'morgen-u');
    const runner = makeRunner(f, stub, store);
    runner.start();
    try {
      const created = await store.create({
        layerId,
        slug: 'bel-terug',
        title: 'Bel terug morgen',
        originalLocale: 'nl',
        payload: { status: 'open', priority: 3 },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = store.getById(created.id);
      const expected = formatDateOnly(addDays(new Date(), 1));
      expect(refreshed?.payload.dueAt).toBe(expected);
      // Deterministic — no LLM call.
      expect(stub.calls.length).toBe(0);
    } finally {
      runner.stop();
    }
  });
});

describe('todos enrichment :: auto-due via "next monday"', () => {
  it('sets dueAt to the next Monday when the title contains "next monday"', async () => {
    const stub = makeLlmStub();
    const { fixture: f, store } = setup(stub);
    const layerId = seedLayer(f.db, 'mon');
    const userId = seedUser(f.db, 'mon-u');
    const runner = makeRunner(f, stub, store);
    runner.start();
    try {
      const created = await store.create({
        layerId,
        slug: 'kickoff',
        title: 'Kickoff next monday with the team',
        originalLocale: 'en',
        // Pre-stamp a tag so the auto-priority deterministic strategy
        // matches and the LLM fallback never fires. We're asserting
        // auto-due behaviour here; keeping priority deterministic
        // keeps the "no LLM call" assertion stable.
        payload: { status: 'open', priority: 3, tags: ['p2'] },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = store.getById(created.id);
      const expected = expectedNextWeekdayAfter(new Date(), 1);
      expect(refreshed?.payload.dueAt).toBe(expected);
      // Deterministic — neither job called the LLM.
      expect(stub.calls.length).toBe(0);
    } finally {
      runner.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// auto-due — no-overwrite invariant
// ---------------------------------------------------------------------------

describe('todos enrichment :: auto-due no-overwrite', () => {
  it('never overwrites a user-set dueAt even when the title has "morgen"', async () => {
    const stub = makeLlmStub();
    const { fixture: f, store } = setup(stub);
    const layerId = seedLayer(f.db, 'novdue');
    const userId = seedUser(f.db, 'novdue-u');
    const runner = makeRunner(f, stub, store);
    runner.start();
    try {
      const preset = '2027-12-31';
      const created = await store.create({
        layerId,
        slug: 'preset-due',
        title: 'Bel terug morgen graag',
        originalLocale: 'nl',
        payload: { status: 'open', priority: 3, dueAt: preset },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = store.getById(created.id);
      expect(refreshed?.payload.dueAt).toBe(preset);
      expect(stub.calls.length).toBe(0);
    } finally {
      runner.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// auto-due — NO LLM fallback
// ---------------------------------------------------------------------------

describe('todos enrichment :: auto-due no LLM fallback', () => {
  it('returns no patch and never calls the LLM when the title contains no date phrase', async () => {
    const stub = makeLlmStub();
    const { fixture: f, store } = setup(stub);
    const layerId = seedLayer(f.db, 'nodate');
    const userId = seedUser(f.db, 'nodate-u');
    const runner = makeRunner(f, stub, store);
    runner.start();
    try {
      const created = await store.create({
        layerId,
        slug: 'no-date',
        title: 'Renovate the office kitchen',
        originalLocale: 'en',
        payload: { status: 'open', priority: 3 },
        actorId: userId,
      });
      await runner.tickOnce();
      const refreshed = store.getById(created.id);
      // dueAt stays undefined.
      expect(refreshed?.payload.dueAt).toBeUndefined();
      // The auto-priority LLM fallback IS called (priority 3 default,
      // no deterministic signal); auto-due does NOT call the LLM. The
      // overall count must therefore be exactly 1, all for autoPriority.
      expect(stub.calls.length).toBe(1);
      for (const call of stub.calls) {
        expect(call.flowId).toBe('enrichment:todos.autoPriority');
        expect(call.flowId).not.toBe('enrichment:todos.autoDue');
      }
    } finally {
      runner.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Secret-strip canary
// ---------------------------------------------------------------------------

describe('todos enrichment :: secret-strip canary', () => {
  it('never includes a hypothetical connector apiKey in any LLM prompt or bus event', async () => {
    const CANARY = 'canary-leak-todos';
    const stub = makeLlmStub({
      response: JSON.stringify({ priority: 2, confidence: 0.95 }),
    });
    const { fixture: f, store } = setup(stub);
    const layerId = seedLayer(f.db, 'sec');
    const userId = seedUser(f.db, 'sec-u');
    // Attach a hypothetical connector config carrying the canary. Even
    // though no real todos connector ships in v1, the secret-strip
    // invariant must hold for any future attachment.
    createLayerAttachmentsRepo(f.db).insertAttachment({
      id: crypto.randomUUID(),
      layerId,
      kind: 'connector',
      refId: 'todo:hypothetical',
      config: { apiKey: CANARY },
      now: new Date().toISOString(),
    });
    const runner = makeRunner(f, stub, store);
    runner.start();
    try {
      const created = await store.create({
        layerId,
        slug: 'sec',
        title: 'Sec follow-up',
        originalLocale: 'en',
        payload: { status: 'open', priority: 3 },
        actorId: userId,
      });
      await runner.tickOnce();
      // No LLM prompt contains the canary.
      for (const call of stub.calls) {
        expect(call.messages).not.toContain(CANARY);
      }
      // No bus event payload contains the canary.
      const haystack = JSON.stringify(
        f.events.map((e) => ({ type: e.type, payload: e.payload, metadata: e.metadata })),
      );
      expect(haystack).not.toContain(CANARY);
      // Make sure the run actually did something so the assertion isn't vacuous.
      const refreshed = store.getById(created.id);
      expect(refreshed?.payload.priority).toBe(2);
    } finally {
      runner.stop();
    }
  });
});
