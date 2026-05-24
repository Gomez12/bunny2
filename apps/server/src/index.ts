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
import {
  createLlmClient,
  createSqliteLlmCallLog,
  startLlmRetentionPrune,
  withTelemetry,
} from './llm';
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
const bus = new DurableSqliteMessageBus(db, {
  writeEvent: (event) => writeEventRow(db, event),
  middlewares: [correlationIdMiddleware, errorCaptureMiddleware()],
  subscriberKey: 'server-main',
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
// Phase 5.2 — LLM-call retention prune is a periodic background job, so
// it only runs on roles that do background work (`worker` / `all`).
// Phase 5.5 will move this onto the generic scheduled-tasks registry.
const llmPrune =
  role === 'web'
    ? null
    : startLlmRetentionPrune({
        log: llmCallLog,
        retentionDays: config.llm.retentionDays,
      });

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
//
// Phase 5.3 will add the scheduler tick here (also worker / `all`
// only) — placeholder reserved.
const todoCalendarProjection = createTodoCalendarProjection({ db, bus });
if (role !== 'web') {
  todoCalendarProjection.start();
  todoCalendarProjection.rebuild();
}

console.log(`[${appName}] data-dir:    ${dataDir}`);
console.log(`[${appName}] config-file: ${configFile ?? '(defaults)'}`);
console.log(`[${appName}] role:        ${role}`);
console.log(`[${appName}] sqlite:      schema=${schemaVersion ?? '(none)'}`);
console.log(`[${appName}] lancedb:     ${lanceTables.length} table(s)`);
console.log(`[${appName}] bus:         ${busAdapterName} (events=${eventLog.count()})`);
console.log(
  `[${appName}] llm:         ${llmClient.endpoint} (default=${llmClient.defaultModel}, calls=${llmCallLog.count()})`,
);

// Keep the prune handle reachable so the GC does not collect its interval.
void llmPrune;
// Same for the runner / dispatcher / enrichment runner — they own
// subscriptions / timers that must outlive boot. The lint rule complains
// about unused locals; `void` keeps them alive without weakening the type.
void connectorDispatcher;
void connectorRunner;
void enrichmentRunner;
void todoCalendarProjection;

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
