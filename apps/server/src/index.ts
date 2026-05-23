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

console.log(`[${appName}] data-dir:    ${dataDir}`);
console.log(`[${appName}] config-file: ${configFile ?? '(defaults)'}`);
console.log(`[${appName}] sqlite:      schema=${schemaVersion ?? '(none)'}`);
console.log(`[${appName}] lancedb:     ${lanceTables.length} table(s)`);
console.log(`[${appName}] bus:         ${busAdapterName} (events=${eventLog.count()})`);
console.log(
  `[${appName}] llm:         ${llmClient.endpoint} (default=${llmClient.defaultModel}, calls=${llmCallLog.count()})`,
);

// Bind so they are reachable from later sub-phases (chat handler in 1.5).
void bus;
void llmClient;
void llmPrune;

const server = Bun.serve({
  port: config.http.port,
  hostname: config.http.host,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/status') {
      return Response.json({
        app: appName,
        version: appVersion,
        phase: '1.4',
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
      });
    }
    return new Response('Not Found', { status: 404 });
  },
});

console.log(`[${appName}] listening on http://${server.hostname}:${server.port}`);
