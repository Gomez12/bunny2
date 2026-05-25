import type { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import type { HonoVariables } from '../types';

/**
 * Phase 2–3 of `docs/dev/plans/admin-observability-viewer.md` —
 * `/admin/observability/*` admin viewer endpoints.
 *
 * This file owns the read-only routes that expose canonical
 * observability tables to admins. Phase 2 wires the events viewer;
 * Phase 3 adds the LLM-calls list + detail + rollups endpoints;
 * Phase 4 will append `chat-runs` handlers alongside them.
 *
 * All routes sit behind the `/admin/*` `requireAdmin` gate mounted
 * in `router.ts`, so every handler can assume the caller is a
 * verified site admin.
 *
 * Per-route observability contract (plan §11 + §12):
 *   - Entry log: `console.log('[admin.observability.<table>.query]',
 *     { event, filter, … })` — filter set only, no row content.
 *   - Telemetry: a bus event of the same name carrying
 *     `{ durationMs, rowCount, filterKeys }` so a SELECT against
 *     `events` can answer "how often did admins hit the viewer and
 *     how heavy were the queries".
 *
 * Column-level redaction (per
 * `docs/dev/audits/admin-observability-redaction-2026-05-25.md`):
 *   - `events.payload` / `.metadata`: detail drawer only.
 *   - `llm_calls.request` / `.response`: detail drawer only; payloads
 *     larger than 200 KB are server-truncated with an explicit marker
 *     (plan §3-R3) before returning to the web client. The list
 *     response excludes both columns entirely.
 */

import { ADMIN_OBSERVABILITY_EVENT_TYPES } from '../../observability/events';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface EventsFilter {
  readonly kindPrefix: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly layerId: string | null;
  readonly flowId: string | null;
  readonly correlationId: string | null;
  readonly limit: number;
  readonly cursor: EventsCursor | null;
}

export interface EventsCursor {
  readonly ts: string;
  readonly id: string;
}

interface EventRow {
  readonly id: string;
  readonly type: string;
  readonly occurred_at: string;
  readonly correlation_id: string | null;
  readonly flow_id: string | null;
  readonly payload: string;
  readonly metadata: string | null;
}

export interface AdminObservabilityRouteDeps {
  readonly db: Database;
  readonly bus: MessageBus;
  /** Override the clock for tests; returns ms epoch. */
  readonly now?: () => number;
}

export function registerAdminObservabilityRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: AdminObservabilityRouteDeps,
): void {
  const now = deps.now ?? ((): number => Date.now());

  registerLlmCallsRoutes(app, deps, now);

  // ---------- GET /admin/observability/events ----------------------------

  app.get('/admin/observability/events', async (c) => {
    const parsed = parseEventsQuery(c.req.query());
    if (parsed.kind === 'error') {
      return c.json({ error: parsed.errorKey }, 400);
    }
    const filter = parsed.filter;
    const startMs = now();

    const { rows, nextCursor } = queryEvents(deps.db, filter);

    const durationMs = Math.max(0, now() - startMs);
    const filterKeys = describeFilterKeys(filter);

    // Phase 11 — entry log (no row content).
    console.log('[admin.observability.events.query]', {
      event: 'admin.observability.events.query',
      filterKeys,
      limit: filter.limit,
      hasCursor: filter.cursor !== null,
      rowCount: rows.length,
      durationMs,
    });

    // Phase 12 — telemetry. The bus event lands in `events` like any
    // other; the `admin.observability` namespace is documented in
    // `docs/dev/observability/telemetry.md` §4 so the metric stays
    // grep-able alongside the LLM and chat-pipeline rows.
    try {
      await deps.bus.publish({
        type: ADMIN_OBSERVABILITY_EVENT_TYPES.EventsQuery,
        payload: {
          durationMs,
          rowCount: rows.length,
          filterKeys,
          limit: filter.limit,
          hasCursor: filter.cursor !== null,
        },
      });
    } catch {
      // Telemetry must never break a read. Swallow.
    }

    return c.json({ rows, nextCursor });
  });
}

// ---------- query parser ----------------------------------------------------

type ParseResult =
  | { readonly kind: 'ok'; readonly filter: EventsFilter }
  | { readonly kind: 'error'; readonly errorKey: string };

/**
 * Parses the query-string for `GET /admin/observability/events`.
 * Exported for unit tests.
 */
export function parseEventsQuery(query: Record<string, string | undefined>): ParseResult {
  const limit = parseLimit(query.limit);
  const cursor = parseCursor(query.cursor);
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

  return {
    kind: 'ok',
    filter: {
      kindPrefix: nonEmpty(query.kind),
      from,
      to,
      layerId: nonEmpty(query.layerId),
      flowId: nonEmpty(query.flowId),
      correlationId: nonEmpty(query.correlationId),
      limit,
      cursor,
    },
  };
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/**
 * Encode a cursor as `base64url(JSON({ts, id}))`. Stable under
 * concurrent inserts because the cursor names the LAST row the
 * caller saw (composite `(occurred_at, id)`); the follow-up page
 * filters strictly past that row. New rows inserted between page
 * calls land OUTSIDE the (DESC) range of the second call by
 * construction.
 */
export function encodeCursor(cursor: EventsCursor): string {
  const json = JSON.stringify({ ts: cursor.ts, id: cursor.id });
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Returns `null` for no cursor, `'invalid'` for malformed input, or
 * a decoded `EventsCursor`.
 */
export function parseCursor(raw: string | undefined): EventsCursor | null | 'invalid' {
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

function describeFilterKeys(filter: EventsFilter): readonly string[] {
  const keys: string[] = [];
  if (filter.kindPrefix !== null) keys.push('kind');
  if (filter.from !== null) keys.push('from');
  if (filter.to !== null) keys.push('to');
  if (filter.layerId !== null) keys.push('layerId');
  if (filter.flowId !== null) keys.push('flowId');
  if (filter.correlationId !== null) keys.push('correlationId');
  return keys;
}

// ---------- query runner ----------------------------------------------------

interface QueryResult {
  readonly rows: readonly EventSummary[];
  readonly nextCursor: string | null;
}

export interface EventSummary {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly correlationId: string | null;
  readonly flowId: string | null;
  readonly payload: string;
  readonly metadata: string | null;
}

/**
 * Escape the `%` / `_` / `\` characters in a user-supplied LIKE
 * prefix so a caller can match a literal underscore inside a kind
 * such as `chat_pipeline_steps.intent`. We pair this with
 * `ESCAPE '\'` on the SQL side.
 */
function escapeLikePrefix(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function queryEvents(db: Database, filter: EventsFilter): QueryResult {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.kindPrefix !== null) {
    where.push("type LIKE ? ESCAPE '\\'");
    params.push(`${escapeLikePrefix(filter.kindPrefix)}%`);
  }
  if (filter.from !== null) {
    where.push('occurred_at >= ?');
    params.push(filter.from);
  }
  if (filter.to !== null) {
    where.push('occurred_at <= ?');
    params.push(filter.to);
  }
  if (filter.layerId !== null) {
    // `events.metadata` is JSON TEXT — the bus writer always serialises
    // metadata via JSON.stringify, so the `layerId` key (when present)
    // appears literally. Phase 2 keeps the predicate substring-based
    // because the volume is bounded and an indexed JSON column would
    // be a phase-7 perf concern, not a correctness one.
    where.push("metadata LIKE '%' || ? || '%'");
    params.push(`"layerId":"${filter.layerId}"`);
  }
  if (filter.flowId !== null) {
    where.push('flow_id = ?');
    params.push(filter.flowId);
  }
  if (filter.correlationId !== null) {
    where.push('correlation_id = ?');
    params.push(filter.correlationId);
  }
  if (filter.cursor !== null) {
    // Tuple comparison: strictly past the named row, descending.
    // SQLite supports row-value comparisons since 3.15.
    where.push('(occurred_at, id) < (?, ?)');
    params.push(filter.cursor.ts, filter.cursor.id);
  }

  const whereSql = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
  // `LIMIT + 1` so we know whether to issue a next cursor without a
  // second COUNT query.
  const limitPlusOne = filter.limit + 1;
  const sql = `SELECT id, type, occurred_at, correlation_id, flow_id, payload, metadata
                 FROM events
                 ${whereSql}
                ORDER BY occurred_at DESC, id DESC
                LIMIT ?`;
  const rows = db.query<EventRow, typeof params>(sql).all(...params, limitPlusOne);

  const pageRows = rows.slice(0, filter.limit);
  const hasMore = rows.length > filter.limit;
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last !== undefined ? encodeCursor({ ts: last.occurred_at, id: last.id }) : null;

  return {
    rows: pageRows.map(toSummary),
    nextCursor,
  };
}

function toSummary(row: EventRow): EventSummary {
  return {
    id: row.id,
    type: row.type,
    occurredAt: row.occurred_at,
    correlationId: row.correlation_id,
    flowId: row.flow_id,
    payload: row.payload,
    metadata: row.metadata,
  };
}

// ====================================================================
// Phase 3 — /admin/observability/llm-calls (+ /:id, /rollups)
// ====================================================================
//
// Schema (per `apps/server/src/storage/migrations/0001_init.sql`
// + `0018_layer_chat_settings.sql`):
//   llm_calls(id TEXT PK, started_at TEXT, ended_at TEXT, model TEXT,
//             endpoint TEXT, request TEXT, response TEXT, tokens_in
//             INTEGER, tokens_out INTEGER, cost_usd REAL, latency_ms
//             INTEGER, correlation_id TEXT, flow_id TEXT, layer_id TEXT,
//             user_id TEXT, error TEXT, model_source TEXT).
//
// Indexed columns: `started_at`, `correlation_id`. Every filter the
// viewer offers either rides the `started_at` index (range scans
// bounded by `from`/`to`) or filters a few thousand rows after the
// index scan — acceptable at the current single-instance scale. Adding
// new indexes is explicitly deferred to a Phase 7 follow-up (plan §5).

/** Per-payload truncation cap (R3 mitigation, plan §3 wireframe). */
const MAX_PAYLOAD_BYTES = 200 * 1024;
const TRUNCATION_MARKER = '...[truncated; full payload available via API]';
/** Cap linked-events join per detail call so a hot correlation id
 *  cannot blow up the drawer response. */
const MAX_LINKED_EVENTS = 50;
/** Inline `error` preview cap; full text lives in the drawer. */
const ERROR_PREVIEW_CHARS = 200;

type LlmStatusFilter = 'ok' | 'err' | null;

interface LlmCallsFilter {
  readonly model: string | null;
  readonly endpoint: string | null;
  readonly layerId: string | null;
  readonly userId: string | null;
  readonly status: LlmStatusFilter;
  readonly from: string | null;
  readonly to: string | null;
  readonly costMin: number | null;
  readonly latencyMaxMs: number | null;
  readonly limit: number;
  readonly cursor: LlmCallsCursor | null;
}

export interface LlmCallsCursor {
  readonly ts: string;
  readonly id: string;
}

interface LlmCallSqlListRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  model: string;
  endpoint: string;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  correlation_id: string | null;
  flow_id: string | null;
  layer_id: string | null;
  user_id: string | null;
  error: string | null;
  model_source: 'system' | 'layer' | null;
}

interface LlmCallSqlDetailRow extends LlmCallSqlListRow {
  request: string;
  response: string | null;
}

export interface LlmCallListItem {
  readonly id: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly model: string;
  readonly endpoint: string;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly costUsd: number | null;
  readonly latencyMs: number | null;
  readonly correlationId: string | null;
  readonly flowId: string | null;
  readonly layerId: string | null;
  readonly userId: string | null;
  /** Truncated to ~200 chars; full text in the drawer. `null` on success. */
  readonly errorPreview: string | null;
  readonly hasError: boolean;
  readonly modelSource: 'system' | 'layer' | null;
}

export interface LinkedEventSummary {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly correlationId: string | null;
  readonly flowId: string | null;
}

export interface LlmCallDetail extends LlmCallListItem {
  readonly request: string;
  readonly requestTruncated: boolean;
  readonly requestOriginalBytes: number;
  readonly response: string | null;
  readonly responseTruncated: boolean;
  readonly responseOriginalBytes: number;
  readonly error: string | null;
  readonly linkedEvents: readonly LinkedEventSummary[];
}

export interface LlmCallsRollupsResponse {
  readonly window24h: LlmCallsRollupWindow;
  readonly window7d: LlmCallsRollupWindow;
}

export interface LlmCallsRollupWindow {
  readonly count: number;
  readonly errorCount: number;
  /** Returned as a fraction in [0, 1]; web layer formats as percent. */
  readonly errorRate: number;
  readonly totalCostUsd: number;
  /** `null` when no latency rows in the window. */
  readonly p50LatencyMs: number | null;
  readonly p95LatencyMs: number | null;
}

function registerLlmCallsRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: AdminObservabilityRouteDeps,
  now: () => number,
): void {
  // ---------- GET /admin/observability/llm-calls -----------------------

  app.get('/admin/observability/llm-calls', async (c) => {
    const parsed = parseLlmCallsQuery(c.req.query());
    if (parsed.kind === 'error') {
      return c.json({ error: parsed.errorKey }, 400);
    }
    const filter = parsed.filter;
    const startMs = now();

    const { rows, nextCursor } = queryLlmCalls(deps.db, filter);

    const durationMs = Math.max(0, now() - startMs);
    const filterKeys = describeLlmCallsFilterKeys(filter);

    console.log('[admin.observability.llm-calls.query]', {
      event: 'admin.observability.llm-calls.query',
      filterKeys,
      limit: filter.limit,
      hasCursor: filter.cursor !== null,
      rowCount: rows.length,
      durationMs,
    });

    try {
      await deps.bus.publish({
        type: ADMIN_OBSERVABILITY_EVENT_TYPES.LlmCallsQuery,
        payload: {
          durationMs,
          rowCount: rows.length,
          filterKeys,
          limit: filter.limit,
          hasCursor: filter.cursor !== null,
        },
      });
    } catch {
      // Telemetry must never break a read. Swallow.
    }

    return c.json({ rows, nextCursor });
  });

  // ---------- GET /admin/observability/llm-calls/rollups ---------------
  // Registered BEFORE the `:id` route so `rollups` is not interpreted as
  // an id (Hono matches in registration order).

  app.get('/admin/observability/llm-calls/rollups', async (c) => {
    const startMs = now();
    const nowMs = now();
    const rollups = computeLlmCallsRollups(deps.db, nowMs);
    const durationMs = Math.max(0, now() - startMs);

    console.log('[admin.observability.llm-calls.rollups]', {
      event: 'admin.observability.llm-calls.rollups',
      durationMs,
      count24h: rollups.window24h.count,
      count7d: rollups.window7d.count,
    });

    try {
      await deps.bus.publish({
        type: ADMIN_OBSERVABILITY_EVENT_TYPES.LlmCallsRollups,
        payload: {
          durationMs,
          count24h: rollups.window24h.count,
          count7d: rollups.window7d.count,
        },
      });
    } catch {
      // Telemetry must never break a read. Swallow.
    }

    return c.json(rollups);
  });

  // ---------- GET /admin/observability/llm-calls/:id -------------------

  app.get('/admin/observability/llm-calls/:id', async (c) => {
    const id = c.req.param('id');
    if (typeof id !== 'string' || id === '') {
      return c.json({ error: 'errors.admin.observability.notFound' }, 404);
    }
    const startMs = now();
    const detail = queryLlmCallDetail(deps.db, id);
    const durationMs = Math.max(0, now() - startMs);

    if (detail === null) {
      console.log('[admin.observability.llm-calls.detail]', {
        event: 'admin.observability.llm-calls.detail',
        durationMs,
        found: false,
      });
      try {
        await deps.bus.publish({
          type: ADMIN_OBSERVABILITY_EVENT_TYPES.LlmCallsDetail,
          payload: {
            durationMs,
            found: false,
            requestTruncated: false,
            responseTruncated: false,
            linkedEventCount: 0,
          },
        });
      } catch {
        // Swallow.
      }
      return c.json({ error: 'errors.admin.observability.notFound' }, 404);
    }

    console.log('[admin.observability.llm-calls.detail]', {
      event: 'admin.observability.llm-calls.detail',
      durationMs,
      found: true,
      requestTruncated: detail.requestTruncated,
      responseTruncated: detail.responseTruncated,
      linkedEventCount: detail.linkedEvents.length,
    });

    try {
      await deps.bus.publish({
        type: ADMIN_OBSERVABILITY_EVENT_TYPES.LlmCallsDetail,
        payload: {
          durationMs,
          found: true,
          requestTruncated: detail.requestTruncated,
          responseTruncated: detail.responseTruncated,
          linkedEventCount: detail.linkedEvents.length,
        },
      });
    } catch {
      // Swallow.
    }

    return c.json(detail);
  });
}

// ---------- query parser ---------------------------------------------------

type LlmParseResult =
  | { readonly kind: 'ok'; readonly filter: LlmCallsFilter }
  | { readonly kind: 'error'; readonly errorKey: string };

/**
 * Parses the query-string for `GET /admin/observability/llm-calls`.
 * Exported for unit tests.
 */
export function parseLlmCallsQuery(query: Record<string, string | undefined>): LlmParseResult {
  const limit = parseLimit(query.limit);
  const cursor = parseLlmCallsCursor(query.cursor);
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

  const costMin = parseNonNegativeNumber(query.costMin);
  if (costMin === 'invalid') {
    return { kind: 'error', errorKey: 'errors.admin.observability.invalidNumber' };
  }
  const latencyMaxMs = parseNonNegativeNumber(query.latencyMaxMs);
  if (latencyMaxMs === 'invalid') {
    return { kind: 'error', errorKey: 'errors.admin.observability.invalidNumber' };
  }

  const status = parseStatus(query.status);
  if (status === 'invalid') {
    return { kind: 'error', errorKey: 'errors.admin.observability.invalidStatus' };
  }

  return {
    kind: 'ok',
    filter: {
      model: nonEmpty(query.model),
      endpoint: nonEmpty(query.endpoint),
      layerId: nonEmpty(query.layerId),
      userId: nonEmpty(query.userId),
      status,
      from,
      to,
      costMin,
      latencyMaxMs,
      limit,
      cursor,
    },
  };
}

/**
 * Accepts: undefined → `null`, `''` → `null`, finite non-negative
 * number → that number, anything else → `'invalid'`. We reject `NaN`,
 * negatives, and non-numeric strings up front so the SQL parameter
 * binder never receives a garbage value.
 */
function parseNonNegativeNumber(raw: string | undefined): number | null | 'invalid' {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 'invalid';
  return n;
}

function parseStatus(raw: string | undefined): LlmStatusFilter | 'invalid' {
  if (raw === undefined || raw === '') return null;
  if (raw === 'ok' || raw === 'err') return raw;
  return 'invalid';
}

/** Cursor encode for the LLM-calls list. Same scheme as events: base64url(JSON({ts,id})). */
export function encodeLlmCallsCursor(cursor: LlmCallsCursor): string {
  const json = JSON.stringify({ ts: cursor.ts, id: cursor.id });
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function parseLlmCallsCursor(raw: string | undefined): LlmCallsCursor | null | 'invalid' {
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

function describeLlmCallsFilterKeys(filter: LlmCallsFilter): readonly string[] {
  const keys: string[] = [];
  if (filter.model !== null) keys.push('model');
  if (filter.endpoint !== null) keys.push('endpoint');
  if (filter.layerId !== null) keys.push('layerId');
  if (filter.userId !== null) keys.push('userId');
  if (filter.status !== null) keys.push('status');
  if (filter.from !== null) keys.push('from');
  if (filter.to !== null) keys.push('to');
  if (filter.costMin !== null) keys.push('costMin');
  if (filter.latencyMaxMs !== null) keys.push('latencyMaxMs');
  return keys;
}

// ---------- list query -----------------------------------------------------

interface LlmCallsQueryResult {
  readonly rows: readonly LlmCallListItem[];
  readonly nextCursor: string | null;
}

function buildLlmCallsWhereClause(filter: LlmCallsFilter): {
  whereSql: string;
  params: (string | number)[];
} {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.model !== null) {
    where.push('model = ?');
    params.push(filter.model);
  }
  if (filter.endpoint !== null) {
    where.push('endpoint = ?');
    params.push(filter.endpoint);
  }
  if (filter.layerId !== null) {
    where.push('layer_id = ?');
    params.push(filter.layerId);
  }
  if (filter.userId !== null) {
    where.push('user_id = ?');
    params.push(filter.userId);
  }
  if (filter.status === 'ok') where.push('error IS NULL');
  if (filter.status === 'err') where.push('error IS NOT NULL');
  if (filter.from !== null) {
    where.push('started_at >= ?');
    params.push(filter.from);
  }
  if (filter.to !== null) {
    where.push('started_at <= ?');
    params.push(filter.to);
  }
  if (filter.costMin !== null) {
    where.push('cost_usd >= ?');
    params.push(filter.costMin);
  }
  if (filter.latencyMaxMs !== null) {
    where.push('latency_ms <= ?');
    params.push(filter.latencyMaxMs);
  }
  return {
    whereSql: where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`,
    params,
  };
}

function queryLlmCalls(db: Database, filter: LlmCallsFilter): LlmCallsQueryResult {
  const { whereSql, params } = buildLlmCallsWhereClause(filter);
  const conditions: string[] = whereSql === '' ? [] : [whereSql.replace(/^WHERE\s+/, '')];
  if (filter.cursor !== null) {
    conditions.push('(started_at, id) < (?, ?)');
    params.push(filter.cursor.ts, filter.cursor.id);
  }
  const finalWhere = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;

  const limitPlusOne = filter.limit + 1;
  const sql = `SELECT id, started_at, ended_at, model, endpoint,
                      tokens_in, tokens_out, cost_usd, latency_ms,
                      correlation_id, flow_id, layer_id, user_id,
                      error, model_source
                 FROM llm_calls
                 ${finalWhere}
                ORDER BY started_at DESC, id DESC
                LIMIT ?`;
  const rows = db.query<LlmCallSqlListRow, typeof params>(sql).all(...params, limitPlusOne);

  const pageRows = rows.slice(0, filter.limit);
  const hasMore = rows.length > filter.limit;
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    hasMore && last !== undefined
      ? encodeLlmCallsCursor({ ts: last.started_at, id: last.id })
      : null;

  return {
    rows: pageRows.map(toLlmCallListItem),
    nextCursor,
  };
}

function clipError(error: string | null): string | null {
  if (error === null) return null;
  if (error.length <= ERROR_PREVIEW_CHARS) return error;
  return error.slice(0, ERROR_PREVIEW_CHARS);
}

function toLlmCallListItem(row: LlmCallSqlListRow): LlmCallListItem {
  return {
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    model: row.model,
    endpoint: row.endpoint,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costUsd: row.cost_usd,
    latencyMs: row.latency_ms,
    correlationId: row.correlation_id,
    flowId: row.flow_id,
    layerId: row.layer_id,
    userId: row.user_id,
    errorPreview: clipError(row.error),
    hasError: row.error !== null,
    modelSource: row.model_source,
  };
}

// ---------- detail query ---------------------------------------------------

interface TruncationOutcome {
  readonly value: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
}

/**
 * R3 mitigation: server-side per-payload truncation. We size on the
 * UTF-8 byte length of the stored TEXT — that matches what the disk
 * row actually consumed and what a downstream API client would
 * receive. SQLite TEXT is UTF-8 by construction so `Buffer.byteLength`
 * matches the column footprint exactly.
 */
function truncatePayload(raw: string): TruncationOutcome {
  const originalBytes = Buffer.byteLength(raw, 'utf8');
  if (originalBytes <= MAX_PAYLOAD_BYTES) {
    return { value: raw, truncated: false, originalBytes };
  }
  // Slice on a byte boundary to keep the prefix valid UTF-8 even when
  // the payload contains multi-byte sequences at the boundary.
  const buf = Buffer.from(raw, 'utf8');
  const prefixBuf = buf.subarray(0, MAX_PAYLOAD_BYTES);
  // Trim a possible partial trailing UTF-8 sequence so the prefix
  // stays valid. We re-encode via `toString('utf8')` with a tolerant
  // tail — `Buffer.toString` replaces invalid bytes with U+FFFD, so
  // we strip any trailing replacement char to keep the marker
  // visually contiguous with the prefix.
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

function queryLlmCallDetail(db: Database, id: string): LlmCallDetail | null {
  const findStmt = db.query<LlmCallSqlDetailRow, [string]>(
    `SELECT id, started_at, ended_at, model, endpoint, request, response,
            tokens_in, tokens_out, cost_usd, latency_ms,
            correlation_id, flow_id, layer_id, user_id, error, model_source
       FROM llm_calls
      WHERE id = ?`,
  );
  const row = findStmt.get(id);
  if (row === null) return null;

  const list = toLlmCallListItem(row);
  const request = truncatePayload(row.request);
  const responseOutcome =
    row.response === null
      ? { value: null, truncated: false, originalBytes: 0 }
      : truncatePayload(row.response);

  const linkedEvents = row.correlation_id === null ? [] : queryLinkedEvents(db, row.correlation_id);

  return {
    ...list,
    request: request.value,
    requestTruncated: request.truncated,
    requestOriginalBytes: request.originalBytes,
    response: responseOutcome.value,
    responseTruncated: responseOutcome.truncated,
    responseOriginalBytes: responseOutcome.originalBytes,
    error: row.error,
    linkedEvents,
  };
}

function queryLinkedEvents(db: Database, correlationId: string): readonly LinkedEventSummary[] {
  const stmt = db.query<
    {
      id: string;
      type: string;
      occurred_at: string;
      correlation_id: string | null;
      flow_id: string | null;
    },
    [string, number]
  >(
    `SELECT id, type, occurred_at, correlation_id, flow_id
       FROM events
      WHERE correlation_id = ?
      ORDER BY occurred_at DESC, id DESC
      LIMIT ?`,
  );
  const rows = stmt.all(correlationId, MAX_LINKED_EVENTS);
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    occurredAt: row.occurred_at,
    correlationId: row.correlation_id,
    flowId: row.flow_id,
  }));
}

// ---------- rollups --------------------------------------------------------

const MS_PER_HOUR = 60 * 60 * 1000;
const HOURS_24 = 24;
const HOURS_7D = 7 * 24;

/**
 * Rolling 24h + 7d aggregates. SQLite has no `PERCENTILE_CONT`, so we
 * compute `count`, `error_count`, and `sum(cost_usd)` in a single
 * indexed range scan per window, then issue the p50 / p95 latency rows
 * as separate `ORDER BY latency_ms LIMIT 1 OFFSET ?` lookups. The
 * offsets ride the same `WHERE started_at >= ?` index range; the cost
 * is O(N log N) for the sort within the window, which is cheap on the
 * 7-day slice at current single-instance volumes.
 *
 * If `latency_ms` is NULL for every row in the window, the percentile
 * is reported as `null` (consistent with the schema's "honest gap"
 * policy on cost — `cost_usd` is summed with `COALESCE(SUM(...), 0)`
 * so a window with only NULL costs renders as $0, not "?").
 */
function computeLlmCallsRollups(db: Database, nowMs: number): LlmCallsRollupsResponse {
  const cutoff24h = new Date(nowMs - HOURS_24 * MS_PER_HOUR).toISOString();
  const cutoff7d = new Date(nowMs - HOURS_7D * MS_PER_HOUR).toISOString();
  return {
    window24h: computeRollupWindow(db, cutoff24h),
    window7d: computeRollupWindow(db, cutoff7d),
  };
}

function computeRollupWindow(db: Database, cutoff: string): LlmCallsRollupWindow {
  const aggStmt = db.query<
    { n: number; err_n: number; total_cost: number; lat_n: number },
    [string]
  >(
    `SELECT
        COUNT(*)                                                   AS n,
        SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END)         AS err_n,
        COALESCE(SUM(cost_usd), 0)                                 AS total_cost,
        SUM(CASE WHEN latency_ms IS NOT NULL THEN 1 ELSE 0 END)    AS lat_n
       FROM llm_calls
      WHERE started_at >= ?`,
  );
  const agg = aggStmt.get(cutoff);
  const count = agg?.n ?? 0;
  const errorCount = agg?.err_n ?? 0;
  const totalCostUsd = agg?.total_cost ?? 0;
  const latencyCount = agg?.lat_n ?? 0;

  let p50: number | null = null;
  let p95: number | null = null;
  if (latencyCount > 0) {
    p50 = quantileLatency(db, cutoff, latencyCount, 0.5);
    p95 = quantileLatency(db, cutoff, latencyCount, 0.95);
  }

  return {
    count,
    errorCount,
    errorRate: count === 0 ? 0 : errorCount / count,
    totalCostUsd,
    p50LatencyMs: p50,
    p95LatencyMs: p95,
  };
}

function quantileLatency(
  db: Database,
  cutoff: string,
  latencyCount: number,
  quantile: number,
): number | null {
  // Floor + clamp so the offset is always a valid index in [0, n-1].
  const offset = Math.min(latencyCount - 1, Math.max(0, Math.floor(latencyCount * quantile)));
  const stmt = db.query<{ latency_ms: number }, [string, number]>(
    `SELECT latency_ms
       FROM llm_calls
      WHERE started_at >= ? AND latency_ms IS NOT NULL
      ORDER BY latency_ms ASC
      LIMIT 1 OFFSET ?`,
  );
  const row = stmt.get(cutoff, offset);
  return row?.latency_ms ?? null;
}
