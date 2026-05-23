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
import { seedAdminIfNeeded, ADMIN_SEED_DONE_KEY } from './auth/seed';
import { getMeta } from './storage/kv-meta';

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

const status = (): StatusBody => {
  const now = new Date().toISOString();
  return {
    app: appName,
    version: appVersion,
    phase: '2.3',
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
    },
  };
};

// One-shot admin bootstrap. Must complete BEFORE `Bun.serve` starts
// accepting connections — otherwise the very first login attempt could
// race the seed and observe a missing user.
await seedAdminIfNeeded({ db, bus });

const app = createApp({ bus, llmClient, status, db, auth: config.auth });

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
