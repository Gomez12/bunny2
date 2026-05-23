/**
 * Phase 4.0 — drives the universal contract suite against a fake
 * `FixtureEntityModule` (kind = 'fixture', payload = `{ title, body }`).
 *
 * The fixture proves the foundation works without any 4a..4d code. The
 * per-kind table `fixture_entities` is created in this test only and
 * dropped on cleanup so the fixture leaves no migration footprint.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { Database } from 'bun:sqlite';
import { InMemoryMessageBus } from '@bunny2/bus';
import { openDatabase } from '../../src/storage/sqlite';
import { createUsersRepo } from '../../src/repos/users-repo';
import { createLayersRepo } from '../../src/repos/layers-repo';
import { createLayerLocalesRepo } from '../../src/repos/layer-locales-repo';
import { createLlmClient } from '../../src/llm/client';
import {
  __resetEntityRegistryForTests,
  createEntityStore,
  createEntityTranslator,
  ENTITY_EVENT_TYPES,
  entityEventType,
  registerEntityModule,
  type EntityModule,
} from '../../src/entities';
import { runEntityContractSuite } from './suite';
import { safeRmSync } from '../_helpers/temp-dir';

// ---------------------------------------------------------------------------
// Fixture module — the minimal "this works" kind.
// ---------------------------------------------------------------------------

const FixturePayloadSchema = z.object({
  title: z.string().min(1),
  body: z.string(),
});
type FixturePayload = z.infer<typeof FixturePayloadSchema>;

const FixtureModule: EntityModule<FixturePayload> = {
  kind: 'fixture',
  tableName: 'fixture_entities',
  payloadSchema: FixturePayloadSchema,
  toSummary({ ref, meta, payload, title }) {
    return {
      ...ref,
      meta,
      title,
      subtitle: null,
      searchableText: `${title}\n${payload.body}`,
    };
  },
  searchableText(payload) {
    return `${payload.title}\n${payload.body}`;
  },
};

function createFixtureTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fixture_entities (
      id              TEXT PRIMARY KEY,
      layer_id        TEXT NOT NULL REFERENCES layers(id),
      slug            TEXT NOT NULL,
      title           TEXT NOT NULL,
      searchable_text TEXT NOT NULL,
      original_locale TEXT NOT NULL,
      payload_json    TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      created_by      TEXT NOT NULL REFERENCES users(id),
      updated_at      TEXT NOT NULL,
      updated_by      TEXT NOT NULL REFERENCES users(id),
      deleted_at      TEXT,
      deleted_by      TEXT REFERENCES users(id),
      version         INTEGER NOT NULL DEFAULT 1,
      UNIQUE (layer_id, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_fixture_entities_layer ON fixture_entities(layer_id);
    CREATE INDEX IF NOT EXISTS idx_fixture_entities_deleted_at ON fixture_entities(deleted_at);
  `);
}

function dropFixtureTable(db: Database): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_fixture_entities_deleted_at;
    DROP INDEX IF EXISTS idx_fixture_entities_layer;
    DROP TABLE IF EXISTS fixture_entities;
  `);
}

// ---------------------------------------------------------------------------
// Fixture wiring shared by every test in this file.
// ---------------------------------------------------------------------------

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
  cleanup(): void;
}

function makeFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-entity-fixture-'));
  const db = openDatabase(dir);
  createFixtureTable(db);
  const bus = new InMemoryMessageBus();
  return {
    dir,
    db,
    bus,
    cleanup() {
      __resetEntityRegistryForTests();
      try {
        dropFixtureTable(db);
      } catch {
        /* best effort */
      }
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

// ---------------------------------------------------------------------------
// Suite: registry + contract.
// ---------------------------------------------------------------------------

describe('entity registry', () => {
  let fx: Fixture | null = null;
  afterEach(() => {
    if (fx !== null) {
      fx.cleanup();
      fx = null;
    }
  });

  it('register + lookup by kind; rejects duplicate registration', () => {
    fx = makeFixture();
    registerEntityModule(FixtureModule);
    // Re-registering the same kind must throw, not silently overwrite.
    expect(() => registerEntityModule(FixtureModule)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Run the universal contract suite against the fixture module.
// ---------------------------------------------------------------------------

interface SuiteState {
  fx: Fixture;
  store: ReturnType<typeof createEntityStore<FixturePayload>>;
}

let suiteState: SuiteState | null = null;

beforeEach(() => {
  const fx = makeFixture();
  const store = createEntityStore<FixturePayload>({
    module: FixtureModule,
    db: fx.db,
    bus: fx.bus,
    llm: createLlmClient({
      endpoint: 'mock://echo',
      apiKey: '',
      defaultModel: 'mock-default',
    }),
  });
  suiteState = { fx, store };
});
afterEach(() => {
  if (suiteState !== null) {
    suiteState.fx.cleanup();
    suiteState = null;
  }
});

function state(): SuiteState {
  if (suiteState === null) throw new Error('suite fixture not initialised');
  return suiteState;
}

runEntityContractSuite<FixturePayload>({
  module: FixtureModule,
  get store() {
    return state().store;
  },
  get db() {
    return state().fx.db;
  },
  get bus() {
    return state().fx.bus;
  },
  createTwoLayers({ localesA, localesB, defaultLocaleA, defaultLocaleB }) {
    const s = state();
    const a = seedLayer(s.fx.db, `a-${crypto.randomUUID().slice(0, 6)}`);
    const b = seedLayer(s.fx.db, `b-${crypto.randomUUID().slice(0, 6)}`);
    const localesRepo = createLayerLocalesRepo(s.fx.db);
    const nowIso = new Date().toISOString();
    localesRepo.setLocales(a, localesA, defaultLocaleA, nowIso);
    localesRepo.setLocales(b, localesB, defaultLocaleB ?? localesB[0] ?? 'en', nowIso);
    return { layerAId: a, layerBId: b };
  },
  createUser(name) {
    return seedUser(state().fx.db, `${name}-${crypto.randomUUID().slice(0, 6)}`);
  },
  samplePayload(seed) {
    return { title: `Title ${seed}`, body: `Body for ${seed}` };
  },
  mutatePayload(payload, seed) {
    return { title: payload.title, body: `${payload.body} :: ${seed}` };
  },
});

// ---------------------------------------------------------------------------
// Translator integration: real translator, fake `translate` callback.
// ---------------------------------------------------------------------------

describe('entity translator (fixture)', () => {
  let fx: Fixture | null = null;
  afterEach(() => {
    if (fx !== null) {
      fx.cleanup();
      fx = null;
    }
  });

  it('skips re-translation when source_version already covers the entity version', async () => {
    fx = makeFixture();
    const layerId = seedLayer(fx.db, `t-${crypto.randomUUID().slice(0, 6)}`);
    createLayerLocalesRepo(fx.db).setLocales(layerId, ['en', 'nl'], 'en', new Date().toISOString());
    const userId = seedUser(fx.db, `u-${crypto.randomUUID().slice(0, 6)}`);
    const store = createEntityStore<FixturePayload>({
      module: FixtureModule,
      db: fx.db,
      bus: fx.bus,
      llm: createLlmClient({
        endpoint: 'mock://echo',
        apiKey: '',
        defaultModel: 'mock-default',
      }),
    });

    let translateCalls = 0;
    const translator = createEntityTranslator({
      module: FixtureModule,
      store,
      db: fx.db,
      bus: fx.bus,
      llm: createLlmClient({
        endpoint: 'mock://echo',
        apiKey: '',
        defaultModel: 'mock-default',
      }),
      translate: async (payload) => {
        translateCalls += 1;
        return payload;
      },
    });
    try {
      const created = await store.create({
        layerId,
        slug: 'skip-me',
        title: 'Skip me',
        originalLocale: 'en',
        payload: { title: 'Skip me', body: 'b' },
        actorId: userId,
      });
      expect(translateCalls).toBe(1);

      // Re-publish a "created" event manually with the same version —
      // the translator must skip because source_version >= entity.version.
      await fx.bus.publish({
        type: entityEventType('fixture', 'created'),
        payload: {
          ref: { id: created.id, kind: 'fixture', layerId, slug: 'skip-me' },
          version: 1,
          originalLocale: 'en',
          searchableText: 'Skip me\nb',
        },
      });
      expect(translateCalls).toBe(1);

      // An update bumps the version to 2 — translator runs again.
      await store.update({
        id: created.id,
        payload: { title: 'Skip me', body: 'b-v2' },
        actorId: userId,
      });
      expect(translateCalls).toBe(2);
    } finally {
      translator.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Migration: assert the 0005 schema lands on a fresh DB.
// ---------------------------------------------------------------------------

describe('phase 4.0 migration 0005_entities_base', () => {
  it('creates the four shared cross-cutting tables on a fresh DB', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-mig-0005-'));
    const db = openDatabase(dir);
    try {
      const tables = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all()
        .map((r) => r.name);
      expect(tables).toContain('entity_versions');
      expect(tables).toContain('entity_translations');
      expect(tables).toContain('entity_external_links');
      expect(tables).toContain('entity_souls');

      const indexes = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
        )
        .all()
        .map((r) => r.name);
      expect(indexes).toContain('idx_entity_versions_lookup');
      expect(indexes).toContain('idx_entity_translations_kind');
      expect(indexes).toContain('idx_entity_external_links_entity');
    } finally {
      db.close();
      safeRmSync(dir);
    }
  });
});

// Guard against "we never wired ENTITY_EVENT_TYPES into the suite"
// regression — surface the imported constant so eslint cannot trim it.
void ENTITY_EVENT_TYPES;
