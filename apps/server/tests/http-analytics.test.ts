/**
 * Phase 6 of `docs/dev/plans/admin-observability-viewer.md` —
 * `POST /analytics/events` ingest tests, `analytics.events.prune`
 * handler tests, and the `/admin/observability/analytics` viewer
 * endpoint tests.
 *
 * Coverage matrix (plan §6 F):
 *   - Migration `0022_analytics_events.sql` runs idempotently via
 *     `makeTestAppSeeded` (every other test exercises that path).
 *   - Ingest happy path: a known event lands with a hashed user id.
 *   - Ingest rejects unknown event name → 400 + log + telemetry +
 *     stored row count unchanged.
 *   - Ingest rejects unknown property → 400.
 *   - Ingest rejects oversize body → 413.
 *   - Privacy: raw user id is NEVER stored in `user_id_hash`.
 *   - Prune job: removes rows older than retention; emits the
 *     pruned-count telemetry.
 *   - Admin viewer: 403 for non-admin; rollups math correct.
 *   - Sink contract is exercised on the web side; see
 *     `apps/web/tests/analytics-http-sink.test.ts`.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { makeTestAppSeeded, type TestApp } from './_helpers/app';
import { loginSeededAdminRotated, seedNonAdminUser } from './_helpers/auth';
import {
  pruneAnalyticsEvents,
  readAnalyticsRetentionDaysFromEnv,
} from '../src/scheduled/built-in/analytics-prune';
import { hashUserId, __hashUserIdForTest } from '../src/analytics/hash';
import { ANALYTICS_SINK_EVENT_TYPES } from '../src/observability/events';

let fx: TestApp | null = null;

afterEach(() => {
  if (fx !== null) {
    fx.cleanup();
    fx = null;
  }
});

interface AnalyticsRow {
  readonly id: string;
  readonly occurred_at: string;
  readonly event_name: string;
  readonly layer_slug: string | null;
  readonly user_id_hash: string | null;
  readonly properties_json: string;
  readonly ingested_at: string;
}

function readAllAnalyticsRows(db: Database): readonly AnalyticsRow[] {
  return db
    .query<AnalyticsRow, []>('SELECT * FROM analytics_events ORDER BY occurred_at ASC')
    .all();
}

describe('hashUserId', () => {
  it('produces a stable 64-char hex digest for the same input', () => {
    const a = hashUserId('user-abc');
    const b = hashUserId('user-abc');
    expect(a).toBe(b);
    expect(a).not.toBe(null);
    if (a === null) throw new Error('unexpected null');
    // SHA-256 → 64 hex chars; HMAC-SHA256 → same width.
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns null for null / empty input', () => {
    expect(hashUserId(null)).toBe(null);
    expect(hashUserId('')).toBe(null);
  });

  it('differs from a plain raw id (sanity)', () => {
    const h = hashUserId('user-abc');
    expect(h).not.toBe('user-abc');
  });
});

describe('POST /analytics/events', () => {
  it('ingests a known event with a hashed user id (raw id never stored)', async () => {
    fx = await makeTestAppSeeded('bunny2-analytics-happy-');
    const nonAdmin = await seedNonAdminUser({ db: fx.db, app: fx.app }, { username: 'alice' });

    const res = await fx.app.fetch(
      new Request('http://localhost/analytics/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${nonAdmin.token}`,
        },
        body: JSON.stringify({
          name: 'chat_message_sent',
          props: {
            layerSlug: 'demo',
            conversationId: 'conv-1',
            lengthBucket: 'S',
          },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ingested: number; rejected: readonly unknown[] };
    expect(body.ingested).toBe(1);
    expect(body.rejected).toEqual([]);

    const rows = readAllAnalyticsRows(fx.db);
    expect(rows.length).toBe(1);
    const row = rows[0];
    if (row === undefined) throw new Error('row missing');
    expect(row.event_name).toBe('chat_message_sent');
    expect(row.layer_slug).toBe('demo');
    // User id was hashed server-side. The raw id never appears.
    expect(row.user_id_hash).not.toBe(null);
    if (row.user_id_hash === null) throw new Error('hash missing');
    expect(row.user_id_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.user_id_hash).not.toContain(nonAdmin.user.id);
    // Re-deriving via the helper yields the same hash (deterministic).
    const reHashed = __hashUserIdForTest(
      nonAdmin.user.id,
      process.env['BUNNY2_ENCRYPTION_KEY'] ?? null,
    );
    expect(row.user_id_hash).toBe(reHashed);
  });

  it('rejects an unknown event name with 400 + {rejected[]} and writes no row', async () => {
    fx = await makeTestAppSeeded('bunny2-analytics-reject-name-');
    const nonAdmin = await seedNonAdminUser({ db: fx.db, app: fx.app }, { username: 'alice' });

    const res = await fx.app.fetch(
      new Request('http://localhost/analytics/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${nonAdmin.token}`,
        },
        body: JSON.stringify({ name: 'not_in_catalogue', props: { layerSlug: 'demo' } }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      ingested: number;
      rejected: ReadonlyArray<{ eventName: string | null; reason: string }>;
    };
    expect(body.ingested).toBe(0);
    expect(body.rejected.length).toBe(1);
    const r0 = body.rejected[0];
    if (r0 === undefined) throw new Error('rejection missing');
    expect(r0.eventName).toBe('not_in_catalogue');
    expect(r0.reason).toBe('unknown_name');
    expect(readAllAnalyticsRows(fx.db).length).toBe(0);

    // Telemetry: the bus must have an `analytics.events.rejected` row.
    const tel = fx.db
      .query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM events WHERE type = ?')
      .get(ANALYTICS_SINK_EVENT_TYPES.Rejected);
    expect(tel?.n).toBeGreaterThan(0);
  });

  it('rejects an event whose props contain an unknown key', async () => {
    fx = await makeTestAppSeeded('bunny2-analytics-reject-prop-');
    const nonAdmin = await seedNonAdminUser({ db: fx.db, app: fx.app }, { username: 'alice' });

    const res = await fx.app.fetch(
      new Request('http://localhost/analytics/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${nonAdmin.token}`,
        },
        body: JSON.stringify({
          name: 'chat_message_sent',
          props: {
            layerSlug: 'demo',
            conversationId: 'conv-1',
            lengthBucket: 'S',
            // Not in the catalogue's allowedProps for chat_message_sent.
            rawText: 'this should never reach the table',
          },
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      ingested: number;
      rejected: ReadonlyArray<{ reason: string }>;
    };
    expect(body.ingested).toBe(0);
    expect(body.rejected.length).toBe(1);
    expect(body.rejected[0]?.reason).toBe('unknown_property');
    expect(readAllAnalyticsRows(fx.db).length).toBe(0);
  });

  it('rejects an oversize body with 413', async () => {
    fx = await makeTestAppSeeded('bunny2-analytics-oversize-');
    const nonAdmin = await seedNonAdminUser({ db: fx.db, app: fx.app }, { username: 'alice' });

    // 64 KB of filler in the body — over the 32 KB cap.
    const padding = 'x'.repeat(64 * 1024);
    const res = await fx.app.fetch(
      new Request('http://localhost/analytics/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${nonAdmin.token}`,
        },
        body: JSON.stringify({
          name: 'chat_message_sent',
          props: { layerSlug: padding },
        }),
      }),
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.analytics.payloadTooLarge');
    expect(readAllAnalyticsRows(fx.db).length).toBe(0);
  });

  it('returns 200 for a mixed batch (some ingested + some rejected) so the sink does not retry the accepted half', async () => {
    fx = await makeTestAppSeeded('bunny2-analytics-mixed-');
    const nonAdmin = await seedNonAdminUser({ db: fx.db, app: fx.app }, { username: 'alice' });

    const res = await fx.app.fetch(
      new Request('http://localhost/analytics/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${nonAdmin.token}`,
        },
        body: JSON.stringify({
          events: [
            { name: 'capabilities_page_opened', props: { layerSlug: 'demo' } },
            { name: 'not_in_catalogue', props: {} },
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ingested: number; rejected: readonly unknown[] };
    expect(body.ingested).toBe(1);
    expect(body.rejected.length).toBe(1);
  });

  it('drops batched events with raw user content because the catalogue forbids the key', async () => {
    // Redaction sanity: even if a hostile client posts a known event
    // with extra raw-text properties, none of it lands on disk.
    fx = await makeTestAppSeeded('bunny2-analytics-redaction-');
    const nonAdmin = await seedNonAdminUser({ db: fx.db, app: fx.app }, { username: 'alice' });

    const res = await fx.app.fetch(
      new Request('http://localhost/analytics/events', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${nonAdmin.token}`,
        },
        body: JSON.stringify({
          events: [
            { name: 'chat_message_sent', props: { layerSlug: 'demo', userMessage: 'secret' } },
            { name: 'capabilities_page_opened', props: { layerSlug: 'demo' } },
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const rows = readAllAnalyticsRows(fx.db);
    expect(rows.length).toBe(1);
    expect(rows[0]?.event_name).toBe('capabilities_page_opened');
    // The persisted props must NOT contain the user-content key.
    for (const r of rows) {
      expect(r.properties_json).not.toContain('userMessage');
      expect(r.properties_json).not.toContain('secret');
    }
  });

  it('requires an authenticated session (401 without bearer)', async () => {
    fx = await makeTestAppSeeded('bunny2-analytics-noauth-');
    const res = await fx.app.fetch(
      new Request('http://localhost/analytics/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'chat_message_sent', props: { layerSlug: 'demo' } }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe('analytics.events.prune', () => {
  it('deletes only rows older than the retention cutoff', async () => {
    fx = await makeTestAppSeeded('bunny2-analytics-prune-');
    const ingested = new Date('2026-05-25T00:00:00.000Z').toISOString();
    // Three rows: 1 day ago, 100 days ago, 200 days ago.
    const insert = fx.db.query<
      unknown,
      [string, string, string, string | null, string | null, string, string]
    >(
      `INSERT INTO analytics_events
         (id, occurred_at, event_name, layer_slug, user_id_hash,
          properties_json, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      'a1',
      new Date(Date.parse(ingested) - 1 * 24 * 60 * 60 * 1000).toISOString(),
      'chat_message_sent',
      'demo',
      'h1',
      '{}',
      ingested,
    );
    insert.run(
      'a2',
      new Date(Date.parse(ingested) - 100 * 24 * 60 * 60 * 1000).toISOString(),
      'chat_message_sent',
      'demo',
      'h2',
      '{}',
      ingested,
    );
    insert.run(
      'a3',
      new Date(Date.parse(ingested) - 200 * 24 * 60 * 60 * 1000).toISOString(),
      'chat_message_sent',
      'demo',
      'h3',
      '{}',
      ingested,
    );

    const deleted = pruneAnalyticsEvents(fx.db, 90, new Date(ingested));
    expect(deleted).toBe(2);
    const remaining = readAllAnalyticsRows(fx.db);
    expect(remaining.map((r) => r.id)).toEqual(['a1']);
  });

  it('honours the ANALYTICS_RETENTION_DAYS env when valid', () => {
    expect(readAnalyticsRetentionDaysFromEnv({ ANALYTICS_RETENTION_DAYS: '30' })).toBe(30);
    expect(readAnalyticsRetentionDaysFromEnv({})).toBe(90);
    expect(readAnalyticsRetentionDaysFromEnv({ ANALYTICS_RETENTION_DAYS: 'banana' })).toBe(90);
    expect(readAnalyticsRetentionDaysFromEnv({ ANALYTICS_RETENTION_DAYS: '-1' })).toBe(90);
  });
});

describe('GET /admin/observability/analytics', () => {
  it('returns rows + the catalogue + 24h/7d rollups for an admin caller', async () => {
    fx = await makeTestAppSeeded('bunny2-analytics-list-');
    const { token: adminToken } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });

    // Seed via the ingest endpoint so we exercise the validator too.
    // Use the admin's own session — it's still requireAuth, not admin.
    for (let i = 0; i < 3; i += 1) {
      const r = await fx.app.fetch(
        new Request('http://localhost/analytics/events', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
          body: JSON.stringify({
            name: 'chat_message_sent',
            props: { layerSlug: 'demo', conversationId: `c-${i}`, lengthBucket: 'S' },
          }),
        }),
      );
      expect(r.status).toBe(200);
    }

    const listRes = await fx.app.fetch(
      new Request('http://localhost/admin/observability/analytics?limit=10', {
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as {
      rows: readonly { eventName: string }[];
      nextCursor: string | null;
      catalogue: readonly { name: string; allowedProps: readonly string[] }[];
    };
    expect(body.rows.length).toBe(3);
    expect(body.catalogue.some((c) => c.name === 'chat_message_sent')).toBe(true);

    const rollupsRes = await fx.app.fetch(
      new Request('http://localhost/admin/observability/analytics/rollups', {
        headers: { authorization: `Bearer ${adminToken}` },
      }),
    );
    expect(rollupsRes.status).toBe(200);
    const rollups = (await rollupsRes.json()) as {
      window24h: readonly { eventName: string; count: number }[];
      window7d: readonly { eventName: string; count: number }[];
      totalCount24h: number;
      totalCount7d: number;
    };
    expect(rollups.totalCount24h).toBe(3);
    expect(rollups.totalCount7d).toBe(3);
    const top24 = rollups.window24h[0];
    if (top24 === undefined) throw new Error('rollup row missing');
    expect(top24.eventName).toBe('chat_message_sent');
    expect(top24.count).toBe(3);
  });

  it('forbids non-admin callers with 403 errors.admin.forbidden', async () => {
    fx = await makeTestAppSeeded('bunny2-analytics-forbid-');
    await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const nonAdmin = await seedNonAdminUser({ db: fx.db, app: fx.app }, { username: 'bob' });

    const res = await fx.app.fetch(
      new Request('http://localhost/admin/observability/analytics', {
        headers: { authorization: `Bearer ${nonAdmin.token}` },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.admin.forbidden');
  });

  it('paginates a stable cursor across a concurrent insert', async () => {
    fx = await makeTestAppSeeded('bunny2-analytics-cursor-');
    const { token: adminToken } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    // 6 rows via the ingest endpoint.
    for (let i = 0; i < 6; i += 1) {
      const r = await fx.app.fetch(
        new Request('http://localhost/analytics/events', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
          body: JSON.stringify({
            name: 'capabilities_page_opened',
            props: { layerSlug: `slug-${i}` },
          }),
        }),
      );
      expect(r.status).toBe(200);
    }

    const page1 = (await (
      await fx.app.fetch(
        new Request('http://localhost/admin/observability/analytics?limit=3', {
          headers: { authorization: `Bearer ${adminToken}` },
        }),
      )
    ).json()) as { rows: { id: string; layerSlug: string | null }[]; nextCursor: string | null };
    expect(page1.rows.length).toBe(3);
    expect(page1.nextCursor).not.toBe(null);

    // Concurrent insert with a future occurred_at.
    fx.db
      .query<unknown, [string, string, string, string | null, string | null, string, string]>(
        `INSERT INTO analytics_events
           (id, occurred_at, event_name, layer_slug, user_id_hash,
            properties_json, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'future-row',
        '2099-01-01T00:00:00.000Z',
        'capabilities_page_opened',
        'concurrent',
        null,
        '{"layerSlug":"concurrent"}',
        new Date().toISOString(),
      );

    const cursor = page1.nextCursor;
    if (cursor === null) throw new Error('cursor missing');
    const page2 = (await (
      await fx.app.fetch(
        new Request(
          `http://localhost/admin/observability/analytics?limit=3&cursor=${encodeURIComponent(cursor)}`,
          { headers: { authorization: `Bearer ${adminToken}` } },
        ),
      )
    ).json()) as { rows: { id: string }[]; nextCursor: string | null };
    expect(page2.rows.length).toBe(3);
    // The future row must NOT be on page 2 (cursor scopes the range).
    expect(page2.rows.some((r) => r.id === 'future-row')).toBe(false);
    // No overlap with page 1.
    const idsP1 = new Set(page1.rows.map((r) => r.id));
    for (const r of page2.rows) expect(idsP1.has(r.id)).toBe(false);
  });
});
