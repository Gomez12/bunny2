/**
 * Admin-observability plan §5 phase 5 — `/admin/bus/outbox` ledger
 * expansion.
 *
 * Read-only viewer over the durable `bus_outbox` table (migration
 * 0013). The existing `AdminBusDlqPage` already covered DLQ-only
 * rows; this endpoint expands that surface so admins can browse
 * pending / in_flight / delivered / dead / abandoned rows too.
 *
 * Covers:
 *   - filter parser unit (status whitelist, cursor round-trip).
 *   - admin lists outbox rows newest-first with a cursor.
 *   - `status=delivered` filter surfaces delivered rows separately
 *     from rows in other statuses.
 *   - cursor is stable under a concurrent insert.
 *   - detail endpoint truncates a > 200 KB payload with the explicit
 *     R3 marker and sets `payloadTruncated`.
 *   - non-admin → 403.
 *   - entry log + telemetry event names emitted with stable shape.
 *
 * The tests insert into `bus_outbox` directly. The in-memory bus
 * used by `makeTestAppSeeded` does NOT write to `bus_outbox`
 * (that's the durable adapter's contract); driving the durable
 * adapter through a full publish cycle adds churn we don't need —
 * the route under test reads from the table, so seeding rows
 * directly is the cheaper, more focused fixture.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { makeTestAppSeeded, type TestApp } from './_helpers/app';
import { loginSeededAdminRotated, seedNonAdminUser } from './_helpers/auth';
import {
  encodeBusOutboxCursor,
  parseBusOutboxCursor,
  parseBusOutboxQuery,
} from '../src/http/routes/admin-bus';
import { ADMIN_OBSERVABILITY_EVENT_TYPES } from '../src/observability/events';

let fx: TestApp | null = null;

afterEach(() => {
  if (fx !== null) {
    fx.cleanup();
    fx = null;
  }
});

interface OutboxBody {
  readonly rows: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly status: string;
    readonly occurredAt: string;
    readonly attempt: number;
    readonly payloadPreview: string;
  }>;
  readonly nextCursor: string | null;
}

interface OutboxDetailBody {
  readonly id: string;
  readonly type: string;
  readonly payload: string;
  readonly payloadTruncated: boolean;
  readonly payloadOriginalBytes: number;
  readonly metadata: string | null;
  readonly metadataTruncated: boolean;
  readonly error: string | null;
}

function seedOutboxRow(
  fixture: TestApp,
  idx: number,
  overrides: {
    type?: string;
    status?: 'pending' | 'in_flight' | 'delivered' | 'dead' | 'abandoned';
    occurredAt?: string;
    payload?: string;
    metadata?: string | null;
  } = {},
): void {
  const occurredAt =
    overrides.occurredAt ?? new Date(Date.UTC(2026, 4, 25, 14, 0, idx)).toISOString();
  const status = overrides.status ?? 'delivered';
  const payload = overrides.payload ?? JSON.stringify({ idx });
  const metadata = overrides.metadata === undefined ? null : overrides.metadata;
  fixture.db.run(
    `INSERT INTO bus_outbox (id, type, payload_json, metadata_json, correlation_id, flow_id,
                             occurred_at, status, attempt, claimed_at, claimed_by_pid,
                             delivered_at, error)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL,
             CASE WHEN ? = 'delivered' THEN ? ELSE NULL END,
             NULL)`,
    [
      `outbox-${String(idx).padStart(3, '0')}`,
      overrides.type ?? 'test.outbox',
      payload,
      metadata,
      occurredAt,
      status,
      0,
      status,
      occurredAt,
    ],
  );
}

describe('parseBusOutboxQuery (unit)', () => {
  it('parses an empty query into a no-filter request with the default limit', () => {
    const r = parseBusOutboxQuery({});
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.filter.status).toBe(null);
    expect(r.filter.typePrefix).toBe(null);
    expect(r.filter.from).toBe(null);
    expect(r.filter.to).toBe(null);
    expect(r.filter.limit).toBe(50);
    expect(r.filter.cursor).toBe(null);
  });

  it('caps an over-large limit at 200', () => {
    const r = parseBusOutboxQuery({ limit: '10000' });
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.filter.limit).toBe(200);
  });

  it('accepts the documented status values', () => {
    for (const s of ['pending', 'in_flight', 'delivered', 'dead', 'abandoned']) {
      const r = parseBusOutboxQuery({ status: s });
      if (r.kind !== 'ok') throw new Error(`expected ok for ${s}`);
      expect(r.filter.status).toBe(s as never);
    }
  });

  it('rejects an unknown status with errors.admin.observability.invalidStatus', () => {
    const r = parseBusOutboxQuery({ status: 'not-a-status' });
    if (r.kind !== 'error') throw new Error('expected error');
    expect(r.errorKey).toBe('errors.admin.observability.invalidStatus');
  });

  it('rejects an invalid timestamp with errors.admin.observability.invalidTimestamp', () => {
    const r = parseBusOutboxQuery({ from: 'not-a-date' });
    if (r.kind !== 'error') throw new Error('expected error');
    expect(r.errorKey).toBe('errors.admin.observability.invalidTimestamp');
  });

  it('rejects an invalid cursor with errors.admin.observability.invalidCursor', () => {
    const r = parseBusOutboxQuery({ cursor: 'definitely-not-base64-json' });
    if (r.kind !== 'error') throw new Error('expected error');
    expect(r.errorKey).toBe('errors.admin.observability.invalidCursor');
  });

  it('round-trips a cursor through encodeBusOutboxCursor / parseBusOutboxCursor', () => {
    const original = { ts: '2026-05-25T14:00:00.000Z', id: 'outbox-042' };
    const encoded = encodeBusOutboxCursor(original);
    const decoded = parseBusOutboxCursor(encoded);
    if (decoded === null || decoded === 'invalid') {
      throw new Error('expected a cursor');
    }
    expect(decoded.ts).toBe(original.ts);
    expect(decoded.id).toBe(original.id);
  });
});

describe('GET /admin/bus/outbox', () => {
  it('lists outbox rows newest-first with a stable cursor', async () => {
    fx = await makeTestAppSeeded('bunny2-admin-bus-outbox-list-');
    const { token: adminToken } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    for (let i = 1; i <= 5; i += 1) seedOutboxRow(fx, i, { type: 'list.fixture' });

    const res = await fx.app.fetch(
      new Request('http://localhost/admin/bus/outbox?limit=3&type=list.fixture', {
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as OutboxBody;
    expect(body.rows.map((r) => r.id)).toEqual(['outbox-005', 'outbox-004', 'outbox-003']);
    expect(body.nextCursor).not.toBe(null);
    // List response carries a payload PREVIEW only — never the full row.
    expect(body.rows[0]?.payloadPreview.length).toBeGreaterThan(0);
  });

  it('paginates a stable cursor across a concurrent insert', async () => {
    fx = await makeTestAppSeeded('bunny2-admin-bus-outbox-cursor-');
    const { token: adminToken } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    for (let i = 1; i <= 6; i += 1) seedOutboxRow(fx, i, { type: 'cursor.fixture' });

    const page1Res = await fx.app.fetch(
      new Request('http://localhost/admin/bus/outbox?limit=3&type=cursor.fixture', {
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as OutboxBody;
    const ids1 = page1.rows.map((r) => r.id);
    expect(ids1).toEqual(['outbox-006', 'outbox-005', 'outbox-004']);
    expect(page1.nextCursor).not.toBe(null);

    // Concurrent insert: a NEW row lands AFTER outbox-006.
    seedOutboxRow(fx, 99, {
      type: 'cursor.fixture',
      occurredAt: new Date(Date.UTC(2026, 4, 25, 15, 0, 0)).toISOString(),
    });

    const cursor = page1.nextCursor;
    if (cursor === null) throw new Error('expected a cursor');
    const page2Res = await fx.app.fetch(
      new Request(
        `http://localhost/admin/bus/outbox?limit=3&type=cursor.fixture&cursor=${encodeURIComponent(cursor)}`,
        { headers: { authorization: `Bearer ${adminToken}` } },
      ),
    );
    expect(page2Res.status).toBe(200);
    const page2 = (await page2Res.json()) as OutboxBody;
    const ids2 = page2.rows.map((r) => r.id);
    expect(ids2).toEqual(['outbox-003', 'outbox-002', 'outbox-001']);
    // No overlap, no skip.
    const overlap = ids1.filter((id) => ids2.includes(id));
    expect(overlap).toEqual([]);
    expect(ids2).not.toContain('outbox-099');
  });

  it('surfaces delivered rows separately from rows in other statuses', async () => {
    fx = await makeTestAppSeeded('bunny2-admin-bus-outbox-status-');
    const { token: adminToken } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    seedOutboxRow(fx, 1, { type: 'status.fixture', status: 'pending' });
    seedOutboxRow(fx, 2, { type: 'status.fixture', status: 'in_flight' });
    seedOutboxRow(fx, 3, { type: 'status.fixture', status: 'delivered' });
    seedOutboxRow(fx, 4, { type: 'status.fixture', status: 'dead' });
    seedOutboxRow(fx, 5, { type: 'status.fixture', status: 'delivered' });

    const deliveredRes = await fx.app.fetch(
      new Request('http://localhost/admin/bus/outbox?status=delivered&type=status.fixture', {
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    );
    const delivered = (await deliveredRes.json()) as OutboxBody;
    expect(delivered.rows.map((r) => r.id).sort()).toEqual(['outbox-003', 'outbox-005']);

    const pendingRes = await fx.app.fetch(
      new Request('http://localhost/admin/bus/outbox?status=pending&type=status.fixture', {
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    );
    const pending = (await pendingRes.json()) as OutboxBody;
    expect(pending.rows.map((r) => r.id)).toEqual(['outbox-001']);
  });

  it('forbids non-admin callers from listing the outbox', async () => {
    fx = await makeTestAppSeeded('bunny2-admin-bus-outbox-forbid-');
    await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const nonAdmin = await seedNonAdminUser({ db: fx.db, app: fx.app }, { username: 'bob' });
    const res = await fx.app.fetch(
      new Request('http://localhost/admin/bus/outbox', {
        headers: { authorization: `Bearer ${nonAdmin.token}` },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('writes a telemetry event on every list query', async () => {
    fx = await makeTestAppSeeded('bunny2-admin-bus-outbox-telemetry-');
    const { token: adminToken } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const before =
      fx.db
        .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM events WHERE type = ?')
        .get(ADMIN_OBSERVABILITY_EVENT_TYPES.BusOutboxQuery)?.n ?? 0;
    const res = await fx.app.fetch(
      new Request('http://localhost/admin/bus/outbox', {
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(res.status).toBe(200);
    const after =
      fx.db
        .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM events WHERE type = ?')
        .get(ADMIN_OBSERVABILITY_EVENT_TYPES.BusOutboxQuery)?.n ?? 0;
    expect(after).toBe(before + 1);
  });
});

describe('GET /admin/bus/outbox/:id', () => {
  it('returns the full row with the redacted payload', async () => {
    fx = await makeTestAppSeeded('bunny2-admin-bus-outbox-detail-');
    const { token: adminToken } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    seedOutboxRow(fx, 1, {
      type: 'detail.fixture',
      payload: JSON.stringify({ hello: 'world' }),
      metadata: JSON.stringify({ layerId: 'L1' }),
    });
    const res = await fx.app.fetch(
      new Request('http://localhost/admin/bus/outbox/outbox-001', {
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as OutboxDetailBody;
    expect(body.id).toBe('outbox-001');
    expect(body.payload).toBe('{"hello":"world"}');
    expect(body.payloadTruncated).toBe(false);
    expect(body.metadata).toBe('{"layerId":"L1"}');
  });

  it('truncates a > 200 KB payload with the explicit R3 marker', async () => {
    fx = await makeTestAppSeeded('bunny2-admin-bus-outbox-trunc-');
    const { token: adminToken } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    // 250 KB of 'a' — exceeds the 200 KB cap.
    const big = 'a'.repeat(250 * 1024);
    seedOutboxRow(fx, 1, { type: 'trunc.fixture', payload: big });
    const res = await fx.app.fetch(
      new Request('http://localhost/admin/bus/outbox/outbox-001', {
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    );
    const body = (await res.json()) as OutboxDetailBody;
    expect(body.payloadTruncated).toBe(true);
    expect(body.payloadOriginalBytes).toBe(250 * 1024);
    expect(body.payload).toContain('...[truncated; full payload available via API]');
  });

  it('returns 404 errors.admin.observability.notFound for an unknown id', async () => {
    fx = await makeTestAppSeeded('bunny2-admin-bus-outbox-404-');
    const { token: adminToken } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const res = await fx.app.fetch(
      new Request('http://localhost/admin/bus/outbox/does-not-exist', {
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.admin.observability.notFound');
  });

  it('forbids non-admin callers from reading detail', async () => {
    fx = await makeTestAppSeeded('bunny2-admin-bus-outbox-detail-forbid-');
    await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    seedOutboxRow(fx, 1);
    const nonAdmin = await seedNonAdminUser({ db: fx.db, app: fx.app }, { username: 'eve' });
    const res = await fx.app.fetch(
      new Request('http://localhost/admin/bus/outbox/outbox-001', {
        headers: { authorization: `Bearer ${nonAdmin.token}` },
      }),
    );
    expect(res.status).toBe(403);
  });
});
