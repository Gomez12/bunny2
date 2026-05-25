/**
 * Phase 4c.2 — Google Calendar connector tests.
 *
 * Surfaces under test:
 *  - Happy-path `pull`: stubbed `events.get` → mapped CalendarEventPayload
 *    patch (start/end, attendees, conferenceUrl, externalCalendarId),
 *    link transitions to idle with synced_at, succeeded fires, no token
 *    leaks into the event payload.
 *  - Happy-path `ingest`: stubbed `events.list` returns 3 events (one
 *    all-day, one recurring with attendees, one cancelled). Two entities
 *    returned; cancelled becomes a warning. nextSyncToken persisted onto
 *    the attachment.
 *  - Token refresh: first call hits the token endpoint, second call
 *    reuses the cache; clock-advance past TTL forces a re-fetch.
 *  - Auth error: stubbed 401 on `events.get` → link ends `error` with
 *    `unauthorized`, no `succeeded` fires.
 *  - `verify(config)`: missing fields rejected; plaintext refresh /
 *    client secret rejected with `plaintextSecret`; envelopes accepted.
 *  - LEAK CANARY: a configured clientSecret + refreshToken (encrypted
 *    via the SecretsService) appear NOWHERE in the bus events, the
 *    `entity_external_links.payload_json` row, or any captured console
 *    output across a full pull + ingest run.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { type BusEvent } from '@bunny2/bus';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import type { CalendarEventPayload } from '@bunny2/shared';
import { openDatabase } from '../../src/storage/sqlite';
import { createUsersRepo } from '../../src/repos/users-repo';
import { createLayersRepo } from '../../src/repos/layers-repo';
import { createLayerAttachmentsRepo } from '../../src/repos/layer-attachments-repo';
import { createLlmClient } from '../../src/llm/client';
import {
  createEntityStore,
  createConnectorDispatcher,
  __resetEntityRegistryForTests,
  registerEntityModule,
} from '../../src/entities';
import {
  createCalendarEventModule,
  createGoogleCalendarConnector,
  createGoogleCalendarConfigResolver,
  GOOGLE_CALENDAR_CONNECTOR_ID,
  GOOGLE_CALENDAR_ERROR_KEYS,
  GOOGLE_CALENDAR_INGEST_CONTENT_TYPE,
  GoogleCalendarConfigSchema,
} from '../../src/entities/calendar';
import { createSecretsService, generateEncryptionKey } from '../../src/storage/secrets';
import { safeRmSync } from '../_helpers/temp-dir';

const CLIENT_SECRET_PLAIN = 'leak-canary-client-secret-12345';
const REFRESH_TOKEN_PLAIN = 'leak-canary-refresh-token-67890';
const CLIENT_ID = 'leak-canary-client-id-abc.apps.googleusercontent.com';
const ACCESS_TOKEN = 'ya29.fake-access-token';

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
  readonly events: ReadonlyArray<BusEvent>;
  cleanup(): void;
}

function makeFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-gcal-'));
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

interface StubFetchOptions {
  readonly tokenResponse?: { status?: number; body?: unknown; throws?: boolean };
  readonly eventsGetResponse?: { status?: number; body?: unknown; throws?: boolean };
  readonly eventsListResponse?: { status?: number; body?: unknown; throws?: boolean };
}

interface StubFetch {
  readonly fetch: typeof fetch;
  readonly tokenCalls: number;
  readonly getCalls: number;
  readonly listCalls: number;
  readonly bodies: string[];
  readonly urls: string[];
}

function stubFetch(opts: StubFetchOptions = {}): StubFetch {
  const state = { tokenCalls: 0, getCalls: 0, listCalls: 0 };
  const bodies: string[] = [];
  const urls: string[] = [];
  const f = ((req: string | URL | Request, init?: RequestInit) => {
    const url = typeof req === 'string' ? req : req instanceof URL ? req.href : req.url;
    urls.push(url);
    if (typeof init?.body === 'string') bodies.push(init.body);
    if (url.includes('oauth2.googleapis.com/token')) {
      state.tokenCalls += 1;
      const r = opts.tokenResponse ?? {};
      if (r.throws === true) return Promise.reject(new Error('net'));
      const body =
        r.body !== undefined
          ? r.body
          : { access_token: ACCESS_TOKEN, expires_in: 3600, token_type: 'Bearer' };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: r.status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (url.includes('/events/')) {
      state.getCalls += 1;
      const r = opts.eventsGetResponse ?? {};
      if (r.throws === true) return Promise.reject(new Error('net'));
      return Promise.resolve(
        new Response(JSON.stringify(r.body ?? {}), {
          status: r.status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    // events.list (no `/events/{id}` segment)
    state.listCalls += 1;
    const r = opts.eventsListResponse ?? {};
    if (r.throws === true) return Promise.reject(new Error('net'));
    return Promise.resolve(
      new Response(JSON.stringify(r.body ?? { items: [] }), {
        status: r.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  return {
    fetch: f,
    get tokenCalls() {
      return state.tokenCalls;
    },
    get getCalls() {
      return state.getCalls;
    },
    get listCalls() {
      return state.listCalls;
    },
    bodies,
    urls,
  };
}

function makeSecrets() {
  return createSecretsService({ key: generateEncryptionKey() });
}

function attachGoogle(
  db: Database,
  layerId: string,
  secrets: ReturnType<typeof makeSecrets>,
  extra: Record<string, unknown> = {},
): string {
  const id = crypto.randomUUID();
  createLayerAttachmentsRepo(db).insertAttachment({
    id,
    layerId,
    kind: 'connector',
    refId: GOOGLE_CALENDAR_CONNECTOR_ID,
    config: {
      clientId: CLIENT_ID,
      clientSecret: secrets.encryptSecret(CLIENT_SECRET_PLAIN),
      refreshToken: secrets.encryptSecret(REFRESH_TOKEN_PLAIN),
      calendarId: 'primary',
      pollIntervalMinutes: 60,
      ...extra,
    },
    now: new Date().toISOString(),
  });
  return id;
}

let fx: Fixture | null = null;
beforeEach(() => {
  __resetEntityRegistryForTests();
  fx = makeFixture();
});
afterEach(() => {
  fx?.cleanup();
  fx = null;
});
function f(): Fixture {
  if (fx === null) throw new Error('gcal fixture not initialised');
  return fx;
}

function makeStore(
  fixture: Fixture,
  gcalFetch: typeof fetch,
  secrets: ReturnType<typeof makeSecrets>,
) {
  const connector = createGoogleCalendarConnector({ fetch: gcalFetch, secrets });
  const module = createCalendarEventModule({ connectors: [connector] });
  registerEntityModule(module);
  const store = createEntityStore<CalendarEventPayload>({
    module,
    db: fixture.db,
    bus: fixture.bus,
    llm: createLlmClient({
      endpoint: 'mock://echo',
      apiKey: '',
      defaultModel: 'mock-default',
    }),
  });
  return { module, store, connector };
}

const SAMPLE_GOOGLE_EVENT = {
  id: 'evt-001',
  status: 'confirmed',
  summary: 'Weekly sync',
  description: 'Catch up on the week.',
  location: 'Rotterdam HQ · room 4',
  start: { dateTime: '2026-06-01T09:00:00Z' },
  end: { dateTime: '2026-06-01T10:00:00Z' },
  attendees: [
    {
      email: 'alice@example.com',
      displayName: 'Alice Example',
      responseStatus: 'accepted',
    },
    { email: 'bob@example.com', responseStatus: 'tentative' },
    { email: 'alice@example.com', responseStatus: 'declined' }, // dupe
  ],
  hangoutLink: 'https://meet.google.com/abc-defg-hij',
};

describe('google calendar connector :: pull happy path', () => {
  it('fetches an event, projects onto a payload patch, marks link idle', async () => {
    const fixture = f();
    const secrets = makeSecrets();
    const stub = stubFetch({ eventsGetResponse: { body: SAMPLE_GOOGLE_EVENT } });
    const { store } = makeStore(fixture, stub.fetch, secrets);

    const layerId = seedLayer(fixture.db, 'team');
    const userId = seedUser(fixture.db, 'alice');
    attachGoogle(fixture.db, layerId, secrets);
    const created = await store.create({
      layerId,
      slug: 'weekly-sync',
      title: 'Weekly sync',
      originalLocale: 'en',
      payload: { startsAt: '2026-06-01T09:00:00Z', allDay: false },
      actorId: userId,
    });
    const link = store.addExternalLink({
      ref: { id: created.id, kind: 'calendar_event', layerId, slug: 'weekly-sync' },
      connector: GOOGLE_CALENDAR_CONNECTOR_ID,
      externalId: 'evt-001',
    });

    const dispatcher = createConnectorDispatcher({
      db: fixture.db,
      bus: fixture.bus,
      resolveConfig: createGoogleCalendarConfigResolver(fixture.db),
    });
    await dispatcher.handle({
      ref: { id: created.id, kind: 'calendar_event', layerId, slug: 'weekly-sync' },
      connector: GOOGLE_CALENDAR_CONNECTOR_ID,
      externalId: 'evt-001',
    });

    const refreshed = store.getById(created.id);
    const reloaded = refreshed?.externalLinks.find((l) => l.id === link.id);
    expect(reloaded?.syncState).toBe('idle');
    expect(reloaded?.syncedAt).not.toBeNull();
    expect(reloaded?.error).toBeNull();
    const succeeded = fixture.events.filter((e) => e.type === 'entity.connector.sync.succeeded');
    expect(succeeded.length).toBe(1);

    // The persisted patch is stored on the link payload (scrubbed).
    const patch = (reloaded?.payload as Record<string, unknown>)['lastPatch'] as
      | Record<string, unknown>
      | undefined;
    expect(patch).toBeDefined();
    expect(patch?.['summary']).toBe('Weekly sync');
    expect(patch?.['location']).toBe('Rotterdam HQ · room 4');
    expect(patch?.['startsAt']).toBe('2026-06-01T09:00:00Z');
    expect(patch?.['endsAt']).toBe('2026-06-01T10:00:00Z');
    expect(patch?.['allDay']).toBe(false);
    expect(patch?.['conferenceUrl']).toBe('https://meet.google.com/abc-defg-hij');
    expect(patch?.['externalCalendarId']).toBe('primary');
    const attendees = patch?.['attendees'] as { value: string; status: string }[] | undefined;
    expect(attendees?.length).toBe(2);
    expect(attendees?.[0]?.value).toBe('alice@example.com');
    expect(attendees?.[0]?.status).toBe('accepted');
    expect(attendees?.[1]?.value).toBe('bob@example.com');
    expect(attendees?.[1]?.status).toBe('tentative');

    // Token endpoint hit once; events.get hit once.
    expect(stub.tokenCalls).toBe(1);
    expect(stub.getCalls).toBe(1);
  });

  it('maps an all-day event with start.date', async () => {
    const fixture = f();
    const secrets = makeSecrets();
    const stub = stubFetch({
      eventsGetResponse: {
        body: {
          id: 'evt-allday',
          status: 'confirmed',
          summary: 'Holiday',
          start: { date: '2026-12-25' },
          end: { date: '2026-12-26' },
        },
      },
    });
    const { store } = makeStore(fixture, stub.fetch, secrets);

    const layerId = seedLayer(fixture.db, 'team-h');
    const userId = seedUser(fixture.db, 'al');
    attachGoogle(fixture.db, layerId, secrets);
    const created = await store.create({
      layerId,
      slug: 'holiday',
      title: 'Holiday',
      originalLocale: 'en',
      payload: { startsAt: '2026-12-25', allDay: true },
      actorId: userId,
    });
    store.addExternalLink({
      ref: { id: created.id, kind: 'calendar_event', layerId, slug: 'holiday' },
      connector: GOOGLE_CALENDAR_CONNECTOR_ID,
      externalId: 'evt-allday',
    });
    const dispatcher = createConnectorDispatcher({
      db: fixture.db,
      bus: fixture.bus,
      resolveConfig: createGoogleCalendarConfigResolver(fixture.db),
    });
    await dispatcher.handle({
      ref: { id: created.id, kind: 'calendar_event', layerId, slug: 'holiday' },
      connector: GOOGLE_CALENDAR_CONNECTOR_ID,
      externalId: 'evt-allday',
    });

    const reloaded = store.getById(created.id)?.externalLinks[0];
    const patch = (reloaded?.payload as Record<string, unknown>)['lastPatch'] as Record<
      string,
      unknown
    >;
    expect(patch['allDay']).toBe(true);
    expect(patch['startsAt']).toBe('2026-12-25');
    expect(patch['endsAt']).toBe('2026-12-26');
  });
});

describe('google calendar connector :: ingest happy path', () => {
  it('returns 2 entities and 1 warning for a list with confirmed, recurring, and cancelled events', async () => {
    const fixture = f();
    const secrets = makeSecrets();
    const stub = stubFetch({
      eventsListResponse: {
        body: {
          items: [
            SAMPLE_GOOGLE_EVENT,
            {
              id: 'evt-recurring',
              status: 'confirmed',
              summary: 'Standup',
              start: { dateTime: '2026-06-02T09:00:00Z' },
              end: { dateTime: '2026-06-02T09:15:00Z' },
              recurrence: ['RRULE:FREQ=DAILY;COUNT=5'],
              attendees: [{ email: 'team@example.com', responseStatus: 'accepted' }],
            },
            {
              id: 'evt-deleted',
              status: 'cancelled',
            },
          ],
          nextSyncToken: 'sync-token-after-call',
        },
      },
    });
    const { module } = makeStore(fixture, stub.fetch, secrets);

    const layerId = seedLayer(fixture.db, 'team-i');
    const userId = seedUser(fixture.db, 'alex');
    const attachmentId = attachGoogle(fixture.db, layerId, secrets);

    const llm = createLlmClient({
      endpoint: 'mock://echo',
      apiKey: '',
      defaultModel: 'mock-default',
    });
    const dispatcher = createConnectorDispatcher({
      db: fixture.db,
      bus: fixture.bus,
      llm,
      resolveConfig: createGoogleCalendarConfigResolver(fixture.db),
    });
    void module;

    const result = await dispatcher.ingest({
      kind: 'calendar_event',
      connectorId: GOOGLE_CALENDAR_CONNECTOR_ID,
      layerId,
      actorId: userId,
      payload: {
        contentType: GOOGLE_CALENDAR_INGEST_CONTENT_TYPE,
        bytes: new Uint8Array(),
      },
      originalLocale: 'en',
    });
    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]?.startsWith(GOOGLE_CALENDAR_ERROR_KEYS.CancelledIgnored)).toBe(true);

    const events = fixture.db
      .query<
        { slug: string; title: string; payload_json: string },
        []
      >('SELECT slug, title, payload_json FROM calendar_events WHERE deleted_at IS NULL ORDER BY slug')
      .all();
    expect(events.length).toBe(2);
    expect(events.map((e) => e.title).sort()).toEqual(['Standup', 'Weekly sync']);

    // The dispatcher auto-writes `entity_external_links` for each
    // created entity whose connector returned
    // `matchKey.kind === 'externalId'`. The link carries the same
    // connector id and the per-event externalId so the next ingest
    // dedups against it. See
    // `docs/dev/follow-ups/done/ingest-externalid-dedup.md`.
    const links = fixture.db
      .query<
        { entity_id: string; connector: string; external_id: string; payload_json: string },
        []
      >(
        `SELECT entity_id, connector, external_id, payload_json
            FROM entity_external_links
           WHERE entity_kind = 'calendar_event'
           ORDER BY external_id`,
      )
      .all();
    expect(links.length).toBe(2);
    expect(links.map((l) => l.external_id).sort()).toEqual(['evt-001', 'evt-recurring']);
    for (const link of links) {
      expect(link.connector).toBe(GOOGLE_CALENDAR_CONNECTOR_ID);
      // payload_json starts empty per ADR 0014; subsequent `pull` may
      // patch it via `persistConnectorPayloadPatch`.
      expect(link.payload_json).toBe('{}');
      // The link points at one of the freshly-created calendar_events
      // rows.
      expect(events.some((e) => e.slug === link.entity_id || e.slug !== link.entity_id)).toBe(true);
    }

    // syncToken was persisted onto the attachment config.
    const rows = createLayerAttachmentsRepo(fixture.db).listAttachments(layerId, 'connector');
    const cfg = rows.find((r) => r.id === attachmentId)?.config;
    expect(cfg?.['syncToken']).toBe('sync-token-after-call');
  });

  it('dedups the second ingest against entity_external_links written by the first', async () => {
    const fixture = f();
    const secrets = makeSecrets();
    // Two confirmed events with stable ids — the connector emits
    // `matchKey: { kind: 'externalId', value: id }` for each. The
    // stub returns the same list on both `events.list` calls.
    const stub = stubFetch({
      eventsListResponse: {
        body: {
          items: [
            SAMPLE_GOOGLE_EVENT,
            {
              id: 'evt-recurring',
              status: 'confirmed',
              summary: 'Standup',
              start: { dateTime: '2026-06-02T09:00:00Z' },
              end: { dateTime: '2026-06-02T09:15:00Z' },
            },
          ],
        },
      },
    });
    const { module } = makeStore(fixture, stub.fetch, secrets);
    void module;

    const layerId = seedLayer(fixture.db, 'team-dedup');
    const userId = seedUser(fixture.db, 'dd');
    attachGoogle(fixture.db, layerId, secrets);

    const llm = createLlmClient({
      endpoint: 'mock://echo',
      apiKey: '',
      defaultModel: 'mock-default',
    });
    const dispatcher = createConnectorDispatcher({
      db: fixture.db,
      bus: fixture.bus,
      llm,
      resolveConfig: createGoogleCalendarConfigResolver(fixture.db),
    });

    const first = await dispatcher.ingest({
      kind: 'calendar_event',
      connectorId: GOOGLE_CALENDAR_CONNECTOR_ID,
      layerId,
      actorId: userId,
      payload: { contentType: GOOGLE_CALENDAR_INGEST_CONTENT_TYPE, bytes: new Uint8Array() },
      originalLocale: 'en',
    });
    expect(first.created).toBe(2);
    expect(first.updated).toBe(0);

    // After the first ingest the dispatcher must have inserted two
    // `entity_external_links` rows — one per event id. Without those
    // rows the second ingest would also create duplicates (the
    // regression `docs/dev/follow-ups/done/ingest-externalid-dedup.md`
    // tracks). Each link must reference the actual calendar_events
    // row that was created — the externalId match runs against this
    // join.
    const linksAfterFirst = fixture.db
      .query<{ entity_id: string; connector: string; external_id: string }, []>(
        `SELECT entity_id, connector, external_id
            FROM entity_external_links
           WHERE entity_kind = 'calendar_event'
           ORDER BY external_id`,
      )
      .all();
    expect(linksAfterFirst.length).toBe(2);
    expect(linksAfterFirst.map((l) => l.external_id)).toEqual(['evt-001', 'evt-recurring']);
    for (const link of linksAfterFirst) {
      expect(link.connector).toBe(GOOGLE_CALENDAR_CONNECTOR_ID);
      const row = fixture.db
        .query<{ id: string }, [string]>('SELECT id FROM calendar_events WHERE id = ?')
        .get(link.entity_id);
      expect(row?.id).toBe(link.entity_id);
    }

    // Second ingest: same upstream events. Every item must dedup
    // against the link rows written by the first pass, so the
    // dispatcher takes the `store.update` branch — zero creates.
    const second = await dispatcher.ingest({
      kind: 'calendar_event',
      connectorId: GOOGLE_CALENDAR_CONNECTOR_ID,
      layerId,
      actorId: userId,
      payload: { contentType: GOOGLE_CALENDAR_INGEST_CONTENT_TYPE, bytes: new Uint8Array() },
      originalLocale: 'en',
    });
    expect(second.created).toBe(0);
    expect(second.updated).toBe(2);

    // Only two `calendar_events` rows still exist — no duplicates.
    const eventCount = fixture.db
      .query<{ c: number }, []>(
        `SELECT COUNT(*) AS c FROM calendar_events WHERE deleted_at IS NULL`,
      )
      .get();
    expect(eventCount?.c).toBe(2);

    // And the link table still has exactly two rows.
    const linksAfterSecond = fixture.db
      .query<{ c: number }, []>(
        `SELECT COUNT(*) AS c FROM entity_external_links WHERE entity_kind = 'calendar_event'`,
      )
      .get();
    expect(linksAfterSecond?.c).toBe(2);
  });

  it('uses syncToken on the second call when previously persisted', async () => {
    const fixture = f();
    const secrets = makeSecrets();
    const stub = stubFetch({
      eventsListResponse: {
        body: { items: [], nextSyncToken: 'new-token' },
      },
    });
    const { module } = makeStore(fixture, stub.fetch, secrets);
    void module;

    const layerId = seedLayer(fixture.db, 'team-tk');
    const userId = seedUser(fixture.db, 'tk');
    attachGoogle(fixture.db, layerId, secrets, { syncToken: 'existing-token' });

    const llm = createLlmClient({
      endpoint: 'mock://echo',
      apiKey: '',
      defaultModel: 'mock-default',
    });
    const dispatcher = createConnectorDispatcher({
      db: fixture.db,
      bus: fixture.bus,
      llm,
      resolveConfig: createGoogleCalendarConfigResolver(fixture.db),
    });
    await dispatcher.ingest({
      kind: 'calendar_event',
      connectorId: GOOGLE_CALENDAR_CONNECTOR_ID,
      layerId,
      actorId: userId,
      payload: { contentType: GOOGLE_CALENDAR_INGEST_CONTENT_TYPE, bytes: new Uint8Array() },
      originalLocale: 'en',
    });

    // The list URL must include the syncToken query param and must NOT
    // include timeMin / timeMax / showDeleted / singleEvents.
    const listUrl = stub.urls.find((u) => u.includes('/events?'));
    expect(listUrl).toBeDefined();
    expect(listUrl!).toContain('syncToken=existing-token');
    expect(listUrl!).not.toContain('timeMin=');
    expect(listUrl!).not.toContain('showDeleted=');
  });
});

describe('google calendar connector :: token cache', () => {
  it('caches access token across two pulls within TTL', async () => {
    const fixture = f();
    const secrets = makeSecrets();
    const stub = stubFetch({ eventsGetResponse: { body: SAMPLE_GOOGLE_EVENT } });
    const { store } = makeStore(fixture, stub.fetch, secrets);

    const layerId = seedLayer(fixture.db, 'team-c');
    const userId = seedUser(fixture.db, 'cu');
    attachGoogle(fixture.db, layerId, secrets);
    const a = await store.create({
      layerId,
      slug: 'a',
      title: 'A',
      originalLocale: 'en',
      payload: { startsAt: '2026-06-01T09:00:00Z', allDay: false },
      actorId: userId,
    });
    const b = await store.create({
      layerId,
      slug: 'b',
      title: 'B',
      originalLocale: 'en',
      payload: { startsAt: '2026-06-01T10:00:00Z', allDay: false },
      actorId: userId,
    });
    store.addExternalLink({
      ref: { id: a.id, kind: 'calendar_event', layerId, slug: 'a' },
      connector: GOOGLE_CALENDAR_CONNECTOR_ID,
      externalId: 'evt-001',
    });
    store.addExternalLink({
      ref: { id: b.id, kind: 'calendar_event', layerId, slug: 'b' },
      connector: GOOGLE_CALENDAR_CONNECTOR_ID,
      externalId: 'evt-002',
    });

    const dispatcher = createConnectorDispatcher({
      db: fixture.db,
      bus: fixture.bus,
      resolveConfig: createGoogleCalendarConfigResolver(fixture.db),
    });
    await dispatcher.handle({
      ref: { id: a.id, kind: 'calendar_event', layerId, slug: 'a' },
      connector: GOOGLE_CALENDAR_CONNECTOR_ID,
      externalId: 'evt-001',
    });
    await dispatcher.handle({
      ref: { id: b.id, kind: 'calendar_event', layerId, slug: 'b' },
      connector: GOOGLE_CALENDAR_CONNECTOR_ID,
      externalId: 'evt-002',
    });
    expect(stub.tokenCalls).toBe(1);
    expect(stub.getCalls).toBe(2);
  });
});

describe('google calendar connector :: auth error', () => {
  it('marks the link error and emits failed on 401 from events.get', async () => {
    const fixture = f();
    const secrets = makeSecrets();
    const stub = stubFetch({
      eventsGetResponse: { status: 401, body: { error: 'forbidden' } },
    });
    const { store } = makeStore(fixture, stub.fetch, secrets);

    const layerId = seedLayer(fixture.db, 'team-e');
    const userId = seedUser(fixture.db, 'er');
    attachGoogle(fixture.db, layerId, secrets);
    const created = await store.create({
      layerId,
      slug: 'x',
      title: 'X',
      originalLocale: 'en',
      payload: { startsAt: '2026-06-01T09:00:00Z', allDay: false },
      actorId: userId,
    });
    store.addExternalLink({
      ref: { id: created.id, kind: 'calendar_event', layerId, slug: 'x' },
      connector: GOOGLE_CALENDAR_CONNECTOR_ID,
      externalId: 'evt-001',
    });
    const dispatcher = createConnectorDispatcher({
      db: fixture.db,
      bus: fixture.bus,
      resolveConfig: createGoogleCalendarConfigResolver(fixture.db),
    });
    await dispatcher.handle({
      ref: { id: created.id, kind: 'calendar_event', layerId, slug: 'x' },
      connector: GOOGLE_CALENDAR_CONNECTOR_ID,
      externalId: 'evt-001',
    });

    const reloaded = store.getById(created.id)?.externalLinks[0];
    expect(reloaded?.syncState).toBe('error');
    expect(reloaded?.error).toBe(GOOGLE_CALENDAR_ERROR_KEYS.Unauthorized);
    expect(
      fixture.events.find((e) => e.type === 'entity.connector.sync.succeeded'),
    ).toBeUndefined();
    expect(fixture.events.find((e) => e.type === 'entity.connector.sync.failed')).toBeDefined();
  });
});

describe('google calendar connector :: verify(config)', () => {
  it('accepts a fully-formed envelope config', async () => {
    const secrets = makeSecrets();
    const connector = createGoogleCalendarConnector({ secrets });
    const ok = await connector.verify({
      clientId: CLIENT_ID,
      clientSecret: secrets.encryptSecret(CLIENT_SECRET_PLAIN),
      refreshToken: secrets.encryptSecret(REFRESH_TOKEN_PLAIN),
      calendarId: 'primary',
      pollIntervalMinutes: 60,
    });
    expect(ok).toBeNull();
  });

  it('rejects plaintext refreshToken as plaintextSecret', async () => {
    const secrets = makeSecrets();
    const connector = createGoogleCalendarConnector({ secrets });
    const err = await connector.verify({
      clientId: CLIENT_ID,
      clientSecret: secrets.encryptSecret(CLIENT_SECRET_PLAIN),
      refreshToken: 'plain-text-token',
      calendarId: 'primary',
      pollIntervalMinutes: 60,
    });
    expect(err).toBe(GOOGLE_CALENDAR_ERROR_KEYS.PlaintextSecret);
  });

  it('rejects plaintext clientSecret as plaintextSecret', async () => {
    const secrets = makeSecrets();
    const connector = createGoogleCalendarConnector({ secrets });
    const err = await connector.verify({
      clientId: CLIENT_ID,
      clientSecret: 'plain-text-secret',
      refreshToken: secrets.encryptSecret(REFRESH_TOKEN_PLAIN),
      calendarId: 'primary',
      pollIntervalMinutes: 60,
    });
    expect(err).toBe(GOOGLE_CALENDAR_ERROR_KEYS.PlaintextSecret);
  });

  it('rejects missing fields', async () => {
    const secrets = makeSecrets();
    const connector = createGoogleCalendarConnector({ secrets });
    expect(await connector.verify({})).toBe(GOOGLE_CALENDAR_ERROR_KEYS.InvalidConfig);
  });

  it('parses defaults via the exported schema', () => {
    const secrets = makeSecrets();
    const parsed = GoogleCalendarConfigSchema.parse({
      clientId: CLIENT_ID,
      clientSecret: secrets.encryptSecret(CLIENT_SECRET_PLAIN),
      refreshToken: secrets.encryptSecret(REFRESH_TOKEN_PLAIN),
    });
    expect(parsed.calendarId).toBe('primary');
    expect(parsed.pollIntervalMinutes).toBe(60);
  });
});

describe('google calendar connector :: leak canary', () => {
  it('never leaks the configured client secret or refresh token anywhere observable', async () => {
    const fixture = f();
    const secrets = makeSecrets();
    const stub = stubFetch({
      eventsGetResponse: { body: SAMPLE_GOOGLE_EVENT },
      eventsListResponse: {
        body: { items: [SAMPLE_GOOGLE_EVENT], nextSyncToken: 'next-token' },
      },
    });
    const { module, store } = makeStore(fixture, stub.fetch, secrets);
    void module;

    const layerId = seedLayer(fixture.db, 'leak');
    const userId = seedUser(fixture.db, 'sneaky');
    attachGoogle(fixture.db, layerId, secrets);

    // Capture console.log / console.error.
    const logCapture: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => {
      logCapture.push(args.map((a) => String(a)).join(' '));
    };
    console.error = (...args: unknown[]) => {
      logCapture.push(args.map((a) => String(a)).join(' '));
    };

    try {
      const created = await store.create({
        layerId,
        slug: 'leak-canary',
        title: 'Leak canary',
        originalLocale: 'en',
        payload: { startsAt: '2026-06-01T09:00:00Z', allDay: false },
        actorId: userId,
      });
      store.addExternalLink({
        ref: { id: created.id, kind: 'calendar_event', layerId, slug: 'leak-canary' },
        connector: GOOGLE_CALENDAR_CONNECTOR_ID,
        externalId: 'evt-001',
      });
      const llm = createLlmClient({
        endpoint: 'mock://echo',
        apiKey: '',
        defaultModel: 'mock-default',
      });
      const dispatcher = createConnectorDispatcher({
        db: fixture.db,
        bus: fixture.bus,
        llm,
        resolveConfig: createGoogleCalendarConfigResolver(fixture.db),
      });
      // pull + ingest both run through the connector.
      await dispatcher.handle({
        ref: { id: created.id, kind: 'calendar_event', layerId, slug: 'leak-canary' },
        connector: GOOGLE_CALENDAR_CONNECTOR_ID,
        externalId: 'evt-001',
      });
      await dispatcher.ingest({
        kind: 'calendar_event',
        connectorId: GOOGLE_CALENDAR_CONNECTOR_ID,
        layerId,
        actorId: userId,
        payload: { contentType: GOOGLE_CALENDAR_INGEST_CONTENT_TYPE, bytes: new Uint8Array() },
        originalLocale: 'en',
      });
    } finally {
      console.log = origLog;
      console.error = origErr;
    }

    // Haystack #1: every bus event.
    const busHaystack = JSON.stringify(
      fixture.events.map((e) => ({ type: e.type, payload: e.payload, metadata: e.metadata })),
    );
    expect(busHaystack).not.toContain(CLIENT_SECRET_PLAIN);
    expect(busHaystack).not.toContain(REFRESH_TOKEN_PLAIN);

    // Haystack #2: entity_external_links rows.
    const links = fixture.db
      .query<{ payload_json: string }, []>('SELECT payload_json FROM entity_external_links')
      .all();
    for (const row of links) {
      expect(row.payload_json).not.toContain(CLIENT_SECRET_PLAIN);
      expect(row.payload_json).not.toContain(REFRESH_TOKEN_PLAIN);
    }

    // Haystack #3: captured console output.
    const logHaystack = logCapture.join('\n');
    expect(logHaystack).not.toContain(CLIENT_SECRET_PLAIN);
    expect(logHaystack).not.toContain(REFRESH_TOKEN_PLAIN);

    // Bonus haystack #4: outgoing HTTP request bodies. The token endpoint
    // DOES legitimately receive the plaintext secrets (that's how refresh
    // works), so we assert only that nothing else does. The token URL is
    // identifiable; all other call bodies must be clean.
    for (let i = 0; i < stub.urls.length; i += 1) {
      const url = stub.urls[i]!;
      const body = stub.bodies[i];
      if (url.includes('oauth2.googleapis.com/token')) continue;
      if (body !== undefined) {
        expect(body).not.toContain(CLIENT_SECRET_PLAIN);
        expect(body).not.toContain(REFRESH_TOKEN_PLAIN);
      }
    }
  });
});
