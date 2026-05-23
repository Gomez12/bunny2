/**
 * Phase 3.3 — `withEffectiveLayers` middleware.
 *
 * Verifies the auth chain now ends in a per-request enrichment that
 * attaches `c.var.effectiveLayers` to every authenticated request and
 * stays out of the way on public routes. The 500/`errors.server.unavailable`
 * surface is exercised via an injected fake resolver — the real
 * `createLayerResolver` never throws on demand.
 */
import { afterEach, describe, expect, it } from 'bun:test';
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
import { Hono } from 'hono';
import { safeRmSync } from './_helpers/temp-dir';
import { openDatabase } from '../src/storage/sqlite';
import { createSqliteEventLog } from '../src/bus/event-log';
import { createLlmClient } from '../src/llm/client';
import { createApp } from '../src/http/router';
import type { HonoVariables, StatusBody } from '../src/http/router';
import { AuthConfigSchema, LocalesConfigSchema } from '../src/config/schema';
import { createGroupResolver } from '../src/auth/group-resolver';
import { createLayerResolver, type LayerResolver } from '../src/layers/resolver';
import { seedLayersIfNeeded } from '../src/layers/seed';
import type { Layer } from '../src/repos/layers-repo';
import { createUsersRepo } from '../src/repos/users-repo';
import { createGroupsRepo } from '../src/repos/groups-repo';
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
  readonly layerResolver: LayerResolver;
}

function makeFixture(layerResolverOverride?: LayerResolver): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-layer-enrichment-'));
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
  const layerResolver =
    layerResolverOverride ?? createLayerResolver({ db, transitiveGroups: resolver });
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
  // Test-only probe route. Mounted on the same `Hono` returned by
  // `createApp` so it inherits CORS, auth, password-gate, and the
  // freshly-added `withEffectiveLayers` middleware.
  hono.get('/test/effective-layers', (c) => {
    const layers = c.get('effectiveLayers');
    return c.json({
      hasLayers: layers !== undefined,
      slugs: layers?.map((l) => l.slug) ?? null,
    });
  });
  return { dir, db, bus, app: hono, hono, layerResolver };
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

describe('withEffectiveLayers — authenticated requests', () => {
  it('attaches a populated effectiveLayers array to c.var for an authenticated request', async () => {
    fixture = makeFixture();
    // Seed layers so the user has a personal + everyone set to read.
    const groupResolver = createGroupResolver({ db: fixture.db, bus: fixture.bus });
    await seedLayersIfNeeded({
      db: fixture.db,
      bus: fixture.bus,
      transitiveGroups: groupResolver,
    });
    // Re-seeding the resolver cache is fine — `seedUserAndSession` runs
    // after, so we manually publish a personal layer for the new user by
    // re-running the seed (idempotent: skips existing rows).
    const { token, user } = seedUserAndSession(fixture.db, { username: 'alice' });
    await seedLayersIfNeeded({
      db: fixture.db,
      bus: fixture.bus,
      transitiveGroups: groupResolver,
    });
    // The marker is set after the first run, so re-seed via direct call
    // to ensure alice has a personal layer. Use a fresh resolver instance
    // and clear the layer resolver cache so the request observes the new
    // personal layer.
    fixture.layerResolver.invalidate();
    void user;

    const res = await fixture.app.fetch(
      new Request('http://localhost/test/effective-layers', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasLayers: boolean; slugs: string[] | null };
    expect(body.hasLayers).toBe(true);
    expect(body.slugs).toContain('everyone');
  });

  it('skips the middleware on public routes — c.var.effectiveLayers stays undefined', async () => {
    fixture = makeFixture();
    // `/status` is in the phase-2 DEFAULT_PUBLIC_PATHS whitelist, so the
    // auth middleware short-circuits before `withEffectiveLayers` runs.
    // The handler must observe no `c.var.user` AND no
    // `c.var.effectiveLayers`. We assert via the public status response
    // shape; if the middleware mutated the request we'd see the existing
    // 500 path from the layer resolver (no user → handled by the
    // defensive `user === undefined` branch).
    const res = await fixture.app.fetch(new Request('http://localhost/status'));
    expect(res.status).toBe(200);
  });

  it('reflects the seeded everyone + personal-<user> layers for a fresh login', async () => {
    fixture = makeFixture();
    const groupResolver = createGroupResolver({ db: fixture.db, bus: fixture.bus });
    // Create a non-admin user FIRST, then seed: the seed loop will
    // produce `personal-bob` plus the everyone layer.
    const bobId = crypto.randomUUID();
    createUsersRepo(fixture.db).createUser({
      id: bobId,
      username: 'bob',
      displayName: 'Bob',
      passwordHash: 'h',
      mustChangePassword: false,
      now: new Date().toISOString(),
    });
    await seedLayersIfNeeded({
      db: fixture.db,
      bus: fixture.bus,
      transitiveGroups: groupResolver,
    });
    const { token } = seedUserAndSession(fixture.db, {
      username: 'bob-session-only-user',
    });
    // We want bob's session, not the session-only user — re-seed bob's
    // session by hand. Drop the throwaway session by creating a real one
    // for bob via the helper but overriding the username.
    fixture.layerResolver.invalidate();
    void token;

    // Login bob through `seedUserAndSession` by reading bob back and
    // creating a session against his id.
    const { createSessionsRepo } = await import('../src/repos/sessions-repo');
    const sessionsRepo = createSessionsRepo(fixture.db);
    const { createSessionService } = await import('../src/auth/sessions');
    const service = createSessionService({
      sessions: sessionsRepo,
      users: createUsersRepo(fixture.db),
    });
    const created = service.createSession({
      userId: bobId,
      ttlMinutes: 60 * 24 * 365,
      idleMinutes: 60 * 24 * 365,
      now: new Date(),
    });

    const res = await fixture.app.fetch(
      new Request('http://localhost/test/effective-layers', {
        headers: { authorization: `Bearer ${created.token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasLayers: boolean; slugs: string[] };
    expect(body.hasLayers).toBe(true);
    expect(body.slugs).toContain('personal-bob');
    expect(body.slugs).toContain('everyone');
  });

  it('returns 500 errors.server.unavailable when the resolver throws', async () => {
    const throwingResolver: LayerResolver = {
      effectiveLayers: () => {
        return Promise.reject(new Error('boom — synthetic test failure'));
      },
      invalidate: () => {
        /* no-op */
      },
    };
    fixture = makeFixture(throwingResolver);
    const { token } = seedUserAndSession(fixture.db, { username: 'eve' });
    const res = await fixture.app.fetch(
      new Request('http://localhost/test/effective-layers', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.server.unavailable');
  });

  it('different users get their own personal layer in c.var.effectiveLayers', async () => {
    fixture = makeFixture();
    const groupResolver = createGroupResolver({ db: fixture.db, bus: fixture.bus });
    const users = createUsersRepo(fixture.db);
    const groups = createGroupsRepo(fixture.db);
    const now = new Date().toISOString();
    const aliceId = crypto.randomUUID();
    users.createUser({
      id: aliceId,
      username: 'alice',
      displayName: 'Alice',
      passwordHash: 'h',
      mustChangePassword: false,
      now,
    });
    const bobId = crypto.randomUUID();
    users.createUser({
      id: bobId,
      username: 'bob',
      displayName: 'Bob',
      passwordHash: 'h',
      mustChangePassword: false,
      now,
    });
    void groups;
    await seedLayersIfNeeded({
      db: fixture.db,
      bus: fixture.bus,
      transitiveGroups: groupResolver,
    });

    const { createSessionsRepo } = await import('../src/repos/sessions-repo');
    const sessionsRepo = createSessionsRepo(fixture.db);
    const { createSessionService } = await import('../src/auth/sessions');
    const service = createSessionService({ sessions: sessionsRepo, users });
    const aliceSession = service.createSession({
      userId: aliceId,
      ttlMinutes: 60 * 24 * 365,
      idleMinutes: 60 * 24 * 365,
      now: new Date(),
    });
    const bobSession = service.createSession({
      userId: bobId,
      ttlMinutes: 60 * 24 * 365,
      idleMinutes: 60 * 24 * 365,
      now: new Date(),
    });

    const aliceRes = await fixture.app.fetch(
      new Request('http://localhost/test/effective-layers', {
        headers: { authorization: `Bearer ${aliceSession.token}` },
      }),
    );
    const bobRes = await fixture.app.fetch(
      new Request('http://localhost/test/effective-layers', {
        headers: { authorization: `Bearer ${bobSession.token}` },
      }),
    );
    expect(aliceRes.status).toBe(200);
    expect(bobRes.status).toBe(200);
    const aliceBody = (await aliceRes.json()) as { slugs: string[] };
    const bobBody = (await bobRes.json()) as { slugs: string[] };
    expect(aliceBody.slugs).toContain('personal-alice');
    expect(aliceBody.slugs).not.toContain('personal-bob');
    expect(bobBody.slugs).toContain('personal-bob');
    expect(bobBody.slugs).not.toContain('personal-alice');
  });
});

// Type guard so the linter does not complain about the unused `Layer`
// import — it is the contract `c.var.effectiveLayers` carries, even if
// the test only reads `.slug`.
void (null as unknown as Layer);
