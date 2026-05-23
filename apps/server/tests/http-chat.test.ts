import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  InMemoryMessageBus,
  correlationIdMiddleware,
  errorCaptureMiddleware,
  telemetryMiddleware,
} from '@bunny2/bus';
import { openDatabase } from '../src/storage/sqlite';
import { createSqliteEventLog } from '../src/bus/event-log';
import { createSqliteLlmCallLog } from '../src/llm/call-log';
import { createLlmClient } from '../src/llm/client';
import { withTelemetry } from '../src/llm/telemetry';
import { createApp } from '../src/http/router';
import type { StatusBody } from '../src/http/router';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-http-chat-'));
}

interface EventRow {
  type: string;
  payload: string;
  correlation_id: string | null;
  flow_id: string | null;
}

interface LlmCallRow {
  id: string;
  model: string;
  endpoint: string;
  tokens_in: number | null;
  tokens_out: number | null;
  error: string | null;
  correlation_id: string | null;
  flow_id: string | null;
}

interface ChatSuccessBody {
  content: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  correlationId: string;
}

interface ChatErrorBody {
  error: string;
  correlationId?: string;
}

function status(): StatusBody {
  return {
    app: 'bunny2',
    version: '0.0.0',
    phase: '1.7',
    ok: true,
    dataDir: '/tmp/test',
    configFile: null,
    sqlite: { schemaVersion: '0001_init' },
    lancedb: { ready: true, tables: [] },
    bus: { adapter: 'in-memory', events: 0 },
    llm: { endpoint: 'mock://echo', defaultModel: 'mock-default', calls: 0 },
  };
}

describe('POST /chat', () => {
  it('publishes chat.requested and chat.responded events, writes one llm_calls row, returns response shape', async () => {
    const dir = mkTmp();
    const db = openDatabase(dir);
    try {
      const eventLog = createSqliteEventLog(db);
      const bus = new InMemoryMessageBus({
        middlewares: [
          correlationIdMiddleware,
          telemetryMiddleware(eventLog.writer),
          errorCaptureMiddleware(() => {
            /* swallow in test */
          }),
        ],
      });
      const callLog = createSqliteLlmCallLog(db);
      const raw = createLlmClient({
        endpoint: 'mock://echo',
        apiKey: '',
        defaultModel: 'mock-default',
      });
      const llmClient = withTelemetry(raw, { log: callLog });

      const app = createApp({ bus, llmClient, status });
      const res = await app.fetch(
        new Request('http://localhost/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'hello world' }),
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as ChatSuccessBody;
      expect(body.content).toBe('echo: hello world');
      expect(body.model).toBe('mock-default');
      expect(body.tokensIn).toBeGreaterThanOrEqual(0);
      expect(body.tokensOut).toBeGreaterThan(0);
      expect(body.correlationId).toBeTruthy();

      const events = db
        .query<
          EventRow,
          []
        >('SELECT type, payload, correlation_id, flow_id FROM events ORDER BY rowid ASC')
        .all();
      const types = events.map((e) => e.type);
      expect(types).toEqual(['chat.requested', 'chat.responded']);
      // Both events share the request's correlationId / flowId.
      expect(events[0]?.correlation_id).toBe(body.correlationId);
      expect(events[1]?.correlation_id).toBe(body.correlationId);
      expect(events[0]?.flow_id).toBeTruthy();
      expect(events[0]?.flow_id).toBe(events[1]?.flow_id);

      const calls = db.query<LlmCallRow, []>('SELECT * FROM llm_calls').all();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.model).toBe('mock-default');
      expect(calls[0]?.endpoint).toBe('mock://echo');
      expect(calls[0]?.error).toBeNull();
      expect(calls[0]?.correlation_id).toBe(body.correlationId);
    } finally {
      db.close();
    }
  });

  it('honors the per-call model override', async () => {
    const dir = mkTmp();
    const db = openDatabase(dir);
    try {
      const eventLog = createSqliteEventLog(db);
      const bus = new InMemoryMessageBus({
        middlewares: [telemetryMiddleware(eventLog.writer)],
      });
      const callLog = createSqliteLlmCallLog(db);
      const llmClient = withTelemetry(
        createLlmClient({
          endpoint: 'mock://echo',
          apiKey: '',
          defaultModel: 'mock-default',
        }),
        { log: callLog },
      );

      const app = createApp({ bus, llmClient, status });
      const res = await app.fetch(
        new Request('http://localhost/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'hi', model: 'override-model' }),
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as ChatSuccessBody;
      expect(body.model).toBe('override-model');

      const calls = db.query<LlmCallRow, []>('SELECT * FROM llm_calls').all();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.model).toBe('override-model');
    } finally {
      db.close();
    }
  });

  it('publishes chat.failed and returns 502 with the localized error key when the provider throws', async () => {
    const dir = mkTmp();
    const db = openDatabase(dir);
    try {
      const eventLog = createSqliteEventLog(db);
      const bus = new InMemoryMessageBus({
        middlewares: [
          correlationIdMiddleware,
          telemetryMiddleware(eventLog.writer),
          errorCaptureMiddleware(() => {
            /* swallow */
          }),
        ],
      });
      const callLog = createSqliteLlmCallLog(db);
      const llmClient = withTelemetry(
        createLlmClient({
          endpoint: 'mock://error',
          apiKey: '',
          defaultModel: 'mock-default',
        }),
        { log: callLog },
      );

      const app = createApp({ bus, llmClient, status });
      const res = await app.fetch(
        new Request('http://localhost/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'boom' }),
        }),
      );

      expect(res.status).toBe(502);
      const body = (await res.json()) as ChatErrorBody;
      expect(body.error).toBe('errors.chat.upstream');
      expect(body.correlationId).toBeTruthy();

      const types = db
        .query<{ type: string }, []>('SELECT type FROM events ORDER BY rowid ASC')
        .all()
        .map((r) => r.type);
      expect(types).toEqual(['chat.requested', 'chat.failed']);

      const calls = db.query<LlmCallRow, []>('SELECT * FROM llm_calls').all();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.error).toMatch(/always error/);
    } finally {
      db.close();
    }
  });

  it('returns 400 for a malformed body', async () => {
    const dir = mkTmp();
    const db = openDatabase(dir);
    try {
      const bus = new InMemoryMessageBus();
      const callLog = createSqliteLlmCallLog(db);
      const llmClient = withTelemetry(
        createLlmClient({
          endpoint: 'mock://echo',
          apiKey: '',
          defaultModel: 'mock-default',
        }),
        { log: callLog },
      );
      const app = createApp({ bus, llmClient, status });

      const res = await app.fetch(
        new Request('http://localhost/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as ChatErrorBody;
      expect(body.error).toBe('errors.chat.badRequest');
    } finally {
      db.close();
    }
  });
});
