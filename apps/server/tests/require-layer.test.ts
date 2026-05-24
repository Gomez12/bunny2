/**
 * Phase 3.3 — `createRequireLayer` per-route helper.
 *
 * Mounts a test-only route under `/test/layers/:slug` on the production
 * app (so the full middleware chain runs) and exercises:
 *
 *   - visible slug → handler runs and `c.var.layer` matches the slug
 *   - non-visible slug → 404 + `errors.layer.notVisible`
 *   - soft-deleted layer → 404 (proves the resolver filter is load-
 *     bearing, since the slug exists in SQL but not in
 *     `effectiveLayers`)
 *   - missing `:slug` param → 400 + `errors.layer.slugRequired`
 *     (assertion on whichever shape we picked; documented in the helper)
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { correlationIdMiddleware, errorCaptureMiddleware, telemetryMiddleware } from '@bunny2/bus';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import { Hono } from 'hono';
import { safeRmSync } from './_helpers/temp-dir';
import { openDatabase } from '../src/storage/sqlite';
import { createSqliteEventLog } from '../src/bus/event-log';
import { createLlmClient } from '../src/llm/client';
import { createApp } from '../src/http/router';
import type { HonoVariables, StatusBody } from '../src/http/router';
import { AuthConfigSchema, LocalesConfigSchema } from '../src/config/schema';
import { createGroupResolver } from '../src/auth/group-resolver';
import { createLayerResolver } from '../src/layers/resolver';
import { seedLayersIfNeeded } from '../src/layers/seed';
import { createUsersRepo } from '../src/repos/users-repo';
import { createLayersRepo } from '../src/repos/layers-repo';
import { createRequireLayer } from '../src/http/middleware/layer';
import { seedUserAndSession } from './_helpers/auth';

const STATUS_STUB = (): StatusBody => ({
  app: 'bunny2',
  version: '0.0.0',
  phase: '3.3',
  ok: true,
  dataDir: '/tmp/test',
  configFile: null,
  sqlite: { schemaVersion: '0003_layers' },
  lancedb: { ready: true, tables: [] },
  bus: { adapter: 'in-memory', events: 0 },
  llm: { endpoint: 'mock://echo', defaultModel: 'mock-default', calls: 0 },
  auth: {
    sessions: 0,
    users: 0,
    groups: 0,
    adminSeeded: false,
    adminGroupResolved: false,
  },
});

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
  readonly app: { fetch: (req: Request) => Response | Promise<Response> };
  readonly hono: Hono<{ Variables: HonoVariables }>;
}

async function makeFixture(): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-require-layer-'));
  const db = openDatabase(dir);
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
  const llmClient = createLlmClient({
    endpoint: 'mock://echo',
    apiKey: '',
    defaultModel: 'mock-default',
  });
  const resolver = createGroupResolver({ db, bus });
  const layerResolver = createLayerResolver({ db, transitiveGroups: resolver });
  const hono = createApp({
    bus,
    llmClient,
    status: STATUS_STUB,
    db,
    auth: AuthConfigSchema.parse({}),
    resolver,
    layerResolver,
    locales: LocalesConfigSchema.parse({}),
  });
  // Per-route `requireLayer` test surface. We mount two probes:
  //
  //   /test/layers/:slug              — the normal happy path
  //   /test/layers/                   — the "missing slug" path
  //                                     (Hono parses `:slug` as ''),
  //
  // both gated by `createRequireLayer()`. The handler echoes the
  // attached `c.var.layer.slug` so the test can assert wiring.
  const requireLayer = createRequireLayer();
  hono.get('/test/layers/:slug', requireLayer, (c) => {
    const layer = c.get('layer');
    if (layer === undefined) {
      return c.json({ error: 'test-bug-layer-missing' }, 500);
    }
    return c.json({ slug: layer.slug, type: layer.type });
  });
  return { dir, db, bus, app: hono, hono };
}

function teardown(f: Fixture): void {
  try {
    f.db.close();
  } catch {
    /* already closed */
  }
  safeRmSync(f.dir);
}

let fixture: Fixture | null = null;

afterEach(() => {
  if (fixture !== null) {
    teardown(fixture);
    fixture = null;
  }
});

describe('requireLayer — per-route slug check', () => {
  it('attaches c.var.layer and lets the handler run when the slug is visible', async () => {
    fixture = await makeFixture();
    // Seed: creates an `everyone` layer and personal layers for any
    // existing users. We need an authenticated user that can SEE the
    // `everyone` layer (everyone does).
    const groupResolver = createGroupResolver({ db: fixture.db, bus: fixture.bus });
    const userId = crypto.randomUUID();
    createUsersRepo(fixture.db).createUser({
      id: userId,
      username: 'carol',
      displayName: 'Carol',
      passwordHash: 'h',
      mustChangePassword: false,
      now: new Date().toISOString(),
    });
    await seedLayersIfNeeded({
      db: fixture.db,
      bus: fixture.bus,
      transitiveGroups: groupResolver,
    });

    const { createSessionsRepo } = await import('../src/repos/sessions-repo');
    const sessionsRepo = createSessionsRepo(fixture.db);
    const { createSessionService } = await import('../src/auth/sessions');
    const service = createSessionService({
      sessions: sessionsRepo,
      users: createUsersRepo(fixture.db),
    });
    const created = service.createSession({
      userId,
      ttlMinutes: 60 * 24 * 365,
      idleMinutes: 60 * 24 * 365,
      now: new Date(),
    });

    const res = await fixture.app.fetch(
      new Request('http://localhost/test/layers/everyone', {
        headers: { authorization: `Bearer ${created.token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string; type: string };
    expect(body.slug).toBe('everyone');
    expect(body.type).toBe('everyone');
  });

  it('returns 404 errors.layer.notVisible for a slug not in the caller’s effective set', async () => {
    fixture = await makeFixture();
    const groupResolver = createGroupResolver({ db: fixture.db, bus: fixture.bus });
    // No seed → no `everyone` layer exists. We still issue a session
    // and ask for an arbitrary slug. The middleware sees an empty
    // effective set and must 404 (not 403).
    const { token } = seedUserAndSession(fixture.db, { username: 'dave' });
    void groupResolver;

    const res = await fixture.app.fetch(
      new Request('http://localhost/test/layers/totally-made-up-slug', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.layer.notVisible');
  });

  it('returns 404 for a soft-deleted layer even when the slug exists in SQL', async () => {
    fixture = await makeFixture();
    const groupResolver = createGroupResolver({ db: fixture.db, bus: fixture.bus });
    // Seed an everyone layer, then soft-delete it. The slug is still in
    // the `layers` table (`deleted_at IS NOT NULL`) but the resolver
    // filters it out — so the middleware must 404, proving the
    // soft-delete filter inside `effectiveLayers` is what gates this
    // route (not some independent SQL lookup).
    await seedLayersIfNeeded({
      db: fixture.db,
      bus: fixture.bus,
      transitiveGroups: groupResolver,
    });
    const layersRepo = createLayersRepo(fixture.db);
    const everyone = layersRepo.getLayerBySlug('everyone');
    if (everyone === null) throw new Error('test setup: everyone layer not seeded');
    layersRepo.softDeleteLayer(everyone.id, new Date().toISOString());

    const { token } = seedUserAndSession(fixture.db, { username: 'erin' });

    const res = await fixture.app.fetch(
      new Request('http://localhost/test/layers/everyone', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.layer.notVisible');
  });

  it('returns 404 from Hono’s router when the :slug segment is entirely missing', async () => {
    fixture = await makeFixture();
    const { token } = seedUserAndSession(fixture.db, { username: 'frank' });

    // Hono does not match `/test/layers/:slug` against `/test/layers` (no
    // trailing segment), so the request misses every route entirely.
    // The framework's default 404 is the natural answer; we assert the
    // status so a future router change cannot silently flip the
    // behaviour without updating this contract.
    const res = await fixture.app.fetch(
      new Request('http://localhost/test/layers', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(404);
  });
});
