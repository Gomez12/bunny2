import { appName, appVersion } from '@bunny2/shared';
import {
  InMemoryMessageBus,
  correlationIdMiddleware,
  errorCaptureMiddleware,
  telemetryMiddleware,
} from '@bunny2/bus';
import { loadConfig } from './config';
import { openDatabase } from './storage/sqlite';
import { currentSchemaVersion } from './storage/migrations';
import { openLanceDB } from './storage/lancedb';
import { createSqliteEventLog } from './bus/event-log';
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

const { config, configFile, dataDir } = loadConfig();
const db = openDatabase(dataDir);
const lance = await openLanceDB(dataDir);
const lanceTables = await lance.tableNames();
const schemaVersion = currentSchemaVersion(db);

const eventLog = createSqliteEventLog(db);
const bus = new InMemoryMessageBus({
  middlewares: [
    correlationIdMiddleware,
    telemetryMiddleware(eventLog.writer),
    errorCaptureMiddleware(),
  ],
});
const busAdapterName = 'in-memory';

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
const llmPrune = startLlmRetentionPrune({
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

const app = createApp({
  bus,
  llmClient,
  status,
  db,
  auth: config.auth,
  resolver,
  layerResolver,
  locales: config.locales,
});

console.log(`[${appName}] data-dir:    ${dataDir}`);
console.log(`[${appName}] config-file: ${configFile ?? '(defaults)'}`);
console.log(`[${appName}] sqlite:      schema=${schemaVersion ?? '(none)'}`);
console.log(`[${appName}] lancedb:     ${lanceTables.length} table(s)`);
console.log(`[${appName}] bus:         ${busAdapterName} (events=${eventLog.count()})`);
console.log(
  `[${appName}] llm:         ${llmClient.endpoint} (default=${llmClient.defaultModel}, calls=${llmCallLog.count()})`,
);

// Keep the prune handle reachable so the GC does not collect its interval.
void llmPrune;

const server = Bun.serve({
  port: config.http.port,
  hostname: config.http.host,
  fetch: app.fetch,
});

console.log(`[${appName}] listening on http://${server.hostname}:${server.port}`);
