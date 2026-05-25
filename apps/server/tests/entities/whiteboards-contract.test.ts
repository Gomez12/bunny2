/**
 * Phase 11.1 — runs the §4.0 reusable contract suite against the real
 * `whiteboardModule` and the real `whiteboards` table created by the
 * `0021_whiteboards.sql` migration. Mirrors `todos-contract.test.ts`
 * one-for-one: no kind-specific hacks; no foundation gaps. The fact
 * that 11.1 needs zero new suite hooks is the empirical proof that
 * the §4.0 contract takes a clean fifth consumer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import type { WhiteboardPayload } from '@bunny2/shared';
import { openDatabase } from '../../src/storage/sqlite';
import { createUsersRepo } from '../../src/repos/users-repo';
import { createLayersRepo } from '../../src/repos/layers-repo';
import { createLayerLocalesRepo } from '../../src/repos/layer-locales-repo';
import { createLlmClient } from '../../src/llm/client';
import { createEntityStore, __resetEntityRegistryForTests } from '../../src/entities';
import { whiteboardModule } from '../../src/entities/whiteboards';
import { runEntityContractSuite } from '../entity-contract/suite';
import { safeRmSync } from '../_helpers/temp-dir';

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
  cleanup(): void;
}

function makeFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-whiteboards-contract-'));
  const db = openDatabase(dir);
  const bus = new InMemoryMessageBus();
  return {
    dir,
    db,
    bus,
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

// ---------------------------------------------------------------------------
// Suite wiring — one fresh fixture per test (matches the todos /
// calendar / contacts / companies pattern). The whiteboards table
// comes from the real 0021 migration, not an inline `CREATE TABLE`.
// ---------------------------------------------------------------------------

interface SuiteState {
  fx: Fixture;
  store: ReturnType<typeof createEntityStore<WhiteboardPayload>>;
}

let suiteState: SuiteState | null = null;

beforeEach(() => {
  const fx = makeFixture();
  const store = createEntityStore<WhiteboardPayload>({
    module: whiteboardModule,
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
  if (suiteState === null) throw new Error('whiteboards suite fixture not initialised');
  return suiteState;
}

runEntityContractSuite<WhiteboardPayload>({
  module: whiteboardModule,
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
    // Two top-level keys (`scene`, `files`) satisfy the §4.0
    // PATCH-merge regression (≥2 keys required). Both keys are
    // non-undefined; `files` is a non-empty record so the merge test
    // can pick it as the preserved key when `mutatePayload` changes
    // `scene`. A single text element makes `searchableText`
    // non-empty so `searchSummaries` finds the row by its text
    // content.
    const safe = seed.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'x';
    return {
      scene: {
        elements: [
          {
            id: `el-${safe}`,
            type: 'text',
            version: 1,
            text: `Sample whiteboard for ${seed}`,
          },
        ],
      },
      files: {
        [`file-${safe}`]: {
          id: `file-${safe}`,
          mimeType: 'image/png',
          dataURL: 'data:image/png;base64,',
          created: 0,
        },
      },
    } satisfies WhiteboardPayload;
  },
  mutatePayload(payload, seed) {
    // Change `scene` (the patched key for the merge test) by adding
    // a second text element. `files` is preserved verbatim so the
    // merge test can pick it as the preserved-key witness.
    return {
      ...payload,
      scene: {
        ...payload.scene,
        elements: [
          ...payload.scene.elements,
          {
            id: `el-mut-${seed}`,
            type: 'text',
            version: 1,
            text: `Mutated ${seed}`,
          },
        ],
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Per-kind indexed-column assertions. These are NOT part of the §4.0
// contract suite — they exercise the 11.1 projection rules end-to-end
// against the real `whiteboards` table:
//   - `scene_byte_size` writes the payload's JSON length on every save
//     and matches `JSON.stringify(payload).length` exactly.
//   - The server-managed columns (`last_checkpoint_at`,
//     `thumbnail_blob`, `thumbnail_etag`) stay NULL through CRUD —
//     11.5 owns writing them; 11.1 must NOT erase them by accident.
// ---------------------------------------------------------------------------

describe('whiteboards module :: indexed columns', () => {
  let fx: Fixture | null = null;
  afterEach(() => {
    if (fx !== null) {
      fx.cleanup();
      fx = null;
    }
  });

  it('writes scene_byte_size on create + update; leaves server-managed columns NULL', async () => {
    fx = makeFixture();
    const layerId = seedLayer(fx.db, `w-${crypto.randomUUID().slice(0, 6)}`);
    const userId = seedUser(fx.db, `u-${crypto.randomUUID().slice(0, 6)}`);
    const store = createEntityStore<WhiteboardPayload>({
      module: whiteboardModule,
      db: fx.db,
      bus: fx.bus,
      llm: createLlmClient({
        endpoint: 'mock://echo',
        apiKey: '',
        defaultModel: 'mock-default',
      }),
    });

    const payload: WhiteboardPayload = {
      scene: {
        elements: [
          { id: 'el-1', type: 'text', version: 1, text: 'Hello' } as unknown as {
            id: string;
            type: string;
            version: number;
          },
        ],
      },
      files: {},
    };
    const created = await store.create({
      layerId,
      slug: 'first',
      title: 'First whiteboard',
      originalLocale: 'en',
      payload,
      actorId: userId,
    });

    type Row = {
      scene_byte_size: number;
      last_checkpoint_at: string | null;
      thumbnail_blob: Uint8Array | null;
      thumbnail_etag: string | null;
    };
    const row = fx.db
      .query<
        Row,
        [string]
      >('SELECT scene_byte_size, last_checkpoint_at, thumbnail_blob, thumbnail_etag FROM whiteboards WHERE id = ?')
      .get(created.id);
    expect(row).not.toBeNull();
    expect(row?.scene_byte_size).toBe(JSON.stringify(payload).length);
    expect(typeof row?.scene_byte_size).toBe('number');
    expect(row?.last_checkpoint_at).toBeNull();
    expect(row?.thumbnail_blob).toBeNull();
    expect(row?.thumbnail_etag).toBeNull();

    // Add an element; byte size grows.
    const biggerPayload: WhiteboardPayload = {
      scene: {
        elements: [
          ...payload.scene.elements,
          { id: 'el-2', type: 'text', version: 1, text: 'World' } as unknown as {
            id: string;
            type: string;
            version: number;
          },
        ],
      },
      files: {},
    };
    await store.update({
      id: created.id,
      payload: biggerPayload,
      actorId: userId,
    });
    const after = fx.db
      .query<
        Row,
        [string]
      >('SELECT scene_byte_size, last_checkpoint_at, thumbnail_blob, thumbnail_etag FROM whiteboards WHERE id = ?')
      .get(created.id);
    expect(after?.scene_byte_size).toBe(JSON.stringify(biggerPayload).length);
    expect(after?.scene_byte_size).toBeGreaterThan(row?.scene_byte_size ?? 0);
    // Server-managed columns stay NULL — 11.1's `indexedColumns`
    // MUST NOT touch them.
    expect(after?.last_checkpoint_at).toBeNull();
    expect(after?.thumbnail_blob).toBeNull();
    expect(after?.thumbnail_etag).toBeNull();
  });
});

// `whiteboardModule` is exported for inspection in higher-phase
// tests; assert the indexed-column declarations + subtitle shape so a
// future refactor that accidentally drops one is caught here, not in
// production.
describe('whiteboards module :: shape', () => {
  it('declares scene_byte_size as the only indexed column', () => {
    const names = (whiteboardModule.indexedColumns ?? []).map((c) => c.name).sort();
    // Server-managed columns (last_checkpoint_at, thumbnail_etag)
    // MUST NOT appear here — see module.ts comment.
    expect(names).toEqual(['scene_byte_size']);
  });

  it('builds a subtitle that counts elements', () => {
    const ref = { id: 'id', kind: 'whiteboard', layerId: 'layer', slug: 'slug' };
    const meta = {
      createdAt: '2020-01-01T00:00:00.000Z',
      createdBy: 'u',
      updatedAt: '2020-01-01T00:00:00.000Z',
      updatedBy: 'u',
      deletedAt: null,
      deletedBy: null,
      version: 1,
      originalLocale: 'en',
    };
    const empty = whiteboardModule.toSummary({
      ref,
      meta,
      title: 'Empty',
      payload: { scene: { elements: [] }, files: {} },
    });
    expect(empty.subtitle).toBe('0 elements');

    const one = whiteboardModule.toSummary({
      ref,
      meta,
      title: 'Single element',
      payload: {
        scene: {
          elements: [
            { id: 'a', type: 'rectangle', version: 1 } as unknown as {
              id: string;
              type: string;
              version: number;
            },
          ],
        },
        files: {},
      },
    });
    expect(one.subtitle).toBe('1 element');
  });

  it('searchableText extracts text-element bodies only (lowercase, joined)', () => {
    const payload: WhiteboardPayload = {
      scene: {
        elements: [
          { id: 'a', type: 'text', version: 1, text: 'Hello World' } as unknown as {
            id: string;
            type: string;
            version: number;
          },
          // Non-text elements MUST NOT contribute to the index.
          { id: 'b', type: 'rectangle', version: 1, label: 'secret' } as unknown as {
            id: string;
            type: string;
            version: number;
          },
          { id: 'c', type: 'text', version: 1, text: 'AMI BV' } as unknown as {
            id: string;
            type: string;
            version: number;
          },
        ],
      },
      files: {},
    };
    expect(whiteboardModule.searchableText(payload)).toBe('hello world ami bv');
  });
});
