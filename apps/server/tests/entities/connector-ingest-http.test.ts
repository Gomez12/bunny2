/**
 * Phase 4b.2 — HTTP-level checks for
 * `POST /l/:slug/contact/_ingest/:connectorId`.
 *
 * Focus:
 *   - happy path: a multipart upload of a 3-card .vcf returns 200 with
 *     `{ created: 3, updated: 0, warnings: [] }` and persists rows.
 *   - unknown connector id → 400 `errors.entity.connectorUnknown`.
 *   - body over `ingestMaxBytes` → 413 `errors.connectors.vcard.tooLarge`.
 *
 * Builds the app via a tiny variant of `makeTestApp` that wires the
 * `ingestDispatcher` and an explicit small `ingestMaxBytes` — the
 * default `makeTestApp` does not wire either because they are 4b.2-
 * specific deps.
 */
import { afterEach, describe, expect, it } from 'bun:test';
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
import { AuthConfigSchema, LocalesConfigSchema } from '../../src/config/schema';
import { createGroupResolver } from '../../src/auth/group-resolver';
import { createLayerResolver } from '../../src/layers/resolver';
import { createConnectorDispatcher, __resetEntityRegistryForTests } from '../../src/entities';
import { seedUserAndSession } from '../_helpers/auth';
import { seedLayersIfNeeded } from '../../src/layers/seed';
import { safeRmSync } from '../_helpers/temp-dir';

interface IngestFixture {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
  readonly app: { fetch: (req: Request) => Response | Promise<Response> };
  cleanup(): void;
}

function makeIngestFixture(opts: { readonly ingestMaxBytes?: number } = {}): IngestFixture {
  __resetEntityRegistryForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-vcard-http-'));
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
    phase: '4b.2',
    ok: true,
    dataDir: dir,
    configFile: null,
    sqlite: { schemaVersion: '0008_contacts' },
    lancedb: { ready: true, tables: [] },
    bus: { adapter: 'in-memory', events: eventLog.count() },
    llm: { endpoint: 'mock://echo', defaultModel: 'mock-default', calls: 0 },
    auth: {
      sessions: 0,
      users: 0,
      groups: 0,
      adminSeeded: false,
      adminGroupResolved: false,
    },
  });
  const resolver = createGroupResolver({ db, bus });
  const layerResolver = createLayerResolver({ db, transitiveGroups: resolver });
  const ingestDispatcher = createConnectorDispatcher({
    db,
    bus,
    llm: llmClient,
    // The vCard connector takes no per-attachment config; the default
    // resolver would return null and the dispatcher's ingest path would
    // pass `{}` to the connector — that already works. Override with an
    // explicit empty object for clarity.
    resolveConfig: () => ({}),
  });
  const app = createApp({
    bus,
    llmClient,
    status,
    db,
    auth: AuthConfigSchema.parse({}),
    resolver,
    layerResolver,
    locales: LocalesConfigSchema.parse({}),
    ingestDispatcher,
    ...(opts.ingestMaxBytes === undefined ? {} : { ingestMaxBytes: opts.ingestMaxBytes }),
  });
  return {
    dir,
    db,
    bus,
    app,
    cleanup() {
      __resetEntityRegistryForTests();
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

let fx: IngestFixture | null = null;
afterEach(() => {
  fx?.cleanup();
  fx = null;
});

async function attach(
  fixture: IngestFixture,
  token: string,
  url: string,
  body: unknown,
): Promise<Response> {
  return fixture.app.fetch(
    new Request(`http://localhost${url}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

async function setupLayer(fixture: IngestFixture, prefix: string): Promise<{ token: string }> {
  const { token } = seedUserAndSession(fixture.db, { username: prefix });
  await seedLayersIfNeeded({
    db: fixture.db,
    bus: fixture.bus,
    transitiveGroups: createGroupResolver({ db: fixture.db, bus: fixture.bus }),
  });
  const res = await attach(fixture, token, '/layers', {
    type: 'project',
    slug: 'ingp',
    name: 'IngestPlay',
  });
  expect(res.status).toBe(201);
  return { token };
}

const VCF = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Alice Example',
  'EMAIL:alice@example.com',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Bob Builder',
  'EMAIL:bob@example.com',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Cara Cook',
  'EMAIL:cara@example.com',
  'END:VCARD',
  '',
].join('\r\n');

function multipart(token: string, body: string, filename = 'contacts.vcf'): Request {
  const form = new FormData();
  form.append('file', new File([body], filename, { type: 'text/vcard' }));
  return new Request(`http://localhost/l/ingp/contact/_ingest/vcard`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
}

describe('POST /l/:slug/contact/_ingest/:connectorId', () => {
  it('imports 3 contacts from a multipart vCard upload (happy path)', async () => {
    fx = makeIngestFixture();
    const { token } = await setupLayer(fx, 'happy');
    const res = await fx.app.fetch(multipart(token, VCF));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      created: number;
      updated: number;
      warnings: readonly string[];
    };
    expect(body.created).toBe(3);
    expect(body.updated).toBe(0);
    expect(body.warnings).toEqual([]);
    const rowCount = fx.db
      .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM contacts WHERE deleted_at IS NULL')
      .get()?.n;
    expect(rowCount).toBe(3);
  });

  it('returns 400 errors.entity.connectorUnknown for an unknown connector id', async () => {
    fx = makeIngestFixture();
    const { token } = await setupLayer(fx, 'unknown');
    const form = new FormData();
    form.append('file', new File([VCF], 'contacts.vcf', { type: 'text/vcard' }));
    const res = await fx.app.fetch(
      new Request('http://localhost/l/ingp/contact/_ingest/not-a-connector', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: form,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.entity.connectorUnknown');
    const rowCount = fx.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM contacts').get()?.n;
    expect(rowCount).toBe(0);
  });

  it('returns 413 errors.connectors.vcard.tooLarge for a body over the cap', async () => {
    fx = makeIngestFixture({ ingestMaxBytes: 64 });
    const { token } = await setupLayer(fx, 'oversize');
    // VCF is well over 64 bytes.
    const res = await fx.app.fetch(multipart(token, VCF));
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.connectors.vcard.tooLarge');
    const rowCount = fx.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM contacts').get()?.n;
    expect(rowCount).toBe(0);
  });
});
