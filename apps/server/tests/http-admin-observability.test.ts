/**
 * Phase 2 + 3 of `docs/dev/plans/admin-observability-viewer.md` —
 * `/admin/observability/*` read-only viewers.
 *
 * Phase 2 covers (`/events`):
 *   - admin lists events with cursor pagination + filter parsing.
 *   - non-admin gets 403 (`/admin/*` `requireAdmin` gate).
 *   - cursor stability: a row inserted BETWEEN page calls neither
 *     duplicates nor skips a previously-paginated row.
 *   - entry log + telemetry event names emitted with stable shape.
 *   - filter-parser unit tests: cursor encode/decode round-trip,
 *     invalid input rejected, LIKE-escape behavior.
 *
 * Phase 3 covers (`/llm-calls` + `/llm-calls/:id` + `/llm-calls/rollups`):
 *   - filter parser unit: numeric coercion + invalid input rejected.
 *   - list: rows shaped per the redaction-audit (no request/response).
 *   - cursor stable under concurrent insert.
 *   - detail: 200 for admin; 404 for missing; > 200 KB request payload
 *     truncates with the explicit marker + sets `requestTruncated`.
 *   - rollups: synthetic rows yield the expected count / cost / p50 /
 *     p95 / error rate.
 *   - non-admin → 403; entry log + telemetry events emitted on every
 *     handler.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { makeTestAppSeeded, type TestApp } from './_helpers/app';
import { loginSeededAdminRotated, seedNonAdminUser } from './_helpers/auth';
import { writeEventRow } from '../src/bus/event-log';
import { createSqliteLlmCallLog } from '../src/llm/call-log';
import {
  encodeCursor,
  parseCursor,
  parseEventsQuery,
  parseLlmCallsQuery,
  encodeLlmCallsCursor,
  parseLlmCallsCursor,
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

  // ======================================================================
  // Phase 3 — LLM calls viewer
  // ======================================================================

  /* helpers --------------------------------------------------------------- */

  interface LlmCallSeed {
    readonly id: string;
    readonly startedAt?: string;
    readonly model?: string;
    readonly endpoint?: string;
    readonly request?: string;
    readonly response?: string | null;
    readonly tokensIn?: number | null;
    readonly tokensOut?: number | null;
    readonly costUsd?: number | null;
    readonly latencyMs?: number | null;
    readonly correlationId?: string | null;
    readonly flowId?: string | null;
    readonly layerId?: string | null;
    readonly userId?: string | null;
    readonly error?: string | null;
  }

  function seedLlmCall(fixture: TestApp, seed: LlmCallSeed): void {
    const log = createSqliteLlmCallLog(fixture.db);
    log.write({
      id: seed.id,
      startedAt: seed.startedAt ?? new Date(Date.UTC(2026, 4, 25, 14, 0, 0)).toISOString(),
      endedAt: null,
      model: seed.model ?? 'mock-default',
      endpoint: seed.endpoint ?? 'mock://echo',
      request: seed.request ?? '{"messages":[]}',
      response: seed.response === undefined ? '{"content":""}' : seed.response,
      tokensIn: seed.tokensIn === undefined ? 10 : seed.tokensIn,
      tokensOut: seed.tokensOut === undefined ? 5 : seed.tokensOut,
      costUsd: seed.costUsd === undefined ? 0.001 : seed.costUsd,
      latencyMs: seed.latencyMs === undefined ? 100 : seed.latencyMs,
      correlationId: seed.correlationId === undefined ? null : seed.correlationId,
      flowId: seed.flowId === undefined ? null : seed.flowId,
      layerId: seed.layerId === undefined ? null : seed.layerId,
      userId: seed.userId === undefined ? null : seed.userId,
      error: seed.error === undefined ? null : seed.error,
      modelSource: 'system',
    });
  }

  /* parser unit ----------------------------------------------------------- */

  describe('parseLlmCallsQuery (unit)', () => {
    it('coerces numeric filters to finite non-negative numbers', () => {
      const r = parseLlmCallsQuery({ costMin: '0.5', latencyMaxMs: '1200' });
      if (r.kind !== 'ok') throw new Error('expected ok');
      expect(r.filter.costMin).toBe(0.5);
      expect(r.filter.latencyMaxMs).toBe(1200);
    });

    it('rejects a non-numeric costMin with errors.admin.observability.invalidNumber', () => {
      const r = parseLlmCallsQuery({ costMin: 'abc' });
      if (r.kind !== 'error') throw new Error('expected error');
      expect(r.errorKey).toBe('errors.admin.observability.invalidNumber');
    });

    it('rejects a negative latencyMaxMs with errors.admin.observability.invalidNumber', () => {
      const r = parseLlmCallsQuery({ latencyMaxMs: '-1' });
      if (r.kind !== 'error') throw new Error('expected error');
      expect(r.errorKey).toBe('errors.admin.observability.invalidNumber');
    });

    it('rejects an unknown status with errors.admin.observability.invalidStatus', () => {
      const r = parseLlmCallsQuery({ status: 'maybe' });
      if (r.kind !== 'error') throw new Error('expected error');
      expect(r.errorKey).toBe('errors.admin.observability.invalidStatus');
    });

    it('round-trips a cursor through encodeLlmCallsCursor / parseLlmCallsCursor', () => {
      const original = { ts: '2026-05-25T14:00:00.000Z', id: 'llm-042' };
      const encoded = encodeLlmCallsCursor(original);
      const decoded = parseLlmCallsCursor(encoded);
      if (decoded === null || decoded === 'invalid') throw new Error('expected a cursor');
      expect(decoded.ts).toBe(original.ts);
      expect(decoded.id).toBe(original.id);
    });
  });

  /* list endpoint --------------------------------------------------------- */

  describe('GET /admin/observability/llm-calls', () => {
    interface LlmCallsListBody {
      readonly rows: ReadonlyArray<{
        readonly id: string;
        readonly startedAt: string;
        readonly model: string;
        readonly tokensIn: number | null;
        readonly errorPreview: string | null;
        readonly hasError: boolean;
      }>;
      readonly nextCursor: string | null;
    }

    it('lists LLM calls newest-first and excludes request/response from the list rows', async () => {
      fx = await makeTestAppSeeded('bunny2-admin-llm-list-');
      const { token } = await loginSeededAdminRotated({
        db: fx.db,
        bus: fx.bus,
        app: fx.app,
        seedLog: fx.seedLog,
      });
      for (let i = 1; i <= 5; i += 1) {
        seedLlmCall(fx, {
          id: `llm-${String(i).padStart(3, '0')}`,
          startedAt: new Date(Date.UTC(2026, 4, 25, 14, 0, i)).toISOString(),
          model: 'claude-3-5-sonnet',
        });
      }
      const res = await fx.app.fetch(
        new Request('http://localhost/admin/observability/llm-calls?limit=3', {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as LlmCallsListBody;
      expect(body.rows.map((r) => r.id)).toEqual(['llm-005', 'llm-004', 'llm-003']);
      expect(body.nextCursor).not.toBe(null);
      // List rows must NOT carry `request` / `response`.
      const first = body.rows[0] as unknown as Record<string, unknown>;
      expect('request' in first).toBe(false);
      expect('response' in first).toBe(false);
    });

    it('filters by status (ok / err) using error IS [NOT] NULL', async () => {
      fx = await makeTestAppSeeded('bunny2-admin-llm-status-');
      const { token } = await loginSeededAdminRotated({
        db: fx.db,
        bus: fx.bus,
        app: fx.app,
        seedLog: fx.seedLog,
      });
      seedLlmCall(fx, { id: 'ok-1', error: null });
      seedLlmCall(fx, { id: 'err-1', error: 'kaboom' });
      const okRes = await fx.app.fetch(
        new Request('http://localhost/admin/observability/llm-calls?status=ok', {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      const okBody = (await okRes.json()) as LlmCallsListBody;
      expect(okBody.rows.map((r) => r.id)).toContain('ok-1');
      expect(okBody.rows.map((r) => r.id)).not.toContain('err-1');
      const errRes = await fx.app.fetch(
        new Request('http://localhost/admin/observability/llm-calls?status=err', {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      const errBody = (await errRes.json()) as LlmCallsListBody;
      expect(errBody.rows.map((r) => r.id)).toContain('err-1');
      expect(errBody.rows.map((r) => r.id)).not.toContain('ok-1');
      const errRow = errBody.rows.find((r) => r.id === 'err-1');
      expect(errRow?.hasError).toBe(true);
      expect(errRow?.errorPreview).toBe('kaboom');
    });

    it('paginates with a cursor stable across a concurrent insert', async () => {
      fx = await makeTestAppSeeded('bunny2-admin-llm-cursor-');
      const { token } = await loginSeededAdminRotated({
        db: fx.db,
        bus: fx.bus,
        app: fx.app,
        seedLog: fx.seedLog,
      });
      for (let i = 1; i <= 6; i += 1) {
        seedLlmCall(fx, {
          id: `llm-${String(i).padStart(3, '0')}`,
          startedAt: new Date(Date.UTC(2026, 4, 25, 14, 0, i)).toISOString(),
          model: 'cursor-fixture',
        });
      }
      const page1Res = await fx.app.fetch(
        new Request('http://localhost/admin/observability/llm-calls?limit=3&model=cursor-fixture', {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      const page1 = (await page1Res.json()) as LlmCallsListBody;
      expect(page1.rows.map((r) => r.id)).toEqual(['llm-006', 'llm-005', 'llm-004']);
      // Insert a row dated AFTER llm-006 between page calls — it must
      // not bleed into page 2.
      seedLlmCall(fx, {
        id: 'llm-099',
        startedAt: new Date(Date.UTC(2026, 4, 25, 15, 0, 0)).toISOString(),
        model: 'cursor-fixture',
      });
      const cursor = page1.nextCursor;
      if (cursor === null) throw new Error('expected a cursor');
      const page2Res = await fx.app.fetch(
        new Request(
          `http://localhost/admin/observability/llm-calls?limit=3&model=cursor-fixture&cursor=${encodeURIComponent(cursor)}`,
          { headers: { authorization: `Bearer ${token}` } },
        ),
      );
      const page2 = (await page2Res.json()) as LlmCallsListBody;
      expect(page2.rows.map((r) => r.id)).toEqual(['llm-003', 'llm-002', 'llm-001']);
      expect(page2.rows.map((r) => r.id)).not.toContain('llm-099');
    });

    it('forbids non-admin callers with errors.admin.forbidden', async () => {
      fx = await makeTestAppSeeded('bunny2-admin-llm-forbid-');
      await loginSeededAdminRotated({
        db: fx.db,
        bus: fx.bus,
        app: fx.app,
        seedLog: fx.seedLog,
      });
      const nonAdmin = await seedNonAdminUser({ db: fx.db, app: fx.app }, { username: 'mallory' });
      const res = await fx.app.fetch(
        new Request('http://localhost/admin/observability/llm-calls', {
          headers: { authorization: `Bearer ${nonAdmin.token}` },
        }),
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('errors.admin.forbidden');
    });

    it('emits the admin.observability.llm-calls.query log + telemetry event', async () => {
      fx = await makeTestAppSeeded('bunny2-admin-llm-tel-');
      const { token } = await loginSeededAdminRotated({
        db: fx.db,
        bus: fx.bus,
        app: fx.app,
        seedLog: fx.seedLog,
      });
      seedLlmCall(fx, { id: 'tel-1', model: 'tel-model' });
      const logCapture: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => {
        logCapture.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      };
      interface TelPayload {
        readonly durationMs: number;
        readonly rowCount: number;
        readonly filterKeys: readonly string[];
      }
      const seenTelemetry: TelPayload[] = [];
      fx.bus.subscribe<TelPayload>('admin.observability.llm-calls.query', async (ev) => {
        seenTelemetry.push(ev.payload);
      });
      try {
        const res = await fx.app.fetch(
          new Request('http://localhost/admin/observability/llm-calls?model=tel-model', {
            headers: { authorization: `Bearer ${token}` },
          }),
        );
        expect(res.status).toBe(200);
      } finally {
        console.log = origLog;
      }
      const entry = logCapture.find((l) => l.includes('admin.observability.llm-calls.query'));
      expect(entry).toBeDefined();
      expect(seenTelemetry.length).toBeGreaterThan(0);
      const last = seenTelemetry[seenTelemetry.length - 1];
      if (last === undefined) throw new Error('expected telemetry payload');
      expect(typeof last.durationMs).toBe('number');
      expect(last.filterKeys).toContain('model');
    });
  });

  /* detail endpoint ------------------------------------------------------- */

  describe('GET /admin/observability/llm-calls/:id', () => {
    interface LlmCallDetailBody {
      readonly id: string;
      readonly request: string;
      readonly requestTruncated: boolean;
      readonly requestOriginalBytes: number;
      readonly response: string | null;
      readonly responseTruncated: boolean;
      readonly error: string | null;
      readonly linkedEvents: ReadonlyArray<{ readonly id: string; readonly type: string }>;
    }

    it('returns the full row including request/response and joined events', async () => {
      fx = await makeTestAppSeeded('bunny2-admin-llm-detail-');
      const { token } = await loginSeededAdminRotated({
        db: fx.db,
        bus: fx.bus,
        app: fx.app,
        seedLog: fx.seedLog,
      });
      seedLlmCall(fx, {
        id: 'detail-1',
        correlationId: 'c-detail',
        request: '{"messages":[{"role":"user","content":"hi"}]}',
        response: '{"content":"hello"}',
      });
      writeEventRow(fx.db, {
        id: 'ev-detail',
        type: 'chat.message.done',
        occurredAt: new Date(Date.UTC(2026, 4, 25, 14, 0, 10)).toISOString(),
        correlationId: 'c-detail',
        payload: { ok: true },
      });
      const res = await fx.app.fetch(
        new Request('http://localhost/admin/observability/llm-calls/detail-1', {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as LlmCallDetailBody;
      expect(body.id).toBe('detail-1');
      expect(body.request).toContain('"role":"user"');
      expect(body.requestTruncated).toBe(false);
      expect(body.linkedEvents.map((e) => e.id)).toContain('ev-detail');
    });

    it('returns 404 errors.admin.observability.notFound for a missing id', async () => {
      fx = await makeTestAppSeeded('bunny2-admin-llm-404-');
      const { token } = await loginSeededAdminRotated({
        db: fx.db,
        bus: fx.bus,
        app: fx.app,
        seedLog: fx.seedLog,
      });
      const res = await fx.app.fetch(
        new Request('http://localhost/admin/observability/llm-calls/does-not-exist', {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('errors.admin.observability.notFound');
    });

    it('truncates a > 200 KB request payload with the explicit marker', async () => {
      fx = await makeTestAppSeeded('bunny2-admin-llm-trunc-');
      const { token } = await loginSeededAdminRotated({
        db: fx.db,
        bus: fx.bus,
        app: fx.app,
        seedLog: fx.seedLog,
      });
      const bigPayload = `{"messages":"${'x'.repeat(250 * 1024)}"}`;
      seedLlmCall(fx, { id: 'trunc-1', request: bigPayload });
      const res = await fx.app.fetch(
        new Request('http://localhost/admin/observability/llm-calls/trunc-1', {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as LlmCallDetailBody;
      expect(body.requestTruncated).toBe(true);
      expect(body.requestOriginalBytes).toBeGreaterThan(200 * 1024);
      expect(body.request).toContain('[truncated; full payload available via API]');
      // Result string is on the order of the 200 KB cap + marker; not
      // the full 250 KB.
      expect(body.request.length).toBeLessThan(bigPayload.length);
    });
  });

  /* rollups endpoint ------------------------------------------------------ */

  describe('GET /admin/observability/llm-calls/rollups', () => {
    interface RollupsBody {
      readonly window24h: {
        readonly count: number;
        readonly errorCount: number;
        readonly errorRate: number;
        readonly totalCostUsd: number;
        readonly p50LatencyMs: number | null;
        readonly p95LatencyMs: number | null;
      };
      readonly window7d: RollupsBody['window24h'];
    }

    it('computes count / cost / p50 / p95 / error rate over the rolling window', async () => {
      fx = await makeTestAppSeeded('bunny2-admin-llm-roll-');
      const { token } = await loginSeededAdminRotated({
        db: fx.db,
        bus: fx.bus,
        app: fx.app,
        seedLog: fx.seedLog,
      });
      // Seed 10 calls in the last hour with known latencies + costs.
      const nowIso = new Date().toISOString();
      const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      for (let i = 0; i < 10; i += 1) {
        seedLlmCall(fx, {
          id: `roll-${String(i).padStart(3, '0')}`,
          startedAt: nowIso,
          latencyMs: latencies[i] ?? 0,
          costUsd: 0.01,
          error: i === 9 ? 'oops' : null,
        });
      }
      const res = await fx.app.fetch(
        new Request('http://localhost/admin/observability/llm-calls/rollups', {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as RollupsBody;
      expect(body.window24h.count).toBe(10);
      expect(body.window24h.errorCount).toBe(1);
      expect(body.window24h.errorRate).toBeCloseTo(0.1, 5);
      expect(body.window24h.totalCostUsd).toBeCloseTo(0.1, 5);
      // p50: floor(10 * 0.5) = 5 → 6th smallest (0-indexed offset 5) = 60.
      expect(body.window24h.p50LatencyMs).toBe(60);
      // p95: floor(10 * 0.95) = 9 → 10th smallest = 100.
      expect(body.window24h.p95LatencyMs).toBe(100);
    });

    it('emits the admin.observability.llm-calls.rollups telemetry event', async () => {
      fx = await makeTestAppSeeded('bunny2-admin-llm-roll-tel-');
      const { token } = await loginSeededAdminRotated({
        db: fx.db,
        bus: fx.bus,
        app: fx.app,
        seedLog: fx.seedLog,
      });
      interface TelPayload {
        readonly durationMs: number;
        readonly count24h: number;
        readonly count7d: number;
      }
      const seenTelemetry: TelPayload[] = [];
      fx.bus.subscribe<TelPayload>('admin.observability.llm-calls.rollups', async (ev) => {
        seenTelemetry.push(ev.payload);
      });
      const res = await fx.app.fetch(
        new Request('http://localhost/admin/observability/llm-calls/rollups', {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      expect(seenTelemetry.length).toBeGreaterThan(0);
      const last = seenTelemetry[seenTelemetry.length - 1];
      if (last === undefined) throw new Error('expected telemetry payload');
      expect(typeof last.durationMs).toBe('number');
      expect(typeof last.count24h).toBe('number');
      expect(typeof last.count7d).toBe('number');
    });
  });

  // ======================================================================
  // (Phase 2 telemetry test continues below)
  // ======================================================================

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
