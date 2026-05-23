/**
 * Phase 1.7 — end-to-end smoke test.
 *
 * This is the canonical "spine" test for phase 1: it goes through
 * `loadConfig()` (data-dir + schema defaults), opens the real SQLite +
 * LanceDB, builds the real bus with all middlewares, wires the real
 * telemetry-wrapped LLM client against the deterministic `mock://echo`
 * provider, and drives the real HTTP layer via `createApp(deps).fetch`.
 *
 * It differs from `http-chat.test.ts` (which mocks the status body and
 * skips `loadConfig`) by:
 *
 *  - Using `BUNNY2_DATA_DIR` to point `loadConfig()` at a temp dir, so
 *    every layer — config, migrations, LanceDB scaffolding, retention
 *    knob — is exercised.
 *  - Hitting `GET /status` and asserting the structural fields that the
 *    UI and the manual checklist rely on (phase, sqlite.schemaVersion,
 *    lancedb.ready, bus.adapter, llm.endpoint, llm.calls).
 *  - Sequencing `/status` → `/chat` → `/status` and observing
 *    `llm.calls` tick from 0 to 1, which proves the call log is live
 *    and shared across requests.
 *  - Asserting matching `correlation_id` across the SQLite `events` and
 *    `llm_calls` rows for the same request.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  InMemoryMessageBus,
  correlationIdMiddleware,
  errorCaptureMiddleware,
  telemetryMiddleware,
} from '@bunny2/bus';
import { loadConfig } from '../src/config';
import { openDatabase } from '../src/storage/sqlite';
import { currentSchemaVersion } from '../src/storage/migrations';
import { openLanceDB } from '../src/storage/lancedb';
import { createSqliteEventLog } from '../src/bus/event-log';
import {
  createLlmClient,
  createSqliteLlmCallLog,
  withTelemetry,
  type LlmCallLog,
} from '../src/llm';
import { createApp } from '../src/http/router';
import type { StatusBody } from '../src/http/router';
import { seedUserAndSession } from './_helpers/auth';

interface ChatSuccessBody {
  content: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  correlationId: string;
}

interface EventRow {
  type: string;
  correlation_id: string | null;
  flow_id: string | null;
}

interface LlmCallRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  model: string;
  endpoint: string;
  correlation_id: string | null;
  flow_id: string | null;
  error: string | null;
}

// Captured per-suite so the `afterAll` teardown does not depend on
// describe-block-scoped variables when something throws early.
let tmpDir: string;
let prevDataDir: string | undefined;
let db: Database | null = null;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-smoke-'));
  prevDataDir = process.env['BUNNY2_DATA_DIR'];
  process.env['BUNNY2_DATA_DIR'] = tmpDir;
});

afterAll(() => {
  if (db !== null) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  if (prevDataDir === undefined) {
    delete process.env['BUNNY2_DATA_DIR'];
  } else {
    process.env['BUNNY2_DATA_DIR'] = prevDataDir;
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('phase 1.7 smoke — config + storage + bus + LLM + HTTP round-trip', () => {
  it('drives /status, /chat, and asserts the SQLite event + llm_calls rows', async () => {
    // 1. Real config layer picks up BUNNY2_DATA_DIR.
    const loaded = loadConfig();
    expect(loaded.dataDir).toBe(tmpDir);
    expect(loaded.config.llm.endpoint).toBe('mock://echo');

    // 2. Real SQLite, real migrations, real LanceDB scaffolding.
    db = openDatabase(loaded.dataDir);
    const lance = await openLanceDB(loaded.dataDir);
    const lanceTables = await lance.tableNames();
    const schemaVersion = currentSchemaVersion(db);
    expect(schemaVersion).not.toBeNull();
    expect(fs.existsSync(path.join(loaded.dataDir, 'bunny2.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(loaded.dataDir, 'lancedb'))).toBe(true);

    // 3. Real bus + event log + middleware chain (matches index.ts).
    const eventLog = createSqliteEventLog(db);
    const bus = new InMemoryMessageBus({
      middlewares: [
        correlationIdMiddleware,
        telemetryMiddleware(eventLog.writer),
        errorCaptureMiddleware(() => {
          /* swallow during smoke */
        }),
      ],
    });

    // 4. Real LLM client + telemetry wrapper against `mock://echo`.
    const callLog: LlmCallLog = createSqliteLlmCallLog(db);
    const rawClient = createLlmClient({
      endpoint: loaded.config.llm.endpoint,
      apiKey: loaded.config.llm.apiKey,
      defaultModel: loaded.config.llm.defaultModel,
    });
    const llmClient = withTelemetry(rawClient, {
      log: callLog,
      pricing: loaded.config.llm.pricing,
    });

    // 5. Real HTTP app — exactly the wiring `index.ts` uses, minus
    //    `Bun.serve` (we go in-process via `app.fetch` to keep the test
    //    deterministic and port-free).
    const status = (): StatusBody => ({
      app: 'bunny2',
      version: '0.0.0',
      phase: '1.7',
      ok: true,
      dataDir: loaded.dataDir,
      configFile: loaded.configFile,
      sqlite: { schemaVersion },
      lancedb: { ready: true, tables: lanceTables },
      bus: { adapter: 'in-memory', events: eventLog.count() },
      llm: {
        endpoint: llmClient.endpoint,
        defaultModel: llmClient.defaultModel,
        calls: callLog.count(),
      },
      auth: { sessions: 0, users: 0, groups: 0 },
    });
    const app = createApp({ bus, llmClient, status, db, auth: loaded.config.auth });
    // Auth gate is live from 2.2: seed a user + session so the `/chat`
    // round-trip below carries a valid Bearer token. `/status` is public
    // and does not need the header. Smoke does not assert specific
    // session counts so the hardcoded `auth` block above stays valid
    // for the structural-equality checks.
    const seeded = seedUserAndSession(db);

    // 6. GET /status (before any chat) — asserts structural fields the
    //    plan calls out explicitly.
    const statusBefore = await app.fetch(new Request('http://localhost/status'));
    expect(statusBefore.status).toBe(200);
    const statusBeforeBody = (await statusBefore.json()) as StatusBody;
    expect(statusBeforeBody.ok).toBe(true);
    expect(statusBeforeBody.phase).toBe('1.7');
    expect(statusBeforeBody.sqlite.schemaVersion).toBe(schemaVersion);
    expect(statusBeforeBody.lancedb.ready).toBe(true);
    expect(statusBeforeBody.bus.adapter).toBe('in-memory');
    expect(statusBeforeBody.llm.endpoint).toBe('mock://echo');
    expect(statusBeforeBody.llm.calls).toBe(0);

    // 7. POST /chat against the deterministic mock provider. Carries
    //    the seeded Bearer token — the 2.2 auth middleware gates this
    //    route and rejects unauthenticated calls with 401.
    const chatRes = await app.fetch(
      new Request('http://localhost/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${seeded.token}`,
        },
        body: JSON.stringify({ message: 'hello' }),
      }),
    );
    expect(chatRes.status).toBe(200);
    const chatBody = (await chatRes.json()) as ChatSuccessBody;
    expect(chatBody.content.startsWith('echo:')).toBe(true);
    expect(chatBody.content).toBe('echo: hello');
    expect(chatBody.model).toBe(loaded.config.llm.defaultModel);
    expect(chatBody.tokensOut).toBeGreaterThan(0);
    expect(chatBody.correlationId).toBeTruthy();

    // 8. GET /status (after chat) — `llm.calls` ticks from 0 to 1,
    //    `bus.events` ticks from 0 to 2 (chat.requested + chat.responded).
    const statusAfter = await app.fetch(new Request('http://localhost/status'));
    const statusAfterBody = (await statusAfter.json()) as StatusBody;
    expect(statusAfterBody.llm.calls).toBe(1);
    expect(statusAfterBody.bus.events).toBe(2);

    // 9. Direct SQLite read — assert the two event rows and the single
    //    llm_calls row share the same correlation id.
    const events = db
      .query<EventRow, []>('SELECT type, correlation_id, flow_id FROM events ORDER BY rowid ASC')
      .all();
    expect(events.map((e) => e.type)).toEqual(['chat.requested', 'chat.responded']);
    expect(events[0]?.correlation_id).toBe(chatBody.correlationId);
    expect(events[1]?.correlation_id).toBe(chatBody.correlationId);
    expect(events[0]?.flow_id).toBeTruthy();
    expect(events[0]?.flow_id).toBe(events[1]?.flow_id);

    const calls = db
      .query<
        LlmCallRow,
        []
      >('SELECT id, started_at, ended_at, model, endpoint, correlation_id, flow_id, error FROM llm_calls')
      .all();
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.error).toBeNull();
    expect(call?.started_at).toBeTruthy();
    expect(call?.ended_at).toBeTruthy();
    expect(call?.model).toBe(loaded.config.llm.defaultModel);
    expect(call?.endpoint).toBe('mock://echo');
    expect(call?.correlation_id).toBe(chatBody.correlationId);
    expect(call?.flow_id).toBe(events[0]?.flow_id);
  });
});
