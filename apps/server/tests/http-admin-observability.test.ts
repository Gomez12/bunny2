/**
 * Phase 2 of `docs/dev/plans/admin-observability-viewer.md` —
 * `/admin/observability/events` read-only viewer.
 *
 * Covers:
 *   - admin lists events with cursor pagination + filter parsing.
 *   - non-admin gets 403 (`/admin/*` `requireAdmin` gate).
 *   - cursor stability: a row inserted BETWEEN page calls neither
 *     duplicates nor skips a previously-paginated row.
 *   - entry log + telemetry event names emitted with stable shape.
 *   - filter-parser unit tests: cursor encode/decode round-trip,
 *     invalid input rejected, LIKE-escape behavior.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { makeTestAppSeeded, type TestApp } from './_helpers/app';
import { loginSeededAdminRotated, seedNonAdminUser } from './_helpers/auth';
import { writeEventRow } from '../src/bus/event-log';
import {
  encodeCursor,
  parseCursor,
  parseEventsQuery,
} from '../src/http/routes/admin-observability';

let fx: TestApp | null = null;

afterEach(() => {
  if (fx !== null) {
    fx.cleanup();
    fx = null;
  }
});

interface EventsBody {
  readonly rows: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly occurredAt: string;
    readonly correlationId: string | null;
    readonly flowId: string | null;
    readonly payload: string;
    readonly metadata: string | null;
  }>;
  readonly nextCursor: string | null;
}

function seedEvent(
  fixture: TestApp,
  idx: number,
  overrides: { type?: string; occurredAt?: string; metadata?: Record<string, unknown> } = {},
): void {
  const occurredAt =
    overrides.occurredAt ?? new Date(Date.UTC(2026, 4, 25, 14, 0, idx)).toISOString();
  const metadata = overrides.metadata ?? null;
  writeEventRow(fixture.db, {
    id: `ev-${String(idx).padStart(3, '0')}`,
    type: overrides.type ?? 'test.event',
    occurredAt,
    payload: { idx },
    ...(metadata === null ? {} : { metadata }),
  });
}

describe('parseEventsQuery (unit)', () => {
  it('parses an empty query into a no-filter request with the default limit', () => {
    const r = parseEventsQuery({});
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.filter.kindPrefix).toBe(null);
    expect(r.filter.from).toBe(null);
    expect(r.filter.to).toBe(null);
    expect(r.filter.layerId).toBe(null);
    expect(r.filter.flowId).toBe(null);
    expect(r.filter.correlationId).toBe(null);
    expect(r.filter.limit).toBe(50);
    expect(r.filter.cursor).toBe(null);
  });

  it('caps an over-large limit at 200', () => {
    const r = parseEventsQuery({ limit: '10000' });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.filter.limit).toBe(200);
  });

  it('normalizes ISO timestamp filters', () => {
    const r = parseEventsQuery({
      from: '2026-05-25T00:00:00Z',
      to: '2026-05-25T23:59:59Z',
    });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.filter.from).toBe('2026-05-25T00:00:00.000Z');
    expect(r.filter.to).toBe('2026-05-25T23:59:59.000Z');
  });

  it('rejects an invalid timestamp with errors.admin.observability.invalidTimestamp', () => {
    const r = parseEventsQuery({ from: 'not-a-date' });
    if (r.kind !== 'error') throw new Error('expected error');
    expect(r.errorKey).toBe('errors.admin.observability.invalidTimestamp');
  });

  it('rejects an invalid cursor with errors.admin.observability.invalidCursor', () => {
    const r = parseEventsQuery({ cursor: 'definitely-not-base64-json' });
    if (r.kind !== 'error') throw new Error('expected error');
    expect(r.errorKey).toBe('errors.admin.observability.invalidCursor');
  });

  it('round-trips a cursor through encodeCursor / parseCursor', () => {
    const original = { ts: '2026-05-25T14:00:00.000Z', id: 'ev-042' };
    const encoded = encodeCursor(original);
    const decoded = parseCursor(encoded);
    if (decoded === null || decoded === 'invalid') {
      throw new Error('expected a cursor');
    }
    expect(decoded.ts).toBe(original.ts);
    expect(decoded.id).toBe(original.id);
  });
});

describe('GET /admin/observability/events', () => {
  it('lists events newest-first with a stable cursor', async () => {
    fx = await makeTestAppSeeded('bunny2-admin-obs-list-');
    const { token: adminToken } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    // Seed 5 events under a unique kind so we can isolate them from
    // any incidental rows the admin / layer seed published.
    for (let i = 1; i <= 5; i += 1) seedEvent(fx, i, { type: 'list.fixture' });

    const res = await fx.app.fetch(
      new Request('http://localhost/admin/observability/events?limit=3&kind=list.fixture', {
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as EventsBody;
    // Newest first — ev-005 occurred latest.
    expect(body.rows.map((r) => r.id)).toEqual(['ev-005', 'ev-004', 'ev-003']);
    // A page that asked for 3 should yield a nextCursor.
    expect(body.nextCursor).not.toBe(null);
  });

  it('paginates a stable cursor across a concurrent insert', async () => {
    fx = await makeTestAppSeeded('bunny2-admin-obs-cursor-');
    const { token: adminToken } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    // Six rows so a limit=3 page leaves a clean second page.
    for (let i = 1; i <= 6; i += 1) seedEvent(fx, i, { type: 'cursor.fixture' });

    // First page — newest 3 (ev-006, ev-005, ev-004).
    const page1Res = await fx.app.fetch(
      new Request('http://localhost/admin/observability/events?limit=3&kind=cursor.fixture', {
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as EventsBody;
    const ids1 = page1.rows.map((r) => r.id);
    expect(ids1).toEqual(['ev-006', 'ev-005', 'ev-004']);
    expect(page1.nextCursor).not.toBe(null);

    // Concurrent insert: a NEW row lands AFTER ev-006 (later
    // occurred_at). The follow-up page must NOT include it (the
    // cursor names ev-004 as the boundary) and must not skip
    // anything either.
    seedEvent(fx, 99, {
      type: 'cursor.fixture',
      // Future-dated so its occurred_at sorts ABOVE ev-006.
      occurredAt: new Date(Date.UTC(2026, 4, 25, 15, 0, 0)).toISOString(),
    });

    const cursor = page1.nextCursor;
    if (cursor === null) throw new Error('expected a cursor');
    const page2Res = await fx.app.fetch(
      new Request(
        `http://localhost/admin/observability/events?limit=3&kind=cursor.fixture&cursor=${encodeURIComponent(cursor)}`,
        { headers: { authorization: `Bearer ${adminToken}` } },
      ),
    );
    expect(page2Res.status).toBe(200);
    const page2 = (await page2Res.json()) as EventsBody;
    const ids2 = page2.rows.map((r) => r.id);
    expect(ids2).toEqual(['ev-003', 'ev-002', 'ev-001']);

    // No overlap, no skip.
    const overlap = ids1.filter((id) => ids2.includes(id));
    expect(overlap).toEqual([]);
    expect(ids2).not.toContain('ev-099');
  });

  it('filters by a LIKE kind prefix without honoring SQL wildcards in user input', async () => {
    fx = await makeTestAppSeeded('bunny2-admin-obs-filter-');
    const { token: adminToken } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    seedEvent(fx, 1, { type: 'chat.message.done' });
    seedEvent(fx, 2, { type: 'chat.step.started' });
    seedEvent(fx, 3, { type: 'bus.dlq.added' });

    // Prefix `chat.` should match the first two but not the third.
    const res = await fx.app.fetch(
      new Request('http://localhost/admin/observability/events?kind=chat.', {
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    );
    const body = (await res.json()) as EventsBody;
    const types = body.rows.map((r) => r.type);
    expect(types).toContain('chat.message.done');
    expect(types).toContain('chat.step.started');
    expect(types).not.toContain('bus.dlq.added');

    // A wildcard char in the input should be treated as a literal —
    // searching for `chat.%` should match neither of our rows because
    // none of the types contain a literal `%`.
    const wildcardRes = await fx.app.fetch(
      new Request(
        'http://localhost/admin/observability/events?kind=' + encodeURIComponent('chat.%'),
        {
          headers: { authorization: `Bearer ${adminToken}` },
        },
      ),
    );
    const wildcardBody = (await wildcardRes.json()) as EventsBody;
    const wildcardTypes = wildcardBody.rows.map((r) => r.type);
    expect(wildcardTypes).not.toContain('chat.message.done');
    expect(wildcardTypes).not.toContain('chat.step.started');
  });

  it('forbids non-admin callers with errors.admin.forbidden', async () => {
    fx = await makeTestAppSeeded('bunny2-admin-obs-forbid-');
    // Rotate the admin so the non-admin path is clean.
    await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const nonAdmin = await seedNonAdminUser({ db: fx.db, app: fx.app }, { username: 'bob' });

    const res = await fx.app.fetch(
      new Request('http://localhost/admin/observability/events', {
        headers: { authorization: `Bearer ${nonAdmin.token}` },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.admin.forbidden');
  });

  it('emits the admin.observability.events.query log + telemetry event', async () => {
    fx = await makeTestAppSeeded('bunny2-admin-obs-tel-');
    const { token: adminToken } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    seedEvent(fx, 1, { type: 'telemetry.fixture' });

    // Capture console.log.
    const logCapture: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logCapture.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };

    // Subscribe to the telemetry event so we can assert its shape.
    type TelPayload = {
      readonly durationMs: number;
      readonly rowCount: number;
      readonly filterKeys: readonly string[];
    };
    const seenTelemetry: TelPayload[] = [];
    fx.bus.subscribe<TelPayload>('admin.observability.events.query', async (ev) => {
      seenTelemetry.push(ev.payload);
    });

    try {
      const res = await fx.app.fetch(
        new Request('http://localhost/admin/observability/events?kind=telemetry.fixture', {
          headers: { authorization: `Bearer ${adminToken}` },
        }),
      );
      expect(res.status).toBe(200);
    } finally {
      console.log = origLog;
    }

    // Entry log present.
    const entry = logCapture.find((l) => l.includes('admin.observability.events.query'));
    expect(entry).toBeDefined();

    // Telemetry event published with the expected shape.
    expect(seenTelemetry.length).toBeGreaterThan(0);
    const last = seenTelemetry[seenTelemetry.length - 1];
    if (last === undefined) throw new Error('expected telemetry payload');
    expect(typeof last.durationMs).toBe('number');
    expect(typeof last.rowCount).toBe('number');
    expect(Array.isArray(last.filterKeys)).toBe(true);
    expect(last.filterKeys).toContain('kind');
  });
});
