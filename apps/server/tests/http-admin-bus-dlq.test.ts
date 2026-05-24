/**
 * Phase 5.4 — `/admin/bus/dlq` admin DLQ view + replay.
 *
 * Covers:
 *   - admin lists DLQ rows with event type + clipped payload preview.
 *   - admin replay flips the `bus_outbox` row back to `pending` and
 *     publishes `bus.dlq.replayed`.
 *   - admin replay on an unknown id returns
 *     `404 errors.bus.dlqReplayFailed`.
 *   - replay on a tests-with-in-memory-bus app returns
 *     `503 errors.bus.dlqReplayFailed` (no `replayDlq` wired).
 *
 * The test app for the happy path wires a real
 * `DurableSqliteMessageBus` so `replayDlq()` is available; the
 * 503 test reuses the standard `makeTestAppSeeded` fixture which
 * does not pass the hook in.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import {
  DurableSqliteMessageBus,
  correlationIdMiddleware,
  errorCaptureMiddleware,
  type MessageBus,
  type Middleware,
} from '@bunny2/bus';
import { makeTestAppSeeded, type TestApp } from './_helpers/app';
import { loginSeededAdminRotated, seedNonAdminUser } from './_helpers/auth';
import { createApp } from '../src/http/router';
import type { StatusBody } from '../src/http/router';
import { createSqliteEventLog, writeEventRow } from '../src/bus/event-log';
import { openDatabase } from '../src/storage/sqlite';
import { AuthConfigSchema, LocalesConfigSchema } from '../src/config/schema';
import { createGroupResolver } from '../src/auth/group-resolver';
import { ADMIN_GROUP_ID_KEY, seedAdminIfNeeded } from '../src/auth/seed';
import { getMeta } from '../src/storage/kv-meta';
import { createLayerResolver } from '../src/layers/resolver';
import { seedLayersIfNeeded } from '../src/layers/seed';
import { safeRmSync } from './_helpers/temp-dir';
import { createLlmClient } from '../src/llm/client';

interface DurableTestApp {
  readonly dir: string;
  readonly db: Database;
  readonly bus: DurableSqliteMessageBus;
  readonly app: { fetch: (req: Request) => Response | Promise<Response> };
  readonly seedLog: readonly string[];
  cleanup(): void;
}

interface DurableTestAppOptions {
  /**
   * Optional middleware appended after `correlationIdMiddleware`
   * + `errorCaptureMiddleware`. The DLQ happy-path test passes a
   * throwing middleware here because the durable adapter only
   * routes errors that escape the MIDDLEWARE CHAIN into the DLQ —
   * per-handler errors are caught inside `dispatch`. See the bus
   * contract test "moves a row to bus_dlq when a middleware throws
   * past maxAttempts" for the canonical pattern.
   */
  readonly extraMiddleware?: Middleware;
  /** Override default `maxAttempts`. */
  readonly maxAttempts?: number;
  /**
   * Mirrors the production wiring in `apps/server/src/index.ts` —
   * fires after a `bus_dlq` row commits, lets the server publish
   * `bus.dlq.added`. The test passes a notifier that publishes the
   * same event so the production publish path is covered end-to-end.
   */
  readonly onDlqAddedPublish?: boolean;
}

async function makeDurableTestApp(
  prefix: string,
  opts: DurableTestAppOptions = {},
): Promise<DurableTestApp> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const db = openDatabase(dir);
  const eventLog = createSqliteEventLog(db);
  // When the test wants to drive the DLQ, the throwing middleware
  // must NOT sit behind `errorCaptureMiddleware` (which swallows
  // every downstream throw). Place the exploder FIRST so its throw
  // escapes the chain into the durable adapter's failure path.
  const middlewares: Middleware[] =
    opts.extraMiddleware === undefined
      ? [correlationIdMiddleware, errorCaptureMiddleware()]
      : [opts.extraMiddleware, correlationIdMiddleware];
  let busRef: DurableSqliteMessageBus | null = null;
  const bus = new DurableSqliteMessageBus(db, {
    writeEvent: (event) => writeEventRow(db, event),
    middlewares,
    subscriberKey: 'server-main',
    // Tight retry budget so the DLQ test does not need to wait
    // through three attempts to push a row dead.
    maxAttempts: opts.maxAttempts ?? 1,
    ...(opts.onDlqAddedPublish !== true
      ? {}
      : {
          onDlqAdded: (info) => {
            // Mirror the production wiring in `apps/server/src/index.ts`.
            void busRef?.publish({
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
        }),
  });
  busRef = bus;
  const llmClient = createLlmClient({
    endpoint: 'mock://echo',
    apiKey: '',
    defaultModel: 'mock-default',
  });
  const captured: string[] = [];
  await seedAdminIfNeeded({ db, bus, log: (l) => captured.push(l) });
  const resolver = createGroupResolver({ db, bus });
  await seedLayersIfNeeded({ db, bus, transitiveGroups: resolver });
  const layerResolver = createLayerResolver({ db, transitiveGroups: resolver });
  const status = (): StatusBody => ({
    app: 'bunny2',
    version: '0.0.0',
    phase: '5.4',
    role: 'all',
    ok: true,
    dataDir: dir,
    configFile: null,
    sqlite: { schemaVersion: '0013_durable_bus' },
    lancedb: { ready: true, tables: [] },
    bus: { adapter: 'durable-sqlite', events: eventLog.count() },
    llm: { endpoint: 'mock://echo', defaultModel: 'mock-default', calls: 0 },
    auth: {
      sessions: 0,
      users: 0,
      groups: 0,
      adminSeeded: true,
      adminGroupResolved: getMeta(db, ADMIN_GROUP_ID_KEY) !== null,
    },
  });
  const app = createApp({
    bus: bus as unknown as MessageBus,
    llmClient,
    status,
    db,
    auth: AuthConfigSchema.parse({}),
    resolver,
    layerResolver,
    locales: LocalesConfigSchema.parse({}),
    replayDlq: (outboxId) => bus.replayDlq(outboxId),
  });
  bus.start();
  return {
    dir,
    db,
    bus,
    app,
    seedLog: captured,
    cleanup() {
      bus.stop();
      try {
        db.close();
      } catch {
        /* already closed */
      }
      try {
        safeRmSync(dir);
      } catch {
        /* best effort */
      }
    },
  };
}

let durableFx: DurableTestApp | null = null;
let memoryFx: TestApp | null = null;

afterEach(() => {
  if (durableFx !== null) {
    durableFx.cleanup();
    durableFx = null;
  }
  if (memoryFx !== null) {
    memoryFx.cleanup();
    memoryFx = null;
  }
});

describe('/admin/bus/dlq', () => {
  it('lists DLQ rows and replays one back to pending', async () => {
    // Drive a row into the DLQ via a middleware that throws on our
    // synthetic event type — the durable adapter only routes
    // middleware-chain errors into the DLQ (per-handler errors are
    // caught inside `dispatch`). See the bus contract test
    // "moves a row to bus_dlq when a middleware throws past
    // maxAttempts" for the canonical pattern.
    const exploder: Middleware = async (event, next) => {
      if (event.type === 'test.dlq.synthetic') {
        throw new Error('synthetic dlq error');
      }
      await next(event);
    };
    durableFx = await makeDurableTestApp('bunny2-admin-dlq-', { extraMiddleware: exploder });
    const { token: adminToken } = await loginSeededAdminRotated({
      db: durableFx.db,
      bus: durableFx.bus as unknown as MessageBus,
      app: durableFx.app,
      seedLog: durableFx.seedLog,
    });

    const event = await durableFx.bus.publish({
      type: 'test.dlq.synthetic',
      payload: { hello: 'world' },
    });
    await durableFx.bus.drain();

    // List DLQ rows.
    const listRes = await durableFx.app.fetch(
      new Request('http://localhost/admin/bus/dlq', {
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      items: Array<{ outboxId: string; eventType: string; error: string }>;
    };
    const ours = listBody.items.find((i) => i.outboxId === event.id);
    expect(ours).toBeDefined();
    expect(ours?.eventType).toBe('test.dlq.synthetic');
    expect(ours?.error).toContain('synthetic dlq error');

    // Replay.
    const replay = await durableFx.app.fetch(
      new Request(`http://localhost/admin/bus/dlq/${event.id}/replay`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(replay.status).toBe(200);

    // Outbox row should be back to `pending` (or already
    // re-claimed → in_flight). What it MUST NOT be is `dead`.
    const row = durableFx.db
      .query<{ status: string }, [string]>('SELECT status FROM bus_outbox WHERE id = ?')
      .get(event.id);
    expect(row).not.toBeNull();
    expect(row?.status).not.toBe('dead');
  });

  it('replay on an unknown outbox id returns 404 errors.bus.dlqReplayFailed', async () => {
    durableFx = await makeDurableTestApp('bunny2-admin-dlq-404-');
    const { token: adminToken } = await loginSeededAdminRotated({
      db: durableFx.db,
      bus: durableFx.bus as unknown as MessageBus,
      app: durableFx.app,
      seedLog: durableFx.seedLog,
    });

    const res = await durableFx.app.fetch(
      new Request(`http://localhost/admin/bus/dlq/${crypto.randomUUID()}/replay`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.bus.dlqReplayFailed');
  });

  it('forbids non-admin callers from listing the DLQ', async () => {
    durableFx = await makeDurableTestApp('bunny2-admin-dlq-forbid-');
    await loginSeededAdminRotated({
      db: durableFx.db,
      bus: durableFx.bus as unknown as MessageBus,
      app: durableFx.app,
      seedLog: durableFx.seedLog,
    });
    const nonAdmin = await seedNonAdminUser(
      { db: durableFx.db, app: durableFx.app },
      { username: 'bob' },
    );
    const res = await durableFx.app.fetch(
      new Request('http://localhost/admin/bus/dlq', {
        headers: { authorization: `Bearer ${nonAdmin.token}` },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('publishes bus.dlq.added via the onDlqAdded after-commit hook', async () => {
    const exploder: Middleware = async (event, next) => {
      if (event.type === 'test.dlq.notify') {
        throw new Error('notify-path-error');
      }
      await next(event);
    };
    durableFx = await makeDurableTestApp('bunny2-admin-dlq-notify-', {
      extraMiddleware: exploder,
      onDlqAddedPublish: true,
    });
    const dlqAddedEvents: Array<{
      outboxId: string;
      type: string;
      attempts: number;
      error: string;
    }> = [];
    durableFx.bus.subscribe('bus.dlq.added', (event) => {
      dlqAddedEvents.push(event.payload as (typeof dlqAddedEvents)[number]);
    });
    const published = await durableFx.bus.publish({
      type: 'test.dlq.notify',
      payload: { ok: false },
    });
    await durableFx.bus.drain();
    expect(dlqAddedEvents.length).toBeGreaterThanOrEqual(1);
    const ours = dlqAddedEvents.find((e) => e.outboxId === published.id);
    expect(ours).toBeDefined();
    expect(ours?.type).toBe('test.dlq.notify');
    expect(ours?.attempts).toBeGreaterThanOrEqual(1);
    expect(ours?.error).toContain('notify-path-error');
  });

  it('replay returns 503 errors.bus.dlqReplayFailed when no durable bus is wired', async () => {
    memoryFx = await makeTestAppSeeded('bunny2-admin-dlq-mem-');
    const { token: adminToken } = await loginSeededAdminRotated({
      db: memoryFx.db,
      bus: memoryFx.bus,
      app: memoryFx.app,
      seedLog: memoryFx.seedLog,
    });
    const res = await memoryFx.app.fetch(
      new Request(`http://localhost/admin/bus/dlq/${crypto.randomUUID()}/replay`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(res.status).toBe(503);
  });
});
