import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import {
  InMemoryMessageBus,
  correlationIdMiddleware,
  errorCaptureMiddleware,
  telemetryMiddleware,
} from '@bunny2/bus';
import { createApp } from '../../src/http/router';
import type { StatusBody } from '../../src/http/router';
import { createLlmClient } from '../../src/llm/client';
import { createSqliteEventLog } from '../../src/bus/event-log';
import { openDatabase } from '../../src/storage/sqlite';
import { AuthConfigSchema } from '../../src/config/schema';

/**
 * Test fixture: temp data-dir, real SQLite + migrations, real bus with the
 * full middleware chain (so `events` rows land), real LLM mock, and the
 * production `createApp` wiring. Returns a tear-down helper so tests can
 * close the DB and remove the temp dir in a `finally` block.
 */
export interface TestApp {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
  readonly app: { fetch: (req: Request) => Response | Promise<Response> };
  cleanup(): void;
}

export function makeTestApp(prefix = 'bunny2-auth-test-'): TestApp {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const db = openDatabase(dir);
  const eventLog = createSqliteEventLog(db);
  const bus = new InMemoryMessageBus({
    middlewares: [
      correlationIdMiddleware,
      telemetryMiddleware(eventLog.writer),
      errorCaptureMiddleware(),
    ],
  });
  const llmClient = createLlmClient({
    endpoint: 'mock://echo',
    apiKey: '',
    defaultModel: 'mock-default',
  });
  const status = (): StatusBody => ({
    app: 'bunny2',
    version: '0.0.0',
    phase: '2.3',
    ok: true,
    dataDir: dir,
    configFile: null,
    sqlite: { schemaVersion: '0002_users_groups' },
    lancedb: { ready: true, tables: [] },
    bus: { adapter: 'in-memory', events: eventLog.count() },
    llm: { endpoint: 'mock://echo', defaultModel: 'mock-default', calls: 0 },
    auth: { sessions: 0, users: 0, groups: 0, adminSeeded: false },
  });
  const app = createApp({ bus, llmClient, status, db, auth: AuthConfigSchema.parse({}) });
  return {
    dir,
    db,
    bus,
    app,
    cleanup() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}
