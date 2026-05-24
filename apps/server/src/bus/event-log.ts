import type { Database } from 'bun:sqlite';
import type { BusEvent, TelemetryWriter } from '@bunny2/bus';

/**
 * Inserts a single `events` row. Plain function (no prepared-statement
 * cache) so it can be called inside any `db.transaction(...)` block,
 * including the one the durable bus uses to write the outbox row in
 * the same SQLite transaction as the canonical event log row.
 *
 * Column names match the migration in
 * `apps/server/src/storage/migrations/0001_init.sql`.
 */
export function writeEventRow(db: Database, event: BusEvent): void {
  db.query<unknown, [string, string, string, string | null, string | null, string, string | null]>(
    `INSERT INTO events (id, type, occurred_at, correlation_id, flow_id, payload, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.id,
    event.type,
    event.occurredAt,
    event.correlationId ?? null,
    event.flowId ?? null,
    JSON.stringify(event.payload ?? null),
    event.metadata === undefined ? null : JSON.stringify(event.metadata),
  );
}

/**
 * Persists bus events to the `events` table. Column names match the
 * migration in `apps/server/src/storage/migrations/0001_init.sql`.
 *
 * Returned writer is intended to be passed to `telemetryMiddleware`
 * for the in-memory bus fixture used by tests. Production (the
 * durable adapter) writes the same `events` row INSIDE its publish
 * transaction via {@link writeEventRow} so the outbox + event-log
 * insertion is atomic.
 */
export function createSqliteEventLog(db: Database): {
  writer: TelemetryWriter;
  count: () => number;
} {
  const countStmt = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM events');

  const writer: TelemetryWriter = (event) => {
    writeEventRow(db, event);
  };

  return {
    writer,
    count: () => countStmt.get()?.n ?? 0,
  };
}

export interface ReplayOptions {
  readonly type?: string;
  readonly since?: string; // ISO timestamp inclusive
  readonly until?: string; // ISO timestamp inclusive
  readonly limit?: number;
}

interface EventRow {
  id: string;
  type: string;
  occurred_at: string;
  correlation_id: string | null;
  flow_id: string | null;
  payload: string;
  metadata: string | null;
}

function rowToEvent(row: EventRow): BusEvent {
  const event: {
    id: string;
    type: string;
    occurredAt: string;
    payload: unknown;
    correlationId?: string;
    flowId?: string;
    metadata?: Readonly<Record<string, unknown>>;
  } = {
    id: row.id,
    type: row.type,
    occurredAt: row.occurred_at,
    payload: JSON.parse(row.payload) as unknown,
  };
  if (row.correlation_id !== null) event.correlationId = row.correlation_id;
  if (row.flow_id !== null) event.flowId = row.flow_id;
  if (row.metadata !== null) {
    event.metadata = JSON.parse(row.metadata) as Readonly<Record<string, unknown>>;
  }
  return event;
}

/**
 * Yields events in `(occurred_at, id)` order, optionally filtered by type
 * and/or time range. Filtering happens in SQL so we don't pull the full log
 * into memory.
 */
export function* replayEvents(db: Database, opts: ReplayOptions = {}): Generator<BusEvent> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.type !== undefined) {
    where.push('type = ?');
    params.push(opts.type);
  }
  if (opts.since !== undefined) {
    where.push('occurred_at >= ?');
    params.push(opts.since);
  }
  if (opts.until !== undefined) {
    where.push('occurred_at <= ?');
    params.push(opts.until);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limitSql = opts.limit !== undefined ? `LIMIT ${Math.max(0, Math.floor(opts.limit))}` : '';
  const sql = `SELECT id, type, occurred_at, correlation_id, flow_id, payload, metadata
               FROM events
               ${whereSql}
               ORDER BY occurred_at ASC, id ASC
               ${limitSql}`;
  const rows = db.query<EventRow, typeof params>(sql).all(...params);
  for (const row of rows) {
    yield rowToEvent(row);
  }
}
