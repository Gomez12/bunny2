import * as fs from 'node:fs';
import { safeRmSync } from './temp-dir';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import { correlationIdMiddleware, errorCaptureMiddleware, telemetryMiddleware } from '@bunny2/bus';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import { createApp } from '../../src/http/router';
import type { StatusBody } from '../../src/http/router';
import { createLlmClient } from '../../src/llm/client';
import type { LlmClient } from '../../src/llm/types';
import { createSqliteEventLog } from '../../src/bus/event-log';
import { openDatabase } from '../../src/storage/sqlite';
import { AuthConfigSchema, LocalesConfigSchema } from '../../src/config/schema';
import { createGroupResolver, type GroupResolver } from '../../src/auth/group-resolver';
import { ADMIN_GROUP_ID_KEY, seedAdminIfNeeded } from '../../src/auth/seed';
import { getMeta } from '../../src/storage/kv-meta';
import { createLayerResolver, type LayerResolver } from '../../src/layers/resolver';
import { seedLayersIfNeeded } from '../../src/layers/seed';

/**
 * Test fixture: temp data-dir, real SQLite + migrations, real bus with the
 * full middleware chain (so `events` rows land), real LLM mock, real
 * transitive group resolver, and the production `createApp` wiring.
 * Returns a tear-down helper so tests can close the DB and remove the
 * temp dir in a `finally` block.
 *
 * Opt-in `seedAdmin: true` runs the admin seed BEFORE constructing the
 * resolver and the app, so the `requireAdmin` middleware (which reads
 * `admin_group_id` once at factory creation) sees the seeded id and
 * lets admin routes resolve. Tests that explicitly exercise the
 * unseeded 503 path pass `seedAdmin: false` (the default).
 */
export interface TestApp {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
  readonly resolver: GroupResolver;
  readonly layerResolver: LayerResolver;
  readonly app: { fetch: (req: Request) => Response | Promise<Response> };
  /**
   * Captured `seedAdminIfNeeded` log lines when `seedAdmin: true`; empty
   * otherwise. Tests that want the printed initial password can read it
   * here without a second seed call.
   */
  readonly seedLog: readonly string[];
  cleanup(): void;
}

export interface MakeTestAppOptions {
  readonly prefix?: string;
  /** Run the admin seed before constructing `createApp`. Default `false`. */
  readonly seedAdmin?: boolean;
  /**
   * Phase 6.4 — override the default `mock://echo` client. Used by
   * the chat-route tests to inject a programmable / streaming LLM
   * so SSE assertions are deterministic.
   */
  readonly llmClient?: LlmClient;
}

export function makeTestApp(prefixOrOptions: string | MakeTestAppOptions = {}): TestApp {
  const opts: MakeTestAppOptions =
    typeof prefixOrOptions === 'string' ? { prefix: prefixOrOptions } : prefixOrOptions;
  const prefix = opts.prefix ?? 'bunny2-auth-test-';
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
  const llmClient =
    opts.llmClient ??
    createLlmClient({
      endpoint: 'mock://echo',
      apiKey: '',
      defaultModel: 'mock-default',
    });

  // The seed must run BEFORE the resolver and the app so the
  // `requireAdmin` middleware factory observes the seeded
  // `admin_group_id`. The async work resolves synchronously enough on
  // the test path (Bun timers do not bite this code path), but the
  // helper has to be sync to keep its existing callers untouched, so
  // we use a synchronous "make me a TestApp" wrapper that defers the
  // seed-and-construct work into the caller via the dedicated async
  // variant below if they need pre-seed.
  const captured: string[] = [];
  const status = (): StatusBody => ({
    app: 'bunny2',
    version: '0.0.0',
    phase: '3.6',
    role: 'all',
    ok: true,
    dataDir: dir,
    configFile: null,
    sqlite: { schemaVersion: '0002_users_groups' },
    lancedb: { ready: true, tables: [] },
    bus: { adapter: 'in-memory', events: eventLog.count() },
    llm: { endpoint: 'mock://echo', defaultModel: 'mock-default', calls: 0 },
    auth: {
      sessions: 0,
      users: 0,
      groups: 0,
      adminSeeded: false,
      adminGroupResolved: getMeta(db, ADMIN_GROUP_ID_KEY) !== null,
    },
  });
  const resolver = createGroupResolver({ db, bus });
  // Phase 3.3 — the auth chain now ends in `withEffectiveLayers`, which
  // calls `layerResolver.effectiveLayers(user.id)` once per authenticated
  // request. Tests that do not pre-seed the layer schema still get a
  // working resolver — `effectiveLayers` returns an empty frozen array
  // when no layers exist for the user, and the middleware attaches it.
  const layerResolver = createLayerResolver({ db, transitiveGroups: resolver });
  const app = createApp({
    bus,
    llmClient,
    status,
    db,
    auth: AuthConfigSchema.parse({}),
    resolver,
    layerResolver,
    locales: LocalesConfigSchema.parse({}),
  });
  if (opts.seedAdmin === true) {
    throw new Error(
      'makeTestApp: `seedAdmin: true` requires the async `makeTestAppSeeded` factory — the seed runs argon2 which must be awaited.',
    );
  }
  return {
    dir,
    db,
    bus,
    resolver,
    layerResolver,
    app,
    seedLog: captured,
    cleanup() {
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

/**
 * Async variant: seeds the admin BEFORE constructing the resolver and
 * the app, so the `requireAdmin` middleware's factory-time read of
 * `admin_group_id` observes the seeded value. Use this for any test
 * that drives `/admin/*` against the seeded admin.
 *
 * Phase 7.6 — accepts an optional `withCapabilityRegistry: true` so the
 * proposals + capabilities routes get wired. Default `false` to keep
 * legacy callers byte-identical.
 */
export async function makeTestAppSeeded(
  prefixOrOpts:
    | string
    | { readonly prefix?: string; readonly withCapabilityRegistry?: boolean } = {},
): Promise<TestApp> {
  const opts = typeof prefixOrOpts === 'string' ? { prefix: prefixOrOpts } : prefixOrOpts;
  const prefix = opts.prefix ?? 'bunny2-admin-test-';
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
  const captured: string[] = [];
  await seedAdminIfNeeded({ db, bus, log: (l) => captured.push(l) });

  // Phase 3.3 — seed layers after the admin so the resolver has
  // `personal-admin`, `group-admin`, and `everyone` to hand to the
  // enrichment middleware.
  const groupResolverForSeed = createGroupResolver({ db, bus });
  await seedLayersIfNeeded({ db, bus, transitiveGroups: groupResolverForSeed });

  const status = (): StatusBody => ({
    app: 'bunny2',
    version: '0.0.0',
    phase: '3.6',
    role: 'all',
    ok: true,
    dataDir: dir,
    configFile: null,
    sqlite: { schemaVersion: '0002_users_groups' },
    lancedb: { ready: true, tables: [] },
    bus: { adapter: 'in-memory', events: eventLog.count() },
    llm: { endpoint: 'mock://echo', defaultModel: 'mock-default', calls: 0 },
    auth: {
      sessions: 0,
      users: 0,
      groups: 0,
      adminSeeded: true,
      adminGroupResolved: getMeta(db, ADMIN_GROUP_ID_KEY) !== null,
    },
  });
  const resolver = createGroupResolver({ db, bus });
  const layerResolver = createLayerResolver({ db, transitiveGroups: resolver });
  // Phase 7.6 — opt-in capability registry so proposals + capabilities
  // routes mount. Tests that don't need them keep the byte-identical
  // 6.x wiring path (registry omitted → routes don't register).
  let capabilityRegistry: import('../../src/proposals').CapabilityRegistry | undefined;
  if (opts.withCapabilityRegistry === true) {
    const { createCapabilityRegistry } = await import('../../src/proposals');
    const { createLayerCapabilitiesRepo } =
      await import('../../src/proposals/repos/layer-capabilities-repo');
    capabilityRegistry = createCapabilityRegistry({
      repo: createLayerCapabilitiesRepo(db),
      bus,
    });
  }
  const app = createApp({
    bus,
    llmClient,
    status,
    db,
    auth: AuthConfigSchema.parse({}),
    resolver,
    layerResolver,
    locales: LocalesConfigSchema.parse({}),
    ...(capabilityRegistry !== undefined ? { capabilityRegistry } : {}),
  });

  return {
    dir,
    db,
    bus,
    resolver,
    layerResolver,
    app,
    seedLog: captured,
    cleanup() {
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
