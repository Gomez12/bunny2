/**
 * Phase 4c.1 — runs the §4.0 reusable contract suite against the real
 * `calendarEventModule` and the real `calendar_events` table created
 * by the `0009_calendar_events.sql` migration. Mirrors
 * `contacts-contract.test.ts` and `companies-contract.test.ts`
 * one-for-one: no kind-specific hacks; no foundation gaps. The fact
 * that 4c.1 needs zero new suite hooks is the empirical proof that
 * the §4.0 contract takes a clean third consumer — including a
 * non-TEXT (`all_day` INTEGER) indexed column.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { InMemoryMessageBus } from '@bunny2/bus';
import type { CalendarEventPayload } from '@bunny2/shared';
import { openDatabase } from '../../src/storage/sqlite';
import { createUsersRepo } from '../../src/repos/users-repo';
import { createLayersRepo } from '../../src/repos/layers-repo';
import { createLayerLocalesRepo } from '../../src/repos/layer-locales-repo';
import { createLlmClient } from '../../src/llm/client';
import { createEntityStore, __resetEntityRegistryForTests } from '../../src/entities';
import { calendarEventModule } from '../../src/entities/calendar';
import { runEntityContractSuite } from '../entity-contract/suite';
import { safeRmSync } from '../_helpers/temp-dir';

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
  cleanup(): void;
}

function makeFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-calendar-contract-'));
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
// Suite wiring — one fresh fixture per test (matches the companies + contacts
// pattern). The calendar_events table comes from the real 0009 migration,
// not an inline `CREATE TABLE`.
// ---------------------------------------------------------------------------

interface SuiteState {
  fx: Fixture;
  store: ReturnType<typeof createEntityStore<CalendarEventPayload>>;
}

let suiteState: SuiteState | null = null;

beforeEach(() => {
  const fx = makeFixture();
  const store = createEntityStore<CalendarEventPayload>({
    module: calendarEventModule,
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
  if (suiteState === null) throw new Error('calendar suite fixture not initialised');
  return suiteState;
}

runEntityContractSuite<CalendarEventPayload>({
  module: calendarEventModule,
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
    // `startsAt` is REQUIRED by the calendar payload schema; every
    // other field is optional. We deliberately omit
    // `attendees[].contactEntityId` (which expects a UUID) so the
    // suite's round-trip stays valid without seeding companies in
    // the fixture layer.
    const safe = seed.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'x';
    return {
      summary: `Summary ${seed}`,
      description: `A sample calendar event seeded with ${seed}.`,
      location: `Room ${safe}`,
      startsAt: '2026-06-01T09:00:00.000Z',
      endsAt: '2026-06-01T10:00:00.000Z',
      allDay: false,
      attendees: [
        { value: `alice+${safe}@example.com`, displayName: 'Alice', status: 'accepted' },
        { value: `bob+${safe}@example.com`, displayName: 'Bob', status: 'needs_action' },
      ],
      conferenceUrl: 'https://meet.example.com/x',
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
// suite — they exercise the 4c.1 projection rules end-to-end against the
// real `calendar_events` table:
//   - `starts_at` is required and round-trips verbatim.
//   - `ends_at` writes the value when set, NULL when cleared.
//   - `all_day` writes 0 / 1 as INTEGER (the first non-TEXT indexed column
//     the foundation accepts — zero foundation tweaks needed).
//   - `rrule_string` / `external_calendar_id` mirror payload values; sparse
//     indexes depend on the NULL behavior.
// ---------------------------------------------------------------------------

describe('calendar_events module :: indexed columns', () => {
  let fx: Fixture | null = null;
  afterEach(() => {
    if (fx !== null) {
      fx.cleanup();
      fx = null;
    }
  });

  it('writes starts_at / ends_at / all_day / rrule_string / external_calendar_id on create + update', async () => {
    fx = makeFixture();
    const layerId = seedLayer(fx.db, `c-${crypto.randomUUID().slice(0, 6)}`);
    const userId = seedUser(fx.db, `u-${crypto.randomUUID().slice(0, 6)}`);
    const store = createEntityStore<CalendarEventPayload>({
      module: calendarEventModule,
      db: fx.db,
      bus: fx.bus,
      llm: createLlmClient({
        endpoint: 'mock://echo',
        apiKey: '',
        defaultModel: 'mock-default',
      }),
    });
    const created = await store.create({
      layerId,
      slug: 'kickoff',
      title: 'Project kickoff',
      originalLocale: 'en',
      payload: {
        startsAt: '2026-06-01T09:00:00.000Z',
        endsAt: '2026-06-01T10:00:00.000Z',
        allDay: false,
        rruleString: 'FREQ=WEEKLY;BYDAY=MO',
        externalCalendarId: 'cal-primary@example.com',
      },
      actorId: userId,
    });

    type Row = {
      starts_at: string;
      ends_at: string | null;
      all_day: number;
      rrule_string: string | null;
      external_calendar_id: string | null;
    };
    const row = fx.db
      .query<
        Row,
        [string]
      >('SELECT starts_at, ends_at, all_day, rrule_string, external_calendar_id FROM calendar_events WHERE id = ?')
      .get(created.id);
    expect(row).not.toBeNull();
    expect(row?.starts_at).toBe('2026-06-01T09:00:00.000Z');
    expect(row?.ends_at).toBe('2026-06-01T10:00:00.000Z');
    // `all_day` is INTEGER. The §4.0 `IndexedValue = string | number
    // | null` slot already accepts this; SQLite returns the value as
    // a JS `number`.
    expect(row?.all_day).toBe(0);
    expect(typeof row?.all_day).toBe('number');
    expect(row?.rrule_string).toBe('FREQ=WEEKLY;BYDAY=MO');
    expect(row?.external_calendar_id).toBe('cal-primary@example.com');

    // Flip to an all-day event (date-only strings, allDay=true). The
    // INTEGER projection now writes 1 — same column, different value
    // space than the other four columns.
    await store.update({
      id: created.id,
      payload: {
        startsAt: '2026-06-02',
        allDay: true,
      },
      actorId: userId,
    });
    const after = fx.db
      .query<
        Row,
        [string]
      >('SELECT starts_at, ends_at, all_day, rrule_string, external_calendar_id FROM calendar_events WHERE id = ?')
      .get(created.id);
    expect(after?.starts_at).toBe('2026-06-02');
    expect(after?.ends_at).toBeNull();
    expect(after?.all_day).toBe(1);
    expect(after?.rrule_string).toBeNull();
    expect(after?.external_calendar_id).toBeNull();
  });
});

// `calendarEventModule` is exported for inspection in higher-phase tests;
// assert the indexed-column declarations so a future refactor that
// accidentally drops one is caught here, not in production.
describe('calendar_events module :: shape', () => {
  it('declares starts_at / ends_at / all_day / rrule_string / external_calendar_id as indexed columns', () => {
    const names = (calendarEventModule.indexedColumns ?? []).map((c) => c.name).sort();
    expect(names).toEqual([
      'all_day',
      'ends_at',
      'external_calendar_id',
      'rrule_string',
      'starts_at',
    ]);
  });

  it('builds a subtitle from startsAt and optional location', () => {
    const ref = {
      id: 'id',
      kind: 'calendar_event',
      layerId: 'layer',
      slug: 'slug',
    };
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
    const withLocation = calendarEventModule.toSummary({
      ref,
      meta,
      title: 'Kickoff',
      payload: {
        startsAt: '2026-06-01T09:00:00.000Z',
        allDay: false,
        location: 'Room A',
      },
    });
    expect(withLocation.subtitle).toBe('2026-06-01T09:00:00.000Z · Room A');

    const withoutLocation = calendarEventModule.toSummary({
      ref,
      meta,
      title: 'Kickoff',
      payload: {
        startsAt: '2026-06-01T09:00:00.000Z',
        allDay: false,
      },
    });
    expect(withoutLocation.subtitle).toBe('2026-06-01T09:00:00.000Z');
  });
});
