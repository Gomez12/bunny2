/**
 * Phase 4d.1 — runs the §4.0 reusable contract suite against the real
 * `todoModule` and the real `todos` table created by the
 * `0010_todos.sql` migration. Mirrors `calendar-contract.test.ts`,
 * `contacts-contract.test.ts`, and `companies-contract.test.ts`
 * one-for-one: no kind-specific hacks; no foundation gaps. The fact
 * that 4d.1 needs zero new suite hooks is the empirical proof that
 * the §4.0 contract takes a clean fourth consumer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import type { TodoPayload } from '@bunny2/shared';
import { openDatabase } from '../../src/storage/sqlite';
import { createUsersRepo } from '../../src/repos/users-repo';
import { createLayersRepo } from '../../src/repos/layers-repo';
import { createLayerLocalesRepo } from '../../src/repos/layer-locales-repo';
import { createLlmClient } from '../../src/llm/client';
import { createEntityStore, __resetEntityRegistryForTests } from '../../src/entities';
import { todoModule } from '../../src/entities/todos';
import { runEntityContractSuite } from '../entity-contract/suite';
import { safeRmSync } from '../_helpers/temp-dir';

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
  cleanup(): void;
}

function makeFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-todos-contract-'));
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
// Suite wiring — one fresh fixture per test (matches the companies + contacts +
// calendar pattern). The todos table comes from the real 0010 migration, not
// an inline `CREATE TABLE`.
// ---------------------------------------------------------------------------

interface SuiteState {
  fx: Fixture;
  store: ReturnType<typeof createEntityStore<TodoPayload>>;
}

let suiteState: SuiteState | null = null;

beforeEach(() => {
  const fx = makeFixture();
  const store = createEntityStore<TodoPayload>({
    module: todoModule,
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
  if (suiteState === null) throw new Error('todos suite fixture not initialised');
  return suiteState;
}

runEntityContractSuite<TodoPayload>({
  module: todoModule,
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
    // Every payload field is optional and `linkedEntityRef` is omitted
    // here deliberately — the contract suite does not seed companies /
    // contacts in the fixture layer, so a `linkedEntityRef` would have
    // no target to resolve. Include enough top-level keys to satisfy
    // the §4.0 PATCH-merge regression (≥2 keys required).
    //
    // `status` and `priority` are declared explicitly even though both
    // carry zod `.default(...)` values: the `EntityModule<Payload>`
    // slot wants the PARSED type, in which both fields are required,
    // so omitting them here would fail TS narrowing. The defaults
    // still apply when an HTTP client posts a payload without these
    // keys — zod runs before the type check.
    const safe = seed.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'x';
    return {
      description: `Sample todo for ${seed}`,
      status: 'open',
      priority: 3,
      dueAt: '2026-06-01',
      tags: [`tag-${safe}`],
    };
  },
  mutatePayload(payload, seed) {
    return {
      ...payload,
      description: `${payload.description ?? ''} :: ${seed}`,
    };
  },
});

// ---------------------------------------------------------------------------
// Per-kind indexed-column assertions. These are NOT part of the §4.0 contract
// suite — they exercise the 4d.1 projection rules end-to-end against the
// real `todos` table:
//   - `status` writes the payload value (TEXT) and defaults to 'open'.
//   - `priority` writes the payload value (INTEGER) and defaults to 3.
//   - `due_at` mirrors payload; clears to NULL when omitted on update.
//   - `linked_entity_id` / `linked_entity_kind` are written together when
//     `payload.linkedEntityRef` is present; both NULL when cleared. The
//     migration's CHECK enforces "both or neither" as a defensive backstop.
// ---------------------------------------------------------------------------

describe('todos module :: indexed columns', () => {
  let fx: Fixture | null = null;
  afterEach(() => {
    if (fx !== null) {
      fx.cleanup();
      fx = null;
    }
  });

  it('writes status / priority / due_at / linked_entity_{id,kind} on create + update', async () => {
    fx = makeFixture();
    const layerId = seedLayer(fx.db, `t-${crypto.randomUUID().slice(0, 6)}`);
    const userId = seedUser(fx.db, `u-${crypto.randomUUID().slice(0, 6)}`);
    const store = createEntityStore<TodoPayload>({
      module: todoModule,
      db: fx.db,
      bus: fx.bus,
      llm: createLlmClient({
        endpoint: 'mock://echo',
        apiKey: '',
        defaultModel: 'mock-default',
      }),
    });
    const linkedId = crypto.randomUUID();
    const created = await store.create({
      layerId,
      slug: 'call-ami',
      title: 'Call AMI BV',
      originalLocale: 'en',
      payload: {
        status: 'in_progress',
        priority: 2,
        dueAt: '2026-06-15T09:00:00.000Z',
        linkedEntityRef: { kind: 'contact', entityId: linkedId },
      },
      actorId: userId,
    });

    type Row = {
      status: string;
      priority: number;
      due_at: string | null;
      linked_entity_id: string | null;
      linked_entity_kind: string | null;
    };
    const row = fx.db
      .query<
        Row,
        [string]
      >('SELECT status, priority, due_at, linked_entity_id, linked_entity_kind FROM todos WHERE id = ?')
      .get(created.id);
    expect(row).not.toBeNull();
    expect(row?.status).toBe('in_progress');
    expect(row?.priority).toBe(2);
    expect(typeof row?.priority).toBe('number');
    expect(row?.due_at).toBe('2026-06-15T09:00:00.000Z');
    expect(row?.linked_entity_id).toBe(linkedId);
    expect(row?.linked_entity_kind).toBe('contact');

    // Clear the link + due date; status moves to 'done', priority
    // explicitly stays at default 3. The §4.0 top-level merge in the
    // PATCH router would preserve omitted keys, but the store.update
    // here writes the payload wholesale — so the indexed columns
    // clear to NULL where the payload field is absent.
    await store.update({
      id: created.id,
      payload: {
        status: 'done',
        priority: 3,
      },
      actorId: userId,
    });
    const after = fx.db
      .query<
        Row,
        [string]
      >('SELECT status, priority, due_at, linked_entity_id, linked_entity_kind FROM todos WHERE id = ?')
      .get(created.id);
    expect(after?.status).toBe('done');
    // `priority` defaults to 3 when the zod schema parses a payload
    // without an explicit value — same way `status` defaults to 'open'.
    // The shared schema sees the parsed value, not the input.
    expect(after?.priority).toBe(3);
    expect(after?.due_at).toBeNull();
    expect(after?.linked_entity_id).toBeNull();
    expect(after?.linked_entity_kind).toBeNull();
  });
});

// `todoModule` is exported for inspection in higher-phase tests;
// assert the indexed-column declarations so a future refactor that
// accidentally drops one is caught here, not in production.
describe('todos module :: shape', () => {
  it('declares status / priority / due_at / linked_entity_{id,kind} as indexed columns', () => {
    const names = (todoModule.indexedColumns ?? []).map((c) => c.name).sort();
    expect(names).toEqual([
      'due_at',
      'linked_entity_id',
      'linked_entity_kind',
      'priority',
      'status',
    ]);
  });

  it('builds a subtitle from status, dueAt, and linkedEntityRef.kind', () => {
    const ref = { id: 'id', kind: 'todo', layerId: 'layer', slug: 'slug' };
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
    const linkedId = crypto.randomUUID();
    const rich = todoModule.toSummary({
      ref,
      meta,
      title: 'Call AMI BV',
      payload: {
        status: 'in_progress',
        priority: 2,
        dueAt: '2026-06-15',
        linkedEntityRef: { kind: 'company', entityId: linkedId },
      },
    });
    expect(rich.subtitle).toBe('in_progress · due 2026-06-15 · @company');

    const plain = todoModule.toSummary({
      ref,
      meta,
      title: 'Buy milk',
      payload: { status: 'open', priority: 3 },
    });
    expect(plain.subtitle).toBe('open');
  });
});
