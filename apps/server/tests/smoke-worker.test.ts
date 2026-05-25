/**
 * Phase 5.7 — worker-role smoke.
 *
 * The original `smoke.test.ts` exercises the `--role=all` shape against
 * the in-memory bus. This sibling smoke covers the `--role=worker`
 * shape against the **durable** bus, which is the production
 * adapter for every role (per ADR
 * `docs/dev/decisions/0019-durable-sqlite-message-bus.md`).
 *
 * What the test proves:
 *
 *  1. A fresh data-dir + the same boot helpers (`seedAdminIfNeeded`,
 *     `seedLayersIfNeeded`, the scheduled-task built-in registration
 *     + seed) produce a working scheduler tick + durable consume
 *     loop against `DurableSqliteMessageBus`.
 *  2. A pre-seeded one-shot task with a past `next_run_at` is claimed
 *     by `scheduler.tickOnce()`, the publish lands in `bus_outbox`,
 *     `bus.drain()` delivers it to the run subscriber, and the run
 *     row finishes as `succeeded`.
 *  3. The outbox advances: the row flips to `delivered` and the
 *     subscriber's `bus_offsets` row tracks the published id.
 *  4. The `/status` endpoint reports `role: 'worker'` when the app is
 *     constructed with that role (the in-process equivalent of
 *     running `bun start --role=worker` — see `role-split.test.ts`).
 *
 * The test runs in-process. It does not spawn `apps/server/src/index.ts`
 * in a subprocess; that would add CI matrix flake and the role-split
 * seam is already exercised by `role-split.test.ts`. The brief
 * explicitly authorises the in-process simulation for the smoke.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DurableSqliteMessageBus,
  correlationIdMiddleware,
  errorCaptureMiddleware,
} from '@bunny2/bus';
import type { LlmClient } from '../src/llm';
import { openDatabase } from '../src/storage/sqlite';
import { currentSchemaVersion } from '../src/storage/migrations';
import { writeEventRow, createSqliteEventLog } from '../src/bus/event-log';
import { seedAdminIfNeeded } from '../src/auth/seed';
import { createGroupResolver } from '../src/auth/group-resolver';
import { seedLayersIfNeeded, EVERYONE_LAYER_SLUG } from '../src/layers/seed';
import { createLayersRepo } from '../src/repos/layers-repo';
import { createApp } from '../src/http/router';
import type { StatusBody } from '../src/http/router';
import { createLayerResolver } from '../src/layers/resolver';
import { AuthConfigSchema, LocalesConfigSchema } from '../src/config/schema';
import { ADMIN_USER_ID_KEY } from '../src/auth/seed';
import { getMeta } from '../src/storage/kv-meta';
import { safeRmSync } from './_helpers/temp-dir';
import {
  __resetScheduledTaskRegistryForTests,
  createScheduledTasksRepo,
  createScheduledRunSubscriber,
  createScheduler,
  registerBuiltInScheduledTaskHandlers,
  registerScheduledTaskHandler,
  getScheduledTaskHandler,
  seedSystemScheduledTasksIfNeeded,
} from '../src/scheduled';
// Phase 6.7 — assert the three chat-domain scheduled-task handlers
// register on the worker process. The smoke does NOT exercise them
// end-to-end (the per-handler unit tests cover that). It only pins
// that the registry shape an `--role=worker` process produces matches
// the documented job inventory (`docs/dev/architecture/job-inventory.md`).
import {
  registerChatScheduledTaskHandlers,
  createMockEmbedder,
  createInMemoryLanceWriter,
} from '../src/chat';
import { registerProposalsScheduledTaskHandlers } from '../src/proposals';

interface OutboxRow {
  status: string;
}
interface OffsetRow {
  last_id: string;
}

let tmpDir: string;
let db: Database | null = null;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-smoke-worker-'));
});

afterAll(() => {
  if (db !== null) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  try {
    safeRmSync(tmpDir);
  } catch {
    /* best effort */
  }
});

describe('phase 5.7 — smoke-worker (role=worker against DurableSqliteMessageBus)', () => {
  it('pre-seed → tick → drain → run succeeded, outbox delivered, status reports role=worker', async () => {
    const database = openDatabase(tmpDir);
    db = database;
    const schemaVersion = currentSchemaVersion(database);
    expect(schemaVersion).not.toBeNull();

    // Durable bus + a stub LLM client that should never be called by
    // the smoke handler.
    const eventLog = createSqliteEventLog(database);
    const bus = new DurableSqliteMessageBus(database, {
      writeEvent: (event) => writeEventRow(database, event),
      middlewares: [correlationIdMiddleware, errorCaptureMiddleware()],
      subscriberKey: 'smoke-worker',
    });
    const llmClient: LlmClient = {
      endpoint: 'mock://smoke-worker',
      defaultModel: 'mock-default',
      async chat(): Promise<never> {
        throw new Error('smoke-worker: llmClient.chat must not be called by the fixture handler');
      },
    };
    bus.start();

    try {
      // -------------------------------------------------------------
      // 1. Boot helpers — same order as `apps/server/src/index.ts`.
      // -------------------------------------------------------------
      await seedAdminIfNeeded({ db: database, bus });
      const resolver = createGroupResolver({ db: database, bus });
      await seedLayersIfNeeded({ db: database, bus, transitiveGroups: resolver });
      const layerResolver = createLayerResolver({ db: database, transitiveGroups: resolver });

      // -------------------------------------------------------------
      // 2. Scheduled-tasks runtime — register built-ins + a fixture
      //    one-shot handler, seed system tasks, mount the run
      //    subscriber + scheduler in `worker` mode.
      // -------------------------------------------------------------
      __resetScheduledTaskRegistryForTests();
      registerBuiltInScheduledTaskHandlers({
        llmCallLog: {
          write(): void {},
          count(): number {
            return 0;
          },
          getById(): null {
            return null;
          },
          pruneOlderThan(): number {
            return 0;
          },
        },
        llmRetentionDays: 180,
        schemaVersion: schemaVersion ?? 'smoke-worker',
        busAdapter: 'durable-sqlite',
      });
      let handlerInvocations = 0;
      registerScheduledTaskHandler({
        kind: 'smoke.worker.one-shot',
        async run(): Promise<void> {
          handlerInvocations += 1;
        },
      });

      // Phase 6.7 — register the three chat-domain handlers exactly
      // the way `apps/server/src/index.ts` does on every role (the
      // production wiring at index.ts:389 calls this with the real
      // LanceDB writer; the smoke uses the in-memory writer + mock
      // embedder so we don't touch the LanceDB file). After the
      // call all three `kind`s must resolve to a non-null handler —
      // matching the rows in `docs/dev/architecture/job-inventory.md`
      // and the assertions in `tests/docs/job-inventory.test.ts`.
      registerChatScheduledTaskHandlers({
        embedder: createMockEmbedder(),
        writer: createInMemoryLanceWriter(),
      });
      // Phase 7.6 — proposals-domain handlers also register so the
      // system-task seed (which now includes `proposals.evidence.prune`
      // + `proposals.replan-stale`) finds their handlers.
      registerProposalsScheduledTaskHandlers();
      for (const kind of [
        'chat.embeddings.backfill',
        'chat.review-layer',
        'chat.runs.prune',
        'proposals.evidence.prune',
        'proposals.replan-stale',
        'proposals.auto-activate',
      ] as const) {
        expect(getScheduledTaskHandler(kind)).not.toBeNull();
      }

      const scheduledRepo = createScheduledTasksRepo(database);
      // Seed system tasks (verifies the seed pipeline boots against
      // the durable bus). We do NOT assert the system tasks ran here
      // — they do, but our focus is the fixture one-shot.
      await seedSystemScheduledTasksIfNeeded({
        db: database,
        bus,
        repo: scheduledRepo,
      });

      const runSubscriber = createScheduledRunSubscriber({
        db: database,
        bus,
        repo: scheduledRepo,
        llm: llmClient,
      });
      runSubscriber.start();
      const scheduler = createScheduler({
        db: database,
        bus,
        repo: scheduledRepo,
        role: 'worker',
        // Skip boot recovery's `skipped_offline` sweep: the seeded
        // system tasks have `next_run_at` set to "now-ish" and the
        // sweep would otherwise generate one skipped row per task,
        // which is correct behaviour but noisy for the assertions
        // below.
        bootRecoveryGraceMultiplier: 1_000_000,
      });
      // We don't call `scheduler.start()` — the test drives the
      // single tick directly so it never depends on a wall-clock
      // setInterval.

      // -------------------------------------------------------------
      // 3. Pre-seed the one-shot task row with a past `next_run_at`.
      // -------------------------------------------------------------
      const layersRepo = createLayersRepo(database);
      const everyone = layersRepo.getLayerBySlug(EVERYONE_LAYER_SLUG);
      if (everyone === null) throw new Error('smoke-worker: everyone layer not found post-seed');
      const adminUserId = getMeta(database, ADMIN_USER_ID_KEY);
      if (adminUserId === null) throw new Error('smoke-worker: admin user id missing');
      const past = new Date(Date.now() - 60_000).toISOString();
      const inserted = scheduledRepo.insertTask({
        id: crypto.randomUUID(),
        layerId: everyone.id,
        slug: 'smoke-worker-one-shot',
        kind: 'smoke.worker.one-shot',
        name: 'Smoke worker one-shot',
        schedule: { kind: 'interval', intervalMinutes: 1 },
        nextRunAt: past,
        createdBy: adminUserId,
        now: new Date().toISOString(),
      });

      // -------------------------------------------------------------
      // 4. Tick + drain. The tick publishes
      //    `scheduledtask.run.requested`; `drain()` delivers it
      //    synchronously so the smoke does not race the 250 ms poll.
      // -------------------------------------------------------------
      const emitted = await scheduler.tickOnce();
      expect(emitted).toBeGreaterThanOrEqual(1);
      await bus.drain();

      // -------------------------------------------------------------
      // 5. Assertions on the run row + the durable outbox.
      // -------------------------------------------------------------
      expect(handlerInvocations).toBeGreaterThanOrEqual(1);
      const runs = scheduledRepo.listRunsForTask(inserted.id);
      const succeeded = runs.filter((r) => r.status === 'succeeded');
      expect(succeeded.length).toBeGreaterThanOrEqual(1);
      const refreshed = scheduledRepo.getTaskById(inserted.id);
      expect(refreshed?.attempt).toBe(0);
      expect(refreshed?.nextRunAt).not.toBe(past);

      // The outbox: at least one `delivered` row exists for the
      // scheduled-task event family. We assert the count rather than
      // a specific id because the durable adapter also delivered the
      // `scheduledtask.created` events emitted by the system-task
      // seed above.
      const delivered = database
        .query<
          OutboxRow,
          []
        >("SELECT status FROM bus_outbox WHERE type = 'scheduledtask.run.requested'")
        .all();
      expect(delivered.length).toBeGreaterThanOrEqual(1);
      expect(delivered.every((r) => r.status === 'delivered')).toBe(true);

      // The subscriber's offset row advanced (proves the consume
      // loop actually walked the outbox).
      const offset = database
        .query<OffsetRow, [string]>('SELECT last_id FROM bus_offsets WHERE subscriber_key = ?')
        .get('smoke-worker');
      expect(offset).not.toBeNull();
      expect(typeof offset?.last_id).toBe('string');

      // -------------------------------------------------------------
      // 6. `/status` body — assert `role: 'worker'` is faithfully
      //    surfaced when the app is constructed with that role.
      // -------------------------------------------------------------
      const lanceTables: string[] = [];
      const status = (): StatusBody => ({
        app: 'bunny2',
        version: '0.0.0',
        phase: '3.6',
        role: 'worker',
        ok: true,
        dataDir: tmpDir,
        configFile: null,
        sqlite: { schemaVersion },
        lancedb: { ready: true, tables: lanceTables },
        bus: { adapter: 'durable-sqlite', events: eventLog.count() },
        llm: { endpoint: llmClient.endpoint, defaultModel: llmClient.defaultModel, calls: 0 },
        auth: {
          sessions: 0,
          users: 0,
          groups: 0,
          adminSeeded: true,
          adminGroupResolved: true,
        },
      });
      const app = createApp({
        bus,
        llmClient,
        status,
        db: database,
        auth: AuthConfigSchema.parse({}),
        resolver,
        layerResolver,
        locales: LocalesConfigSchema.parse({}),
        scheduledRepo,
      });
      const res = await app.fetch(new Request('http://localhost/status'));
      expect(res.status).toBe(200);
      const body = (await res.json()) as StatusBody;
      expect(body.role).toBe('worker');
      expect(body.bus.adapter).toBe('durable-sqlite');
      expect(body.ok).toBe(true);

      runSubscriber.stop();
      scheduler.stop();
    } finally {
      __resetScheduledTaskRegistryForTests();
      bus.stop();
    }
  });
});

// ---------------------------------------------------------------------
// Phase 7.7 — proposals-domain scheduled-task handlers register under
// `--role=worker`. Mirrors the chat-domain assertion already inlined
// in the spine test above, but as a dedicated describe so a regression
// fails with a clear name.
// ---------------------------------------------------------------------

describe('phase 7.7 — proposals-domain scheduled-task handlers (--role=worker)', () => {
  it('registers proposals.evidence.prune and proposals.replan-stale', () => {
    __resetScheduledTaskRegistryForTests();
    try {
      registerProposalsScheduledTaskHandlers();
      // Both kinds must resolve to a non-null handler — matching the
      // rows in `docs/dev/architecture/job-inventory.md` and the
      // assertions in `tests/docs/job-inventory.test.ts`. The smoke
      // does not exercise these handlers end-to-end (the per-handler
      // unit tests do); this is the registration contract.
      const evidence = getScheduledTaskHandler('proposals.evidence.prune');
      const replanStale = getScheduledTaskHandler('proposals.replan-stale');
      expect(evidence).not.toBeNull();
      expect(replanStale).not.toBeNull();
      expect(evidence?.kind).toBe('proposals.evidence.prune');
      expect(replanStale?.kind).toBe('proposals.replan-stale');
    } finally {
      __resetScheduledTaskRegistryForTests();
    }
  });
});

// ---------------------------------------------------------------------
// Phase 8.6 — `proposals.auto-activate` registers under `--role=worker`.
// The handler kind ships in phase 8.3; this smoke pins that
// `registerProposalsScheduledTaskHandlers()` (the one boot helper
// `apps/server/src/index.ts` calls on every role) leaves it
// resolvable so the seeded `scheduled_tasks` row finds a handler.
// Mirrors the phase-7.7 block above; matches the row in
// `docs/dev/architecture/job-inventory.md` + the assertion in
// `tests/docs/job-inventory.test.ts`.
// ---------------------------------------------------------------------

describe('phase 8.6 — proposals.auto-activate handler registers (--role=worker)', () => {
  it('registers proposals.auto-activate', () => {
    __resetScheduledTaskRegistryForTests();
    try {
      registerProposalsScheduledTaskHandlers();
      const autoActivate = getScheduledTaskHandler('proposals.auto-activate');
      expect(autoActivate).not.toBeNull();
      expect(autoActivate?.kind).toBe('proposals.auto-activate');
    } finally {
      __resetScheduledTaskRegistryForTests();
    }
  });
});

// ---------------------------------------------------------------------
// Phase 11.6 — whiteboards enrichment runs once in `--role=worker` and
// writes a deterministic summary to `entity_souls.memory_json` against
// a fixture scene. Mirrors the 5.7 / 6.7 worker shape: pre-seed a
// whiteboard, register the production module, call
// `runWhiteboardsEnrichSweep` directly (the pure entry point exported
// for exactly this), and assert the soul row carries the canned LLM
// response. A second sweep at the same version is a no-op (idempotent
// on `summarySourceVersion`).
// ---------------------------------------------------------------------

import {
  __resetEntityRegistryForTests,
  createEntityStore as createEntityStoreForWorker,
  registerEntityModule,
} from '../src/entities';
import {
  createWhiteboardModule,
  whiteboardEnrichmentJobs,
  runWhiteboardsEnrichSweep,
  readWhiteboardSummary,
} from '../src/entities/whiteboards';
import { createUsersRepo } from '../src/repos/users-repo';
import type { ChatRequest, ChatResponse } from '../src/llm';
import type { WhiteboardPayload } from '@bunny2/shared';

describe('phase 11.6 — whiteboards enrichment sweep (--role=worker)', () => {
  it('runs the enrichment sweep once and writes a deterministic summary to entity_souls', async () => {
    // Fresh data-dir so the sweep does not collide with the
    // top-of-file `phase 5.7` smoke that owns `tmpDir`. Mirrors the
    // pattern phase 8.6's `localTmpDir` uses.
    const localTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-smoke-worker-whiteboards-'));
    let localDb: Database | null = null;
    try {
      const database = openDatabase(localTmpDir);
      localDb = database;
      const fixtureBus = new DurableSqliteMessageBus(database, {
        writeEvent: (event) => writeEventRow(database, event),
        middlewares: [correlationIdMiddleware, errorCaptureMiddleware()],
        subscriberKey: 'smoke-worker-whiteboards',
      });
      fixtureBus.start();

      // Register the production whiteboards module so
      // `runWhiteboardsEnrichSweep` (and any downstream
      // `getEntityModule('whiteboard')` lookup) sees the jobs slot.
      __resetEntityRegistryForTests();
      const whiteboardMod = createWhiteboardModule({
        connectors: [],
        enrichmentJobs: whiteboardEnrichmentJobs,
      });
      registerEntityModule(whiteboardMod);

      // Stub LLM returns a fixed summary — the headline determinism
      // assertion. The mention resolver job runs too (the sweep
      // invokes both jobs in sequence), but the layer has no other
      // entities so it produces zero external-link inserts and never
      // calls the LLM.
      const canned = 'Fixture scene summary for the worker-role smoke.';
      const llmCalls: { flowId: string | undefined }[] = [];
      const stubLlm: LlmClient = {
        endpoint: 'mock://smoke-worker-whiteboards',
        defaultModel: 'mock-default',
        async chat(req: ChatRequest): Promise<ChatResponse> {
          const flowId = typeof req.metadata?.flowId === 'string' ? req.metadata.flowId : undefined;
          llmCalls.push({ flowId });
          return {
            id: crypto.randomUUID(),
            model: 'mock-default',
            content: canned,
            tokensIn: 8,
            tokensOut: 9,
            raw: null,
          };
        },
      };

      // Boot helpers — admin user + the layer seed so we have a real
      // (project) layer to attach the whiteboard to.
      await seedAdminIfNeeded({ db: database, bus: fixtureBus });
      const resolver = createGroupResolver({ db: database, bus: fixtureBus });
      await seedLayersIfNeeded({
        db: database,
        bus: fixtureBus,
        transitiveGroups: resolver,
      });
      const nowIso = new Date().toISOString();
      const userId = crypto.randomUUID();
      createUsersRepo(database).createUser({
        id: userId,
        username: 'smoke-worker-wb',
        displayName: 'Smoke Worker WB',
        passwordHash: 'h',
        mustChangePassword: false,
        now: nowIso,
      });
      const layerId = createLayersRepo(database).insertLayer({
        id: crypto.randomUUID(),
        type: 'project',
        slug: 'smoke-worker-whiteboards',
        name: 'Smoke Worker Whiteboards',
        now: nowIso,
      }).id;

      // Pre-seed a whiteboard via the store with a fixture scene
      // containing a single text element. Per ADR 0028 element bodies
      // are opaque — only `type`/`id`/`version` are validated.
      const wbStore = createEntityStoreForWorker<WhiteboardPayload>({
        module: whiteboardMod,
        db: database,
        bus: fixtureBus,
        llm: stubLlm,
      });
      const fixtureScene: WhiteboardPayload = {
        scene: {
          elements: [
            {
              id: 'fix-1',
              type: 'text',
              version: 1,
              text: 'Q3 onboarding plan with deterministic fixture content',
            } as unknown as WhiteboardPayload['scene']['elements'][number],
          ],
        },
        files: {},
      };
      const wb = await wbStore.create({
        layerId,
        slug: 'worker-fixture',
        title: 'Worker fixture',
        originalLocale: 'en',
        payload: fixtureScene,
        actorId: userId,
      });

      // Run the sweep ONCE. The headline assertion: the soul row now
      // carries the canned LLM content + the matching source version.
      const result = await runWhiteboardsEnrichSweep({
        db: database,
        bus: fixtureBus,
        llm: stubLlm,
        config: { maxPerSweep: 10 },
      });
      expect(result.considered).toBe(1);
      expect(result.enriched).toBe(1);
      expect(result.failed).toBe(0);

      const soul = readWhiteboardSummary(database, wb.id);
      expect(soul).not.toBeNull();
      expect(soul?.summary).toBe(canned);
      expect(soul?.sourceVersion).toBe(wb.meta.version);

      // The summary job called the stub LLM exactly once for this
      // sweep (mention resolver is LLM-free).
      const summaryCalls = llmCalls.filter(
        (c) => c.flowId === 'enrichment:whiteboard.sceneSummary',
      );
      expect(summaryCalls.length).toBe(1);

      // A second sweep at the same version is a no-op (idempotent on
      // `summarySourceVersion`). Pin that here too so a regression in
      // the stamp logic surfaces in the worker-role smoke.
      const second = await runWhiteboardsEnrichSweep({
        db: database,
        bus: fixtureBus,
        llm: stubLlm,
        config: { maxPerSweep: 10 },
      });
      expect(second.considered).toBe(0);
      expect(llmCalls.length).toBe(summaryCalls.length); // unchanged

      fixtureBus.stop();
    } finally {
      __resetEntityRegistryForTests();
      if (localDb !== null) {
        try {
          localDb.close();
        } catch {
          /* already closed */
        }
      }
      try {
        safeRmSync(localTmpDir);
      } catch {
        /* best-effort */
      }
    }
  });
});
