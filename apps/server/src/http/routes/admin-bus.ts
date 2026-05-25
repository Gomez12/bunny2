import type { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import type { BusDlqReplayedPayload } from '../../bus/events';
import type { HonoVariables } from '../types';
import { ADMIN_OBSERVABILITY_EVENT_TYPES } from '../../observability/events';

/**
 * Phase 5.4 + admin-observability §5 phase 5 — `/admin/bus/*` admin
 * bus ledger surface.
 *
 * Sits behind the `/admin/*` `requireAdmin` gate. Routes:
 *
 *  - `GET  /admin/bus/dlq` — DLQ list, latest failures first. Joins
 *    `bus_dlq` with `bus_outbox` so the admin sees the event type +
 *    a clipped payload preview without needing to know the
 *    underlying schema. Full payloads are NOT exposed in this list
 *    — plan §7 last paragraph keeps payload behind the row id only.
 *    Response shape: `{ items: DlqSummary[] }`. Legacy — no cursor,
 *    no telemetry — kept stable so the existing web client doesn't
 *    have to change.
 *  - `POST /admin/bus/dlq/:outboxId/replay` — flips the outbox row
 *    back to `pending` via the durable bus's `replayDlq` and
 *    publishes `bus.dlq.replayed`.
 *  - `GET  /admin/bus/outbox` — non-DLQ outbox ledger expansion
 *    (admin-observability plan §5 phase 5). Cursor pagination on
 *    `(occurred_at, id) DESC`, filters: `status` (pending /
 *    in_flight / delivered / dead / abandoned), `from`, `to`, `type`
 *    (LIKE prefix). List excludes `payload_json` / `metadata_json`
 *    per the redaction audit; drawer fetches via `/:id`.
 *  - `GET  /admin/bus/outbox/:id` — drawer detail. Returns the row
 *    with payload + metadata, each truncated > 200 KB with the same
 *    R3 marker as `llm_calls`.
 *
 * Tests that wire an in-memory bus pass `replayDlq: undefined`; the
 * route 503s with `errors.bus.dlqReplayFailed` instead of crashing.
 * Production wiring in `apps/server/src/index.ts` always passes the
 * durable adapter's `replayDlq` method.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const PAYLOAD_PREVIEW_MAX = 500;
/** R3 mitigation — mirror the cap used by the LLM-calls detail. */
const MAX_PAYLOAD_BYTES = 200 * 1024;
const TRUNCATION_MARKER = '...[truncated; full payload available via API]';

const NOT_FOUND = { error: 'errors.bus.dlqReplayFailed' } as const;
const UNAVAILABLE = { error: 'errors.bus.dlqReplayFailed' } as const;
const OUTBOX_NOT_FOUND = { error: 'errors.admin.observability.notFound' } as const;

const OUTBOX_STATUSES = ['pending', 'in_flight', 'delivered', 'dead', 'abandoned'] as const;
export type BusOutboxStatus = (typeof OUTBOX_STATUSES)[number];

export interface BusOutboxCursor {
  readonly ts: string;
  readonly id: string;
}

interface DlqRow {
  readonly id: string;
  readonly outbox_id: string;
  readonly subscriber_key: string;
  readonly error: string;
  readonly attempts: number;
  readonly failed_at: string;
  readonly type: string | null;
  readonly payload_json: string | null;
}

interface DlqSummary {
  readonly id: string;
  readonly outboxId: string;
  readonly subscriberKey: string;
  readonly eventType: string;
  readonly payloadPreview: string;
  readonly attempts: number;
  readonly error: string;
  readonly failedAt: string;
}

export interface AdminBusRouteDeps {
  readonly bus: MessageBus;
  readonly db: Database;
  /**
   * Hook to the durable adapter's DLQ-replay surface. Optional so
   * tests that wire an in-memory bus can skip it; the replay route
   * 503s when this is undefined.
   */
  readonly replayDlq?: (outboxId: string) => boolean;
  /** Clock override for tests. */
  readonly now?: () => number;
}

export function registerAdminBusRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: AdminBusRouteDeps,
): void {
  const now = deps.now ?? ((): number => Date.now());
  registerOutboxRoutes(app, deps, now);
  // ---------- GET /admin/bus/dlq -----------------------------------------

  app.get('/admin/bus/dlq', (c) => {
    const limit = parseLimit(c.req.query('limit'));
    const rows = deps.db
      .query<DlqRow, [number]>(
        `SELECT d.id, d.outbox_id, d.subscriber_key, d.error, d.attempts, d.failed_at,
                o.type, o.payload_json
           FROM bus_dlq d
           LEFT JOIN bus_outbox o ON o.id = d.outbox_id
          ORDER BY d.failed_at DESC
          LIMIT ?`,
      )
      .all(limit);
    const items: DlqSummary[] = rows.map(toSummary);
    return c.json({ items });
  });

  // ---------- POST /admin/bus/dlq/:outboxId/replay -----------------------

  app.post('/admin/bus/dlq/:outboxId/replay', async (c) => {
    const correlationId = crypto.randomUUID();
    const user = c.get('user');
    const outboxId = c.req.param('outboxId');

    if (deps.replayDlq === undefined) {
      return c.json(UNAVAILABLE, 503);
    }

    // Look up the dead row so we can echo `subscriberKey` on the
    // emitted event AND so we can return a clean 404 even when the
    // durable adapter happened to return `false` for some other
    // reason (race with a re-publish, etc.).
    const dead = deps.db
      .query<{ subscriber_key: string }, [string]>(
        `SELECT d.subscriber_key
           FROM bus_dlq d
          WHERE d.outbox_id = ?
          ORDER BY d.failed_at DESC
          LIMIT 1`,
      )
      .get(outboxId);
    if (dead === null) {
      return c.json(NOT_FOUND, 404);
    }

    const ok = deps.replayDlq(outboxId);
    if (!ok) {
      // The row is in the DLQ history but the outbox row is no longer
      // in `dead` status (e.g. someone already replayed it). Surface
      // the same 404 so the admin retries cleanly.
      return c.json(NOT_FOUND, 404);
    }

    const payload: BusDlqReplayedPayload = {
      outboxId,
      subscriberKey: dead.subscriber_key,
      replayedBy: user.id,
    };
    await deps.bus.publish({ type: 'bus.dlq.replayed', payload, correlationId });
    return c.json({ ok: true });
  });
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function clipPreview(raw: string | null): string {
  if (raw === null) return '';
  if (raw.length <= PAYLOAD_PREVIEW_MAX) return raw;
  return `${raw.slice(0, PAYLOAD_PREVIEW_MAX)}…`;
}

function toSummary(row: DlqRow): DlqSummary {
  return {
    id: row.id,
    outboxId: row.outbox_id,
    subscriberKey: row.subscriber_key,
    eventType: row.type ?? '',
    payloadPreview: clipPreview(row.payload_json),
    attempts: row.attempts,
    error: row.error,
    failedAt: row.failed_at,
  };
}

// ====================================================================
// Bus outbox ledger expansion (admin-observability plan §5 phase 5)
// ====================================================================
//
// Source: `bus_outbox` (migration 0013). Phase 5 of the
// admin-observability plan expands the existing DLQ-only viewer so
// admins can also see in-flight / delivered outbox rows, not just
// rows that landed in the DLQ. Read-only — replay stays on the DLQ
// path. Per the redaction audit, `payload_json` + `metadata_json` are
// detail-drawer only; the list response carries a clipped preview.

interface BusOutboxFilter {
  readonly status: BusOutboxStatus | null;
  readonly typePrefix: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly limit: number;
  readonly cursor: BusOutboxCursor | null;
}

interface BusOutboxSqlRow {
  readonly id: string;
  readonly type: string;
  readonly correlation_id: string | null;
  readonly flow_id: string | null;
  readonly occurred_at: string;
  readonly status: string;
  readonly attempt: number;
  readonly claimed_at: string | null;
  readonly delivered_at: string | null;
  readonly error: string | null;
  readonly payload_preview: string | null;
}

interface BusOutboxDetailSqlRow extends BusOutboxSqlRow {
  readonly payload_json: string | null;
  readonly metadata_json: string | null;
}

export interface BusOutboxListItem {
  readonly id: string;
  readonly type: string;
  readonly correlationId: string | null;
  readonly flowId: string | null;
  readonly occurredAt: string;
  readonly status: string;
  readonly attempt: number;
  readonly claimedAt: string | null;
  readonly deliveredAt: string | null;
  readonly error: string | null;
  readonly payloadPreview: string;
}

export interface BusOutboxDetail extends BusOutboxListItem {
  readonly payload: string;
  readonly payloadTruncated: boolean;
  readonly payloadOriginalBytes: number;
  readonly metadata: string | null;
  readonly metadataTruncated: boolean;
  readonly metadataOriginalBytes: number;
}

function registerOutboxRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: AdminBusRouteDeps,
  now: () => number,
): void {
  // ---------- GET /admin/bus/outbox -------------------------------------

  app.get('/admin/bus/outbox', async (c) => {
    const parsed = parseBusOutboxQuery(c.req.query());
    if (parsed.kind === 'error') {
      return c.json({ error: parsed.errorKey }, 400);
    }
    const filter = parsed.filter;
    const startMs = now();

    const { rows, nextCursor } = queryBusOutbox(deps.db, filter);

    const durationMs = Math.max(0, now() - startMs);
    const filterKeys = describeBusOutboxFilterKeys(filter);

    console.log('[admin.observability.bus-outbox.query]', {
      event: 'admin.observability.bus-outbox.query',
      filterKeys,
      limit: filter.limit,
      hasCursor: filter.cursor !== null,
      rowCount: rows.length,
      durationMs,
    });

    try {
      await deps.bus.publish({
        type: ADMIN_OBSERVABILITY_EVENT_TYPES.BusOutboxQuery,
        payload: {
          durationMs,
          rowCount: rows.length,
          filterKeys,
          limit: filter.limit,
          hasCursor: filter.cursor !== null,
        },
      });
    } catch {
      // Telemetry must never break a read.
    }

    return c.json({ rows, nextCursor });
  });

  // ---------- GET /admin/bus/outbox/:id ---------------------------------

  app.get('/admin/bus/outbox/:id', async (c) => {
    const id = c.req.param('id');
    if (typeof id !== 'string' || id === '') {
      return c.json(OUTBOX_NOT_FOUND, 404);
    }
    const startMs = now();
    const detail = queryBusOutboxDetail(deps.db, id);
    const durationMs = Math.max(0, now() - startMs);

    if (detail === null) {
      console.log('[admin.observability.bus-outbox.detail]', {
        event: 'admin.observability.bus-outbox.detail',
        durationMs,
        found: false,
      });
      try {
        await deps.bus.publish({
          type: ADMIN_OBSERVABILITY_EVENT_TYPES.BusOutboxDetail,
          payload: {
            durationMs,
            found: false,
            payloadTruncated: false,
            metadataTruncated: false,
          },
        });
      } catch {
        /* swallow */
      }
      return c.json(OUTBOX_NOT_FOUND, 404);
    }

    console.log('[admin.observability.bus-outbox.detail]', {
      event: 'admin.observability.bus-outbox.detail',
      durationMs,
      found: true,
      payloadTruncated: detail.payloadTruncated,
      metadataTruncated: detail.metadataTruncated,
    });

    try {
      await deps.bus.publish({
        type: ADMIN_OBSERVABILITY_EVENT_TYPES.BusOutboxDetail,
        payload: {
          durationMs,
          found: true,
          payloadTruncated: detail.payloadTruncated,
          metadataTruncated: detail.metadataTruncated,
        },
      });
    } catch {
      /* swallow */
    }

    return c.json(detail);
  });
}

// ---------- outbox query parser -------------------------------------------

type BusOutboxParseResult =
  | { readonly kind: 'ok'; readonly filter: BusOutboxFilter }
  | { readonly kind: 'error'; readonly errorKey: string };

/** Exported for unit tests. */
export function parseBusOutboxQuery(
  query: Record<string, string | undefined>,
): BusOutboxParseResult {
  const limit = parseOutboxLimit(query.limit);
  const cursor = parseBusOutboxCursor(query.cursor);
  if (cursor === 'invalid') {
    return { kind: 'error', errorKey: 'errors.admin.observability.invalidCursor' };
  }

  const from = normalizeIso(query.from);
  if (from === 'invalid') {
    return { kind: 'error', errorKey: 'errors.admin.observability.invalidTimestamp' };
  }
  const to = normalizeIso(query.to);
  if (to === 'invalid') {
    return { kind: 'error', errorKey: 'errors.admin.observability.invalidTimestamp' };
  }

  const status = parseStatus(query.status);
  if (status === 'invalid') {
    return { kind: 'error', errorKey: 'errors.admin.observability.invalidStatus' };
  }

  return {
    kind: 'ok',
    filter: {
      status,
      typePrefix: nonEmpty(query.type),
      from,
      to,
      limit,
      cursor,
    },
  };
}

function parseOutboxLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeIso(value: string | undefined): string | null | 'invalid' {
  const v = nonEmpty(value);
  if (v === null) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return 'invalid';
  return d.toISOString();
}

function parseStatus(raw: string | undefined): BusOutboxStatus | null | 'invalid' {
  if (raw === undefined || raw === '') return null;
  if ((OUTBOX_STATUSES as readonly string[]).includes(raw)) return raw as BusOutboxStatus;
  return 'invalid';
}

/** Cursor scheme mirrors Phases 2/3/4 — base64url(JSON({ts,id})). */
export function encodeBusOutboxCursor(cursor: BusOutboxCursor): string {
  const json = JSON.stringify({ ts: cursor.ts, id: cursor.id });
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function parseBusOutboxCursor(raw: string | undefined): BusOutboxCursor | null | 'invalid' {
  if (raw === undefined || raw === '') return null;
  let json: string;
  try {
    json = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return 'invalid';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return 'invalid';
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as { ts?: unknown }).ts !== 'string' ||
    typeof (parsed as { id?: unknown }).id !== 'string'
  ) {
    return 'invalid';
  }
  const obj = parsed as { ts: string; id: string };
  return { ts: obj.ts, id: obj.id };
}

function describeBusOutboxFilterKeys(filter: BusOutboxFilter): readonly string[] {
  const keys: string[] = [];
  if (filter.status !== null) keys.push('status');
  if (filter.typePrefix !== null) keys.push('type');
  if (filter.from !== null) keys.push('from');
  if (filter.to !== null) keys.push('to');
  return keys;
}

/** Escape `%` / `_` / `\` in the LIKE prefix, paired with ESCAPE '\'. */
function escapeLikePrefix(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

interface BusOutboxQueryResult {
  readonly rows: readonly BusOutboxListItem[];
  readonly nextCursor: string | null;
}

function queryBusOutbox(db: Database, filter: BusOutboxFilter): BusOutboxQueryResult {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.status !== null) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.typePrefix !== null) {
    where.push("type LIKE ? ESCAPE '\\'");
    params.push(`${escapeLikePrefix(filter.typePrefix)}%`);
  }
  if (filter.from !== null) {
    where.push('occurred_at >= ?');
    params.push(filter.from);
  }
  if (filter.to !== null) {
    where.push('occurred_at <= ?');
    params.push(filter.to);
  }
  if (filter.cursor !== null) {
    where.push('(occurred_at, id) < (?, ?)');
    params.push(filter.cursor.ts, filter.cursor.id);
  }
  const whereSql = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
  const limitPlusOne = filter.limit + 1;
  // Inline payload preview is built in SQL via SUBSTR — keeps the row
  // size sane on the wire and matches the DLQ-list treatment.
  const sql = `SELECT id, type, correlation_id, flow_id, occurred_at,
                      status, attempt, claimed_at, delivered_at, error,
                      SUBSTR(payload_json, 1, ${PAYLOAD_PREVIEW_MAX + 1}) AS payload_preview
                 FROM bus_outbox
                 ${whereSql}
                ORDER BY occurred_at DESC, id DESC
                LIMIT ?`;
  const rows = db.query<BusOutboxSqlRow, typeof params>(sql).all(...params, limitPlusOne);

  const pageRows = rows.slice(0, filter.limit);
  const hasMore = rows.length > filter.limit;
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last !== undefined
      ? encodeBusOutboxCursor({ ts: last.occurred_at, id: last.id })
      : null;

  return {
    rows: pageRows.map(toOutboxListItem),
    nextCursor,
  };
}

function toOutboxListItem(row: BusOutboxSqlRow): BusOutboxListItem {
  return {
    id: row.id,
    type: row.type,
    correlationId: row.correlation_id,
    flowId: row.flow_id,
    occurredAt: row.occurred_at,
    status: row.status,
    attempt: row.attempt,
    claimedAt: row.claimed_at,
    deliveredAt: row.delivered_at,
    error: row.error,
    payloadPreview: clipPreview(row.payload_preview),
  };
}

interface TruncationOutcome {
  readonly value: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
}

function truncatePayload(raw: string): TruncationOutcome {
  const originalBytes = Buffer.byteLength(raw, 'utf8');
  if (originalBytes <= MAX_PAYLOAD_BYTES) {
    return { value: raw, truncated: false, originalBytes };
  }
  const buf = Buffer.from(raw, 'utf8');
  const prefixBuf = buf.subarray(0, MAX_PAYLOAD_BYTES);
  let prefix = prefixBuf.toString('utf8');
  if (prefix.length > 0 && prefix.charCodeAt(prefix.length - 1) === 0xfffd) {
    prefix = prefix.slice(0, -1);
  }
  return {
    value: `${prefix}${TRUNCATION_MARKER}`,
    truncated: true,
    originalBytes,
  };
}

function queryBusOutboxDetail(db: Database, id: string): BusOutboxDetail | null {
  const row = db
    .query<BusOutboxDetailSqlRow, [string]>(
      `SELECT id, type, correlation_id, flow_id, occurred_at,
              status, attempt, claimed_at, delivered_at, error,
              payload_json, metadata_json,
              SUBSTR(payload_json, 1, ${PAYLOAD_PREVIEW_MAX + 1}) AS payload_preview
         FROM bus_outbox
        WHERE id = ?`,
    )
    .get(id);
  if (row === null) return null;
  const list = toOutboxListItem(row);
  const payload = truncatePayload(row.payload_json ?? '');
  const metadataOutcome =
    row.metadata_json === null
      ? { value: null, truncated: false, originalBytes: 0 }
      : truncatePayload(row.metadata_json);
  return {
    ...list,
    payload: payload.value,
    payloadTruncated: payload.truncated,
    payloadOriginalBytes: payload.originalBytes,
    metadata: metadataOutcome.value,
    metadataTruncated: metadataOutcome.truncated,
    metadataOriginalBytes: metadataOutcome.originalBytes,
  };
}
