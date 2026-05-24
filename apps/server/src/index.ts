import { appName, appVersion } from '@bunny2/shared';
import {
  DurableSqliteMessageBus,
  correlationIdMiddleware,
  errorCaptureMiddleware,
} from '@bunny2/bus';
import { loadConfig } from './config';
import { parseRole } from './role';
import { openDatabase } from './storage/sqlite';
import { currentSchemaVersion } from './storage/migrations';
import { openLanceDB } from './storage/lancedb';
import { createSqliteEventLog, writeEventRow } from './bus/event-log';
import { createLlmClient, createSqliteLlmCallLog, withTelemetry } from './llm';
import { createApp } from './http/router';
import type { StatusBody } from './http/router';
import { createUsersRepo } from './repos/users-repo';
import { createGroupsRepo } from './repos/groups-repo';
import { createSessionsRepo } from './repos/sessions-repo';
import { seedAdminIfNeeded, ADMIN_SEED_DONE_KEY, ADMIN_GROUP_ID_KEY } from './auth/seed';
import { createGroupResolver } from './auth/group-resolver';
import { getMeta } from './storage/kv-meta';
import { seedLayersIfNeeded } from './layers/seed';
import { createLayerResolver } from './layers/resolver';
import { registerLayerSubscribers } from './layers/subscribers';
import {
  createConnectorDispatcher,
  createConnectorRunner,
  createEnrichmentRunner,
  createEntityStore,
  listEntityModules,
  type EntityStore,
} from './entities';
import { createTodoCalendarProjection } from './entities/todos';
import {
  createScheduledTasksRepo,
  createScheduler,
  createScheduledRunSubscriber,
  registerBuiltInScheduledTaskHandlers,
  seedSystemScheduledTasksIfNeeded,
} from './scheduled';
import {
  registerChatScheduledTaskHandlers,
  createMockEmbedder,
  createOpenAiEmbedder,
  createLanceDbWriter,
  createEmbeddingSubscriber,
  createVectorSearch,
  type Embedder,
} from './chat';
import { attachAgentSubscriber, createCapabilityRegistry } from './proposals';
import { createLayerCapabilitiesRepo } from './proposals/repos/layer-capabilities-repo';

// Phase 5.2 — process role split. `parseRole` accepts the CLI flag
// (`--role=web|worker|all`) and falls back to the `BUNNY2_ROLE` env
// var when the flag is absent (helpful for Docker / PM2 deployments
// that inject the role via the environment). Unknown values throw
// here so a misconfigured deployment fails fast. Default is `all`
// per the plan §4.3 decision #7 — keeps dev runs and the Electron
// sidecar on a single process.
const role = parseRole({ argv: Bun.argv.slice(2), env: process.env });

const { config, configFile, dataDir } = loadConfig();
const db = openDatabase(dataDir);
const lance = await openLanceDB(dataDir);
const lanceTables = await lance.tableNames();
const schemaVersion = currentSchemaVersion(db);

// Phase 5.1 — `DurableSqliteMessageBus` is the only production
// adapter. The atomic `INSERT events + INSERT bus_outbox` happens
// inside the adapter's `publish()` transaction via `writeEventRow`,
// so the old `telemetryMiddleware(eventLog.writer)` is gone — that
// middleware would write the `events` row OUTSIDE the outbox
// transaction, defeating the atomicity guarantee. `correlationIdMiddleware`
// + `errorCaptureMiddleware` still wrap dispatch.
//
// `createSqliteEventLog` is kept around for the `status.bus.events`
// counter that the `/status` page reads — its `writer` is unused on
// the production path (the durable adapter inlines that write).
const eventLog = createSqliteEventLog(db);
// Phase 5.4 — `onDlqAdded` is the after-commit hook the durable
// adapter exposes so the server can publish `bus.dlq.added` without
// publishing from inside the bus's own dispatch loop (which would
// race the in-progress transaction). The publish is fire-and-forget;
// a throw here is logged and swallowed by the adapter so a misbehaving
// notifier never starves the consume loop.
//
// Note on scope: the durable adapter only routes MIDDLEWARE-chain
// errors into `bus_dlq`. Per-handler errors are caught inside the
// adapter's `dispatch` and logged via `onHandlerError`. Application-
// level failures from scheduled-task handlers therefore land in
// `scheduledtask.run.failed` (via the run subscriber's own try/catch),
// not in the DLQ. The DLQ is reserved for infrastructure failures.
const bus = new DurableSqliteMessageBus(db, {
  writeEvent: (event) => writeEventRow(db, event),
  middlewares: [correlationIdMiddleware, errorCaptureMiddleware()],
  subscriberKey: 'server-main',
  onDlqAdded: (info) => {
    void bus.publish({
      type: 'bus.dlq.added',
      payload: {
        outboxId: info.outboxId,
        subscriberKey: info.subscriberKey,
        type: info.type,
        attempts: info.attempts,
        error: info.error,
      },
    });
  },
});
bus.start();
const busAdapterName = 'durable-sqlite';

const llmCallLog = createSqliteLlmCallLog(db);
const rawLlmClient = createLlmClient({
  endpoint: config.llm.endpoint,
  apiKey: config.llm.apiKey,
  defaultModel: config.llm.defaultModel,
});
const llmClient = withTelemetry(rawLlmClient, {
  log: llmCallLog,
  pricing: config.llm.pricing,
});
// Phase 5.5 — LLM-call retention prune used to spawn a bespoke
// `setInterval`. It now runs through the generic scheduler as the
// `llm.calls.prune` handler (registered just below, seeded once into
// the `everyone` layer by `seedSystemScheduledTasksIfNeeded`). The
// run-cadence is governed by the seeded `scheduled_tasks` row and
// `worker` / `all` processes execute it; the old role-gate is gone
// because the scheduler's role-gate already covers it.

const usersRepo = createUsersRepo(db);
const groupsRepo = createGroupsRepo(db);
const sessionsRepo = createSessionsRepo(db);

// One-shot admin bootstrap. Must complete BEFORE `Bun.serve` starts
// accepting connections — otherwise the very first login attempt could
// race the seed and observe a missing user. Also runs BEFORE the
// transitive resolver is built so the resolver's startup read of
// `admin_group_id` (via the `requireAdmin` factory) sees the seeded id.
await seedAdminIfNeeded({ db, bus });

const resolver = createGroupResolver({ db, bus });

// Phase 3.2 — layer seed runs AFTER the admin/group seed and the
// transitive group resolver are ready (it needs `expandUserGroups` to
// wire personal→group edges), and BEFORE the layer resolver subscribes
// or `Bun.serve` accepts requests. Idempotent: subsequent boots fast-
// path on `kv_meta.layers_seed_done`.
await seedLayersIfNeeded({ db, bus, transitiveGroups: resolver });

const layerResolver = createLayerResolver({ db, transitiveGroups: resolver });
registerLayerSubscribers({ db, bus, resolver: layerResolver, transitiveGroups: resolver });

interface LayerStatusCountsRow {
  type: 'personal' | 'project' | 'group' | 'everyone';
  n: number;
}

function layerStatus(): NonNullable<StatusBody['layers']> {
  const active = db
    .query<LayerStatusCountsRow, []>(
      `SELECT type, COUNT(*) AS n FROM layers
        WHERE deleted_at IS NULL GROUP BY type`,
    )
    .all();
  const byType = { personal: 0, project: 0, group: 0, everyone: 0 };
  let total = 0;
  for (const row of active) {
    byType[row.type] = row.n;
    total += row.n;
  }
  const withDeleted = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM layers').get()?.n ?? 0;
  return { total, byType, withDeleted };
}

const status = (): StatusBody => {
  const now = new Date().toISOString();
  return {
    app: appName,
    version: appVersion,
    phase: '3.6',
    role,
    ok: true,
    dataDir,
    configFile,
    sqlite: { schemaVersion },
    lancedb: { ready: true, tables: lanceTables },
    bus: { adapter: busAdapterName, events: eventLog.count() },
    llm: {
      endpoint: llmClient.endpoint,
      defaultModel: llmClient.defaultModel,
      calls: llmCallLog.count(),
    },
    auth: {
      sessions: sessionsRepo.countActiveSessions(now),
      users: usersRepo.countActive(),
      groups: groupsRepo.countActive(),
      adminSeeded: getMeta(db, ADMIN_SEED_DONE_KEY) === 'true',
      adminGroupResolved: getMeta(db, ADMIN_GROUP_ID_KEY) !== null,
    },
    layers: layerStatus(),
  };
};

// Phase 4a.2 — connector dispatcher + interval poll runner. The
// dispatcher subscribes to `entity.connector.sync.requested` once per
// process (NOT per `createApp` call — tests build dozens of apps
// against the same bus and must not stack subscribers; see
// `apps/server/src/entities/connector-dispatcher.ts`). The runner ticks
// every minute by default; it can be disabled via
// `connectors.runnerEnabled = false` for offline / smoke runs.
//
// Phase 4b.2 — the dispatcher also owns the synchronous `ingest`
// entry point hit by `POST /l/:slug/<kind>/_ingest/:connectorId`. We
// pass `llm` so the dispatcher can lazy-build a per-kind `EntityStore`
// the first time `ingest` runs for that kind. Built BEFORE `createApp`
// so the contacts router can mount the ingest route with this same
// instance.
//
// Phase 5.2 — the dispatcher is constructed and `start()`-ed on every
// role (`web`, `worker`, `all`). The web role needs the synchronous
// `ingest(...)` method available in-process for
// `POST /l/:slug/<kind>/_ingest/:connectorId`, and `start()` currently
// bundles two responsibilities behind one call: registering the
// `sync.requested` subscriber AND making the `ingest()` method
// reachable. The subscriber on web is correctness-safe because the
// durable outbox claim is atomic — at most one process delivers each
// row, so subscribing on both web and worker cannot double-execute
// work. The trade-off: a `web`-role process MAY end up handling some
// connector pulls (whichever process wins the outbox claim first), so
// the role split is not yet a strict CPU-isolation boundary for
// connector work. TODO(phase 5.3): disentangle `start()` into a
// dedicated `subscribeSyncRequested()` so web can skip the subscriber
// and only the worker handles `sync.requested` deliveries — that's
// when the role split becomes a hard isolation line for connectors.
const connectorDispatcher = createConnectorDispatcher({ db, bus, llm: llmClient });
connectorDispatcher.start();

// Phase 5.4 — scheduled-tasks repo is shared between the scheduler /
// run-subscriber wiring below and the HTTP routes mounted in
// `createApp`, so a manual `POST .../runs` lands in the same table
// the scheduler tick writes to.
const scheduledRepo = createScheduledTasksRepo(db);

// Phase 7.1 — embedder + LanceDB writer + vector-search helper are
// constructed BEFORE `createApp` so the chat route's
// `EntityStoreForRetrieval` adapter can consult LanceDB on every
// retrieval call. The embedding subscriber (which DOES depend on
// `listEntityModules()` being non-empty) is still started AFTER
// `createApp` further down. The vector helper itself has no
// dependency on the entity module registry.
//
// `MockEmbedder` is the default when `config.embeddings.endpoint` is
// absent — keeps tests / CI / offline dev free of network deps and
// of the `OPENAI_API_KEY` cargo cult. When the endpoint IS set we
// build an `OpenAiEmbedder` against the same secret machinery as
// the chat LLM (the api key lives in the config file, never logged).
function buildEmbedder(): Embedder {
  const cfg = config.embeddings;
  if (cfg.endpoint !== undefined && cfg.endpoint.length > 0) {
    if (cfg.model === undefined || cfg.model.length === 0) {
      throw new Error('config.embeddings.endpoint is set but config.embeddings.model is missing');
    }
    return createOpenAiEmbedder({
      endpoint: cfg.endpoint,
      apiKey: cfg.apiKey ?? '',
      model: cfg.model,
      dimensions: cfg.dimensions,
    });
  }
  return createMockEmbedder();
}
const embedder = buildEmbedder();
const lanceWriter = createLanceDbWriter(lance);
const vectorSearch = createVectorSearch({ embedder, reader: lanceWriter });

// Phase 7.5 — per-process capability registry. Constructed BEFORE
// `createApp` so the chat route can thread it into `runPipeline`
// (the answerer reads activated skills via the registry on every
// answer). Wires `agentSubscriber` so an activation of an `agent`
// capability attaches its handler to the durable bus immediately.
//
// The `web` role intentionally wires the same registry: the answerer
// reads skill / tool rows from the same `layer_capabilities` table
// the `worker` role's activation writes to, so a worker-driven
// `replanOnApproval` is visible to the next chat answer on web.
const layerCapabilitiesRepo = createLayerCapabilitiesRepo(db);
const capabilityRegistry = createCapabilityRegistry({
  repo: layerCapabilitiesRepo,
  bus,
  agentSubscriber: { llm: llmClient },
});

const app = createApp({
  bus,
  llmClient,
  status,
  db,
  auth: config.auth,
  resolver,
  layerResolver,
  locales: config.locales,
  ingestDispatcher: connectorDispatcher,
  ingestMaxBytes: config.connectors.ingestMaxBytes,
  scheduledRepo,
  // Hand the admin DLQ-replay route a typed function pointing at the
  // durable adapter's method. Bound here so the route file never has
  // to import `DurableSqliteMessageBus` (keeps the seam minimal).
  replayDlq: (outboxId) => bus.replayDlq(outboxId),
  // Phase 7.1 — vector read path for the chat pipeline. The helper
  // decides per-call whether to use LanceDB or fall back to the
  // per-kind SQLite LIKE primitive (no embedder, mock embedder, cold
  // corpus, error → LIKE).
  vectorSearch,
  // Phase 7.5 — capability registry threaded into the chat pipeline.
  capabilityRegistry,
});
// Phase 5.2 — the periodic connector poll runner is background work,
// so the `web` role skips `start()`. The runner is still constructed
// (kept as a single shape across roles for review-clarity) but its
// timer never arms. `connectors.runnerEnabled = false` overrides this
// on every role (offline / smoke runs).
const connectorRunner = createConnectorRunner({
  db,
  bus,
  intervalMs: config.connectors.tickMs,
});
if (config.connectors.runnerEnabled && role !== 'web') {
  connectorRunner.start();
}

// Phase 4a.3 — AI enrichment runner. Subscribes to
// `entity.<kind>.{created,updated}` for every registered module that
// declares `enrichmentJobs`, plus `entity.connector.sync.succeeded`. The
// runner is constructed AFTER `createApp` so the entity-module registry
// has every module registered (per-kind sub-phases register inside
// their `mountXRoutes` helper, called from `createApp`).
//
// `resolveStore` builds a per-kind `EntityStore` on demand using the
// telemetry-wrapped `llmClient` so every enrichment-driven `store.update`
// inherits the same LLM client + bus + db the request-time stores use.
const enrichmentStoreCache = new Map<string, EntityStore<unknown>>();
function resolveStoreForModule(module: ReturnType<typeof listEntityModules>[number]) {
  const cached = enrichmentStoreCache.get(module.kind);
  if (cached !== undefined) return cached;
  const store = createEntityStore({ module, db, bus, llm: llmClient });
  enrichmentStoreCache.set(module.kind, store as EntityStore<unknown>);
  return store as EntityStore<unknown>;
}
const enrichmentRunner = createEnrichmentRunner({
  db,
  bus,
  llm: llmClient,
  pricing: config.llm.pricing,
  config: {
    debounceMs: config.enrichment.debounceMs,
    maxRunsPerLayerPerMinute: config.enrichment.maxRunsPerLayerPerMinute,
  },
  resolveStore: resolveStoreForModule,
});
// Phase 5.2 — enrichment is event-driven background work; the `web`
// role does not run it. Worker / `all` start the runner as before.
if (config.enrichment.runnerEnabled && role !== 'web') {
  enrichmentRunner.start();
}

// Phase 4d.6 — todo → calendar projection bridge. Subscribes to
// `entity.todo.{created,updated,deleted,restored}` and maintains the
// `calendar_projection_todos` table. Constructed and started exactly
// once per process (same lifecycle as the connector dispatcher and
// the enrichment runner) so multiple `createApp` calls in production
// — there is one — do not stack subscribers. `rebuild()` runs after
// `start()`: rebuilding scans every non-deleted todo with a non-null
// `due_at` and re-projects them, recovering from any missed events
// between the previous shutdown and this boot. Upserts are
// idempotent so the order vs. concurrent in-flight events does not
// matter.
// Phase 5.2 — the projection subscriber is background work and lives
// on the worker / `all` roles only. The web role serves the read side
// (`mountTodoCalendarProjectionRoutes` in `createApp`) from the
// already-projected table the worker maintains.
const todoCalendarProjection = createTodoCalendarProjection({ db, bus });
if (role !== 'web') {
  todoCalendarProjection.start();
  todoCalendarProjection.rebuild();
}

// Phase 5.3 — scheduled-tasks runtime.
//   - `registerBuiltInScheduledTaskHandlers()` is idempotent and runs
//     on every role so a `web` process can list the registered
//     handler set if a future admin route needs it. Phase 5.5 added
//     deps to this call: the LLM prune handler needs `llmCallLog` +
//     the retention default, and the healthcheck handler stamps
//     `schemaVersion` / `busAdapterName` into its bus payload.
//   - The run subscriber listens on every role: the worker actually
//     executes the handler, but a `web` process owning the
//     subscription is correctness-safe because the durable outbox
//     claim is atomic (the same logic the connector dispatcher
//     comment in this file explains). A future phase may strip the
//     subscription from `web` once we have a sharper isolation
//     boundary.
//   - `scheduler.start()` only arms its tick on `worker` / `all` —
//     `start()` itself checks `role` and no-ops on `web`. The web
//     role keeps the scheduler object around so the same shape ships
//     across every role (review-clarity).
registerBuiltInScheduledTaskHandlers({
  llmCallLog,
  llmRetentionDays: config.llm.retentionDays,
  schemaVersion,
  busAdapter: busAdapterName,
});

// Phase 6.2 — chat embeddings (write-only LanceDB scaffold).
//
// The subscriber is started AFTER `createApp` so every entity module
// has registered itself (per-kind `mountXRoutes` calls register
// inside `createApp`). It runs on every role: the durable bus's
// atomic outbox claim ensures at-most-one delivery, the same logic
// as the connector dispatcher's role comment above.
//
// Phase 7.1 — `embedder` + `lanceWriter` + `vectorSearch` are now
// constructed above `createApp` (the chat route's retrieval adapter
// uses them); the subscriber wiring stays here so the entity-module
// registry has its full set before subscribers attach.
registerChatScheduledTaskHandlers({ embedder, writer: lanceWriter });

// Phase 7.5 — boot re-attach of every active `agent` capability. The
// per-process subscriber wrapper is in-memory only, so a restart
// would otherwise leave activated agents inert until the next
// activate-flow re-attached them. Iteration order is deterministic
// (`(layer_id, name)` ascending) so logs + telemetry from boot are
// stable. Each attach is best-effort; a malformed row (which would
// fail the zod re-check inside `attachAgentSubscriber`) is logged +
// skipped so a single bad row can't block the rest of the registry.
//
// The `web` role re-attaches too: the answerer doesn't need agent
// subscribers, but every role shares the same durable bus and the
// outbox claim is atomic, so duplicate subscriptions across roles
// don't double-execute. A future role-isolation pass may strip this
// to worker-only.
{
  const activeAgents = layerCapabilitiesRepo.listAllActiveByKind('agent');
  let attachedCount = 0;
  for (const row of activeAgents) {
    const attached = attachAgentSubscriber(
      {
        id: row.id,
        layerId: row.layerId,
        kind: row.kind,
        name: row.name,
        specJson: row.specJson,
        origin: row.origin,
        activatedAt: row.activatedAt,
        deactivatedAt: row.deactivatedAt,
      },
      { bus, llm: llmClient },
    );
    if (attached !== null) attachedCount += 1;
  }
  console.log(`[${appName}] capability.agents: ${attachedCount} re-attached`);
}

const embeddingSubscriber = createEmbeddingSubscriber({
  bus,
  embedder,
  writer: lanceWriter,
  modules: listEntityModules(),
  fetchEntity: (kind, id) => {
    // Lazy per-kind store lookup mirroring the enrichment runner's
    // `resolveStoreForModule` cache above. We only build a store the
    // first time a `restored` event for that kind hits the subscriber.
    const module = listEntityModules().find((m) => m.kind === kind);
    if (module === undefined) return null;
    const store = resolveStoreForModule(module);
    const entity = store.getById(id);
    if (entity === null) return null;
    return {
      id: entity.id,
      layerId: entity.layerId,
      kind: entity.kind,
      slug: entity.slug,
      searchableText: entity.searchableText,
    };
  },
});
embeddingSubscriber.start();
// Phase 5.5 — seed the four system scheduled tasks into the
// `everyone` layer. Runs on EVERY role (one-shot row insert; the
// worker/all role owns execution via the scheduler tick). MUST run
// AFTER `seedLayersIfNeeded` (needs the everyone layer id) and AFTER
// `seedAdminIfNeeded` (needs `admin_user_id` from kv_meta for the
// `created_by` FK), and AFTER `registerBuiltInScheduledTaskHandlers`
// above (needs each handler's `defaultSchedule`).
const systemTasksSeedResult = await seedSystemScheduledTasksIfNeeded({
  db,
  bus,
  repo: scheduledRepo,
});
const scheduledRunSubscriber = createScheduledRunSubscriber({
  db,
  bus,
  repo: scheduledRepo,
  llm: llmClient,
});
scheduledRunSubscriber.start();
const scheduler = createScheduler({
  db,
  bus,
  repo: scheduledRepo,
  role,
});
scheduler.start();

console.log(`[${appName}] data-dir:    ${dataDir}`);
console.log(`[${appName}] config-file: ${configFile ?? '(defaults)'}`);
console.log(`[${appName}] role:        ${role}`);
console.log(`[${appName}] sqlite:      schema=${schemaVersion ?? '(none)'}`);
console.log(`[${appName}] lancedb:     ${lanceTables.length} table(s)`);
console.log(`[${appName}] bus:         ${busAdapterName} (events=${eventLog.count()})`);
console.log(
  `[${appName}] llm:         ${llmClient.endpoint} (default=${llmClient.defaultModel}, calls=${llmCallLog.count()})`,
);
console.log(`[${appName}] scheduler:   ${role === 'web' ? 'disabled, role=web' : 'enabled'}`);
console.log(`[${appName}] embeddings:  ${embedder.id} (dims=${embedder.dimensions})`);
console.log(
  `[${appName}] system-tasks: ${systemTasksSeedResult.seeded ? `${systemTasksSeedResult.created} seeded` : 'already seeded'}`,
);

// The runner / dispatcher / enrichment runner own subscriptions /
// timers that must outlive boot. The lint rule complains about
// unused locals; `void` keeps them alive without weakening the type.
void connectorDispatcher;
void connectorRunner;
void enrichmentRunner;
void todoCalendarProjection;
void scheduler;
void scheduledRunSubscriber;
void embeddingSubscriber;

// Phase 5.2 — the `worker` role does background work only and binds
// no TCP port. The `web` and `all` roles serve HTTP as before. The
// durable bus runs on every role (the `bus.start()` call above) so a
// worker-only process still drains the outbox, and a web-only
// process still publishes into it for a worker to pick up.
if (role === 'worker') {
  console.log(`[${appName}] worker mode — no HTTP listener`);
} else {
  const server = Bun.serve({
    port: config.http.port,
    hostname: config.http.host,
    fetch: app.fetch,
  });
  console.log(`[${appName}] listening on http://${server.hostname}:${server.port}`);
}
