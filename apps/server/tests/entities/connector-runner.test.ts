/**
 * Phase 4a.2 — connector poll runner.
 *
 * Each `tickOnce()` should:
 *   - emit `entity.connector.sync.requested` ONCE per stale link;
 *   - skip links whose `synced_at` is newer than `pollIntervalMinutes`
 *     ago (with the value resolved from the per-layer
 *     `layer_attachments` row);
 *   - skip links whose `sync_state` is already `syncing` or `error`
 *     (so a failed link does not loop forever).
 *
 * The runner is driven directly here via `tickOnce()` — no real
 * `setInterval` runs in this test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { type BusEvent } from '@bunny2/bus';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import type { CompanyPayload } from '@bunny2/shared';
import { openDatabase } from '../../src/storage/sqlite';
import { createUsersRepo } from '../../src/repos/users-repo';
import { createLayersRepo } from '../../src/repos/layers-repo';
import { createLayerAttachmentsRepo } from '../../src/repos/layer-attachments-repo';
import { createLlmClient } from '../../src/llm/client';
import {
  createEntityStore,
  createConnectorRunner,
  __resetEntityRegistryForTests,
  registerEntityModule,
  type RegisteredConnector,
} from '../../src/entities';
import {
  createCompanyModule,
  createKvkConnector,
  KVK_CONNECTOR_ID,
} from '../../src/entities/companies';
import { safeRmSync } from '../_helpers/temp-dir';

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
  readonly events: ReadonlyArray<BusEvent>;
  cleanup(): void;
}

function makeFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-runner-'));
  const db = openDatabase(dir);
  const captured: BusEvent[] = [];
  const bus = new InMemoryMessageBus({
    middlewares: [
      async (event, next) => {
        captured.push(event);
        await next(event);
      },
    ],
  });
  return {
    dir,
    db,
    bus,
    events: captured,
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

function seedUser(db: Database, username: string): string {
  const id = crypto.randomUUID();
  createUsersRepo(db).createUser({
    id,
    username,
    displayName: username,
    passwordHash: 'h',
    mustChangePassword: false,
    now: new Date().toISOString(),
  });
  return id;
}

function seedLayer(db: Database, slug: string): string {
  const id = crypto.randomUUID();
  createLayersRepo(db).insertLayer({
    id,
    type: 'project',
    slug,
    name: slug,
    now: new Date().toISOString(),
  });
  return id;
}

function attachKvk(db: Database, layerId: string, config: Record<string, unknown>): void {
  createLayerAttachmentsRepo(db).insertAttachment({
    id: crypto.randomUUID(),
    layerId,
    kind: 'connector',
    refId: KVK_CONNECTOR_ID,
    config,
    now: new Date().toISOString(),
  });
}

let fx: Fixture | null = null;
beforeEach(() => {
  // Reset the process-global entity registry FIRST — any sibling test
  // file may have left the default `companyModule` registered there.
  __resetEntityRegistryForTests();
  fx = makeFixture();
});
afterEach(() => {
  fx?.cleanup();
  fx = null;
});
function f(): Fixture {
  if (fx === null) throw new Error('runner fixture not initialised');
  return fx;
}

function makeKvkSetup(fixture: Fixture) {
  const connector = createKvkConnector();
  const module = createCompanyModule({ connectors: [connector] });
  registerEntityModule(module);
  const store = createEntityStore<CompanyPayload>({
    module,
    db: fixture.db,
    bus: fixture.bus,
    llm: createLlmClient({
      endpoint: 'mock://echo',
      apiKey: '',
      defaultModel: 'mock-default',
    }),
  });
  const registered: readonly RegisteredConnector[] = [{ kind: 'company', connector }];
  return { store, connector, registered };
}

describe('connector poll runner :: tickOnce', () => {
  it('emits requested once per stale link and zero for fresh links', async () => {
    const fixture = f();
    const { store, registered } = makeKvkSetup(fixture);
    const layerId = seedLayer(fixture.db, 'pp');
    const userId = seedUser(fixture.db, 'a');
    attachKvk(fixture.db, layerId, { apiKey: 'k', pollIntervalMinutes: 60 });

    const stale = await store.create({
      layerId,
      slug: 'stale',
      title: 'Stale',
      originalLocale: 'en',
      payload: {},
      actorId: userId,
    });
    const fresh = await store.create({
      layerId,
      slug: 'fresh',
      title: 'Fresh',
      originalLocale: 'en',
      payload: {},
      actorId: userId,
    });
    const staleLink = store.addExternalLink({
      ref: { id: stale.id, kind: 'company', layerId, slug: 'stale' },
      connector: KVK_CONNECTOR_ID,
      externalId: '11111111',
    });
    const freshLink = store.addExternalLink({
      ref: { id: fresh.id, kind: 'company', layerId, slug: 'fresh' },
      connector: KVK_CONNECTOR_ID,
      externalId: '22222222',
    });

    // Manually backdate `synced_at` on the stale link to two hours ago
    // and set the fresh link to two minutes ago. The 60-minute interval
    // makes one stale, the other fresh.
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60_000).toISOString();
    const twoMinutesAgo = new Date(now.getTime() - 2 * 60_000).toISOString();
    fixture.db
      .query<
        unknown,
        [string, string]
      >('UPDATE entity_external_links SET synced_at = ? WHERE id = ?')
      .run(twoHoursAgo, staleLink.id);
    fixture.db
      .query<
        unknown,
        [string, string]
      >('UPDATE entity_external_links SET synced_at = ? WHERE id = ?')
      .run(twoMinutesAgo, freshLink.id);

    const runner = createConnectorRunner({
      db: fixture.db,
      bus: fixture.bus,
      clock: () => now,
      listConnectors: () => registered,
    });
    const emitted = await runner.tickOnce();
    expect(emitted).toBe(1);
    const requested = fixture.events.filter((e) => e.type === 'entity.connector.sync.requested');
    expect(requested.length).toBe(1);
    const reqPayload = requested[0]?.payload as { externalId: string };
    expect(reqPayload.externalId).toBe('11111111');
  });

  it('treats a link that has never synced (synced_at NULL) as stale', async () => {
    const fixture = f();
    const { store, registered } = makeKvkSetup(fixture);
    const layerId = seedLayer(fixture.db, 'pp2');
    const userId = seedUser(fixture.db, 'a2');
    attachKvk(fixture.db, layerId, { apiKey: 'k', pollIntervalMinutes: 60 });
    const created = await store.create({
      layerId,
      slug: 'new',
      title: 'New',
      originalLocale: 'en',
      payload: {},
      actorId: userId,
    });
    store.addExternalLink({
      ref: { id: created.id, kind: 'company', layerId, slug: 'new' },
      connector: KVK_CONNECTOR_ID,
      externalId: '33333333',
    });
    const runner = createConnectorRunner({
      db: fixture.db,
      bus: fixture.bus,
      listConnectors: () => registered,
    });
    const emitted = await runner.tickOnce();
    expect(emitted).toBe(1);
  });

  it('skips links already in syncing or error state', async () => {
    const fixture = f();
    const { store, registered } = makeKvkSetup(fixture);
    const layerId = seedLayer(fixture.db, 'pp3');
    const userId = seedUser(fixture.db, 'a3');
    attachKvk(fixture.db, layerId, { apiKey: 'k', pollIntervalMinutes: 60 });
    const c = await store.create({
      layerId,
      slug: 's',
      title: 'S',
      originalLocale: 'en',
      payload: {},
      actorId: userId,
    });
    const lSync = store.addExternalLink({
      ref: { id: c.id, kind: 'company', layerId, slug: 's' },
      connector: KVK_CONNECTOR_ID,
      externalId: '44444444',
    });
    const lErr = store.addExternalLink({
      ref: { id: c.id, kind: 'company', layerId, slug: 's' },
      connector: KVK_CONNECTOR_ID,
      externalId: '55555555',
    });
    fixture.db
      .query<
        unknown,
        [string]
      >("UPDATE entity_external_links SET sync_state = 'syncing' WHERE id = ?")
      .run(lSync.id);
    fixture.db
      .query<
        unknown,
        [string]
      >("UPDATE entity_external_links SET sync_state = 'error' WHERE id = ?")
      .run(lErr.id);
    const runner = createConnectorRunner({
      db: fixture.db,
      bus: fixture.bus,
      listConnectors: () => registered,
    });
    const emitted = await runner.tickOnce();
    expect(emitted).toBe(0);
  });

  it('respects per-link pollIntervalMinutes from the layer attachment', async () => {
    const fixture = f();
    const { store, registered } = makeKvkSetup(fixture);
    // Layer A: short interval (60 min) — link is stale (2h since last sync).
    // Layer B: very long interval (1 week) — link is fresh enough.
    const layerA = seedLayer(fixture.db, 'a');
    const layerB = seedLayer(fixture.db, 'b');
    const userId = seedUser(fixture.db, 'multi');
    attachKvk(fixture.db, layerA, { apiKey: 'k', pollIntervalMinutes: 60 });
    attachKvk(fixture.db, layerB, { apiKey: 'k', pollIntervalMinutes: 7 * 24 * 60 });
    const ca = await store.create({
      layerId: layerA,
      slug: 'a-1',
      title: 'A1',
      originalLocale: 'en',
      payload: {},
      actorId: userId,
    });
    const cb = await store.create({
      layerId: layerB,
      slug: 'b-1',
      title: 'B1',
      originalLocale: 'en',
      payload: {},
      actorId: userId,
    });
    const la = store.addExternalLink({
      ref: { id: ca.id, kind: 'company', layerId: layerA, slug: 'a-1' },
      connector: KVK_CONNECTOR_ID,
      externalId: '12340001',
    });
    const lb = store.addExternalLink({
      ref: { id: cb.id, kind: 'company', layerId: layerB, slug: 'b-1' },
      connector: KVK_CONNECTOR_ID,
      externalId: '12340002',
    });
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60_000).toISOString();
    fixture.db
      .query<
        unknown,
        [string, string]
      >('UPDATE entity_external_links SET synced_at = ? WHERE id = ?')
      .run(twoHoursAgo, la.id);
    fixture.db
      .query<
        unknown,
        [string, string]
      >('UPDATE entity_external_links SET synced_at = ? WHERE id = ?')
      .run(twoHoursAgo, lb.id);

    const runner = createConnectorRunner({
      db: fixture.db,
      bus: fixture.bus,
      clock: () => now,
      listConnectors: () => registered,
    });
    const emitted = await runner.tickOnce();
    // Only layerA's link should fire (60min < 2h elapsed); layerB's
    // 7-day interval is far longer than 2h.
    expect(emitted).toBe(1);
  });
});
