import { appName, appVersion } from '@bunny2/shared';
import { loadConfig } from './config';
import { openDatabase } from './storage/sqlite';
import { currentSchemaVersion } from './storage/migrations';
import { openLanceDB } from './storage/lancedb';

const { config, configFile, dataDir } = loadConfig();
const db = openDatabase(dataDir);
const lance = await openLanceDB(dataDir);
const lanceTables = await lance.tableNames();
const schemaVersion = currentSchemaVersion(db);

console.log(`[${appName}] data-dir:    ${dataDir}`);
console.log(`[${appName}] config-file: ${configFile ?? '(defaults)'}`);
console.log(`[${appName}] sqlite:      schema=${schemaVersion ?? '(none)'}`);
console.log(`[${appName}] lancedb:     ${lanceTables.length} table(s)`);

const server = Bun.serve({
  port: config.http.port,
  hostname: config.http.host,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/status') {
      return Response.json({
        app: appName,
        version: appVersion,
        phase: '1.2',
        ok: true,
        dataDir,
        configFile,
        sqlite: { schemaVersion },
        lancedb: { ready: true, tables: lanceTables },
      });
    }
    return new Response('Not Found', { status: 404 });
  },
});

console.log(`[${appName}] listening on http://${server.hostname}:${server.port}`);
