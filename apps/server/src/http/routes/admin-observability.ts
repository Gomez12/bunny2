import type { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import type { HonoVariables } from '../types';

/**
 * Phase 2 of `docs/dev/plans/admin-observability-viewer.md` —
 * `/admin/observability/*` admin viewer endpoints.
 *
 * This file owns the read-only routes that expose canonical
 * observability tables to admins. Phase 2 wires only the events
 * viewer; Phases 3–4 will append `llm-calls` and `chat-runs`
 * handlers alongside it.
 *
 * All routes sit behind the `/admin/*` `requireAdmin` gate mounted
 * in `router.ts`, so every handler can assume the caller is a
 * verified site admin.
 *
 * Per-route observability contract (plan §11 + §12):
 *   - Entry log: `console.log('[admin.observability.events.query]',
 *     { event, filter, … })` — filter set only, no row content.
 *   - Telemetry: a bus event of the same name carrying
 *     `{ durationMs, rowCount, filterKeys }` so a SELECT against
 *     `events` can answer "how often did admins hit the viewer and
 *     how heavy were the queries".
 *
 * Column-level redaction (per
 * `docs/dev/audits/admin-observability-redaction-2026-05-25.md`):
 * `payload` and `metadata` are returned as raw JSON strings on the
 * detail-row path; the viewer renders them in a collapsed `<pre>`
 * inside a drawer, never inline.
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
