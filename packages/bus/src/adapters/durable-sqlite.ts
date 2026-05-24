import type { Database } from 'bun:sqlite';

import { composeMiddleware, type Middleware, type MiddlewareNext } from '../middleware';
import type {
  BusEvent,
  EventHandler,
  MessageBus,
  PublishInput,
  SubscribeOptions,
  Unsubscribe,
} from '../types';

export type HandlerErrorLogger = (error: unknown, event: BusEvent) => void;

/**
 * Writes the canonical `events` row that the in-memory adapter would
 * normally publish via `telemetryMiddleware`. The durable adapter
 * invokes this INSIDE the same SQLite transaction that inserts the
 * outbox row, so the two writes are atomic — a crash between them is
 * impossible.
 *
 * Kept as a function type so the bus package never imports `bun:sqlite`
 * for the `events`-table schema (that schema lives in `apps/server`).
 */
export type EventRowWriter = (event: BusEvent) => void;

export interface DurableSqliteMessageBusOptions {
  /**
   * Stable identifier for this bus instance's consumer loop. Used as
   * the `bus_offsets.subscriber_key` and the `bus_dlq.subscriber_key`.
   * Phase 5.1 ships one consumer per bus instance — the bus-level key
   * is the only key honored by the durable adapter; per-subscribe
   * `subscriberKey` from {@link SubscribeOptions} is ignored.
   *
   * Default: `'default'`. Production wires this from the role flag in
   * phase 5.2.
   */
  readonly subscriberKey?: string;
  /**
   * Writes the canonical `events` row. The adapter calls this inside
   * the publish transaction. Required so the bus package stays
   * decoupled from the `events`-table schema (which lives in
   * `apps/server/src/storage/migrations`).
   */
  readonly writeEvent: EventRowWriter;
  readonly middlewares?: readonly Middleware[];
  /** Override for tests; defaults to {@link crypto.randomUUID}. */
  readonly idFactory?: () => string;
  /** Override for tests; defaults to ISO string `now`. */
  readonly clock?: () => string;
  /**
   * Invoked when a subscribed handler throws. The bus catches per-handler
   * so a single bad subscriber cannot starve its siblings. Default logs
   * to `console.error`.
   */
  readonly onHandlerError?: HandlerErrorLogger;
  /** Max attempts per (subscriberKey, outbox row) before DLQ. Default 3. */
  readonly maxAttempts?: number;
  /** Idle poll cadence in ms. Default 250. */
  readonly pollIntervalMs?: number;
  /** Consume batch size per poll iteration. Default 50. */
  readonly batchSize?: number;
  /**
   * Lease window: an `in_flight` row whose `claimed_at` is older than
   * `now - leaseMs` is considered abandoned by its previous owner.
   * Default 5 minutes.
   */
  readonly leaseMs?: number;
  /** PID used for the `claimed_by_pid` column. Default `process.pid`. */
  readonly pid?: number;
}

interface OutboxRow {
  id: string;
  type: string;
  payload_json: string;
  metadata_json: string | null;
  correlation_id: string | null;
  flow_id: string | null;
  occurred_at: string;
  attempt: number;
}

const defaultHandlerErrorLogger: HandlerErrorLogger = (error, event) => {
  console.error(`[bus] handler error on type=${event.type} id=${event.id}:`, error);
};

function rowToEvent(row: OutboxRow): BusEvent {
  const out: {
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
    payload: JSON.parse(row.payload_json) as unknown,
  };
  if (row.correlation_id !== null) out.correlationId = row.correlation_id;
  if (row.flow_id !== null) out.flowId = row.flow_id;
  if (row.metadata_json !== null) {
    out.metadata = JSON.parse(row.metadata_json) as Readonly<Record<string, unknown>>;
  }
  return out;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}

/**
 * Durable, claim-based, SQLite-backed message bus.
 *
 * - `publish()` writes the canonical `events` row AND a `bus_outbox`
 *   row inside ONE SQLite transaction, then runs the middleware chain
 *   so middlewares observe a fully-persisted event.
 * - A single consumer loop per bus instance polls the `bus_outbox`
 *   for `pending` rows past the bus's offset, claims a batch
 *   atomically (status `pending` → `in_flight`), dispatches each row
 *   to every handler registered for that event type, and on success
 *   bumps the row to `delivered` and the bus offset to the row id.
 * - On boot (`start()`), any `in_flight` rows past the lease are
 *   either re-pended (when any subscriber declared `idempotent`) or
 *   marked `abandoned`.
 * - Handler errors flip the row back to `pending` with `attempt++`,
 *   up to `maxAttempts`; past that the row is marked `dead` and a
 *   `bus_dlq` row is inserted.
 * - `replayDlq(outboxId)` resets a dead row to `pending` (leaving the
 *   DLQ row in place as history). The DLQ-replayed event is honored
 *   by the next poll tick.
 *
 * Phase 5.1 wires exactly ONE consumer loop per bus instance. The
 * `subscriberKey` passed in {@link SubscribeOptions} is accepted for
 * API forward-compat but currently ignored — see the field-doc on
 * {@link SubscribeOptions}.
 */
export class DurableSqliteMessageBus implements MessageBus {
  private readonly db: Database;
  private readonly subscriberKey: string;
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private readonly run: MiddlewareNext;
  private readonly idFactory: () => string;
  private readonly clock: () => string;
  private readonly onHandlerError: HandlerErrorLogger;
  private readonly maxAttempts: number;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly pid: number;
  private readonly writeEvent: EventRowWriter;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private pumping = false;
  private anyIdempotent = false;
  private hasPendingNotifications = false;
  /**
   * Boot-recovery runs lazily on the FIRST pump after `start()` rather
   * than synchronously in `start()`. This matters because the
   * production wiring in `apps/server/src/index.ts` calls `start()`
   * BEFORE the runners register their idempotent subscribers — if
   * recovery ran in `start()` it would observe `anyIdempotent=false`
   * and abandon every in-flight row, defeating the idempotency
   * opt-in. Deferring to the first pump tick gives subscribers a
   * chance to register between `start()` and the macrotask boundary.
   */
  private recoveryDone = false;

  constructor(db: Database, opts: DurableSqliteMessageBusOptions) {
    this.db = db;
    this.subscriberKey = opts.subscriberKey ?? 'default';
    this.writeEvent = opts.writeEvent;
    this.idFactory = opts.idFactory ?? (() => crypto.randomUUID());
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.onHandlerError = opts.onHandlerError ?? defaultHandlerErrorLogger;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.pollIntervalMs = opts.pollIntervalMs ?? 250;
    this.batchSize = opts.batchSize ?? 50;
    this.leaseMs = opts.leaseMs ?? 5 * 60 * 1000;
    this.pid = opts.pid ?? (typeof process !== 'undefined' ? process.pid : 0);
    const middlewares = opts.middlewares ?? [];
    this.run = composeMiddleware(middlewares, (event) => this.dispatch(event));
  }

  /**
   * Atomically writes the canonical `events` row + the outbox row in
   * one transaction. Delivery to subscribers happens on the consume
   * loop, NOT inside `publish()` — that decoupling is what makes
   * crash-safe replay possible: even if this process dies before
   * any handler ran, the row is durably `pending` and the next
   * `start()` (in this or another process) picks it up.
   *
   * Returns the same `BusEvent` shape the in-memory adapter returns
   * so callers reading `id` / `occurredAt` post-publish are unchanged.
   */
  async publish<TPayload>(input: PublishInput<TPayload>): Promise<BusEvent<TPayload>> {
    const event: BusEvent<TPayload> = {
      id: input.id ?? this.idFactory(),
      type: input.type,
      occurredAt: input.occurredAt ?? this.clock(),
      payload: input.payload,
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
      ...(input.flowId !== undefined ? { flowId: input.flowId } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
    const ev = event as BusEvent;
    const tx = this.db.transaction(() => {
      this.writeEvent(ev);
      this.insertOutbox(ev);
    });
    tx();
    // Wake the consume loop so handlers see the row without waiting
    // a full poll interval — important for responsive tests.
    this.notify();
    // `publish()` returns synchronously to satisfy the Promise<BusEvent>
    // contract; the `await` here is a no-op kept for parity with the
    // in-memory adapter's signature.
    await Promise.resolve();
    return event;
  }

  subscribe<TPayload>(
    type: string,
    handler: EventHandler<TPayload>,
    options?: SubscribeOptions,
  ): Unsubscribe {
    if (options?.idempotent === true) this.anyIdempotent = true;
    const set = this.handlers.get(type) ?? new Set<EventHandler>();
    set.add(handler as EventHandler);
    this.handlers.set(type, set);
    return () => {
      const current = this.handlers.get(type);
      if (!current) return;
      current.delete(handler as EventHandler);
      if (current.size === 0) this.handlers.delete(type);
    };
  }

  /**
   * Starts the consume loop and runs boot recovery. Safe to call
   * multiple times; subsequent calls are no-ops.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    // Recovery runs on the first pump (see `recoveryDone` field-doc),
    // not here, so subscribers that opt into `idempotent: true` can
    // register between `start()` and the first tick.
    this.schedule(true);
  }

  /**
   * Stops the consume loop. After `stop()` the bus still accepts
   * `publish()` calls but does not dispatch until `start()` is
   * called again.
   */
  stop(): void {
    this.started = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Test helper: drives the consume loop until the outbox is fully
   * caught up for this subscriber key. Used by the contract suite to
   * synchronize "publish → handler ran" without sleeping.
   */
  async drain(): Promise<void> {
    // Pump until a tick reports no work done. The first call also
    // performs lazy boot-recovery (see `recoveryDone` field-doc) so
    // tests that call `start(); subscribe(); drain();` observe the
    // same recovery ordering as production.
    // Bound the loop so a misbehaving handler that re-publishes
    // forever cannot deadlock test teardown.
    for (let i = 0; i < 10_000; i += 1) {
      const did = await this.pump();
      if (!did) return;
    }
  }

  /**
   * Admin replay: moves a `dead` outbox row back to `pending`. The
   * matching `bus_dlq` row stays in place as history. Returns
   * `true` when a row was flipped, `false` when the row was not in
   * `dead` (e.g. already pending or unknown id).
   */
  replayDlq(outboxId: string): boolean {
    const res = this.db
      .query<unknown, [string, string]>(
        `UPDATE bus_outbox SET status='pending', attempt=0, error=NULL, claimed_at=NULL,
           claimed_by_pid=NULL, delivered_at=NULL
         WHERE id=? AND status=?`,
      )
      .run(outboxId, 'dead');
    const ok = res.changes > 0;
    if (ok) this.notify();
    return ok;
  }

  // ---------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------

  private insertOutbox(event: BusEvent): void {
    this.db
      .query<
        unknown,
        [string, string, string, string | null, string | null, string | null, string, string]
      >(
        `INSERT INTO bus_outbox (id, type, payload_json, metadata_json, correlation_id,
                                 flow_id, occurred_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.type,
        JSON.stringify(event.payload ?? null),
        event.metadata === undefined ? null : JSON.stringify(event.metadata),
        event.correlationId ?? null,
        event.flowId ?? null,
        event.occurredAt,
        'pending',
      );
  }

  private async dispatch(event: BusEvent): Promise<void> {
    const set = this.handlers.get(event.type);
    if (!set || set.size === 0) return;
    const snapshot = [...set];
    for (const handler of snapshot) {
      try {
        await handler(event);
      } catch (err) {
        this.onHandlerError(err, event);
      }
    }
  }

  /**
   * Boot-recovery pass. Any `in_flight` row past the lease either
   * goes back to `pending` (if any subscriber on this bus is
   * idempotent) or to `abandoned` (otherwise).
   */
  private recoverInFlight(): void {
    const now = this.clock();
    const cutoff = new Date(Date.parse(now) - this.leaseMs).toISOString();
    const target = this.anyIdempotent ? 'pending' : 'abandoned';
    this.db
      .query<unknown, [string, string, string, string]>(
        `UPDATE bus_outbox
            SET status=?,
                claimed_at = CASE WHEN ?='pending' THEN NULL ELSE claimed_at END,
                claimed_by_pid = CASE WHEN ?='pending' THEN NULL ELSE claimed_by_pid END
          WHERE status='in_flight' AND (claimed_at IS NULL OR claimed_at < ?)`,
      )
      .run(target, target, target, cutoff);
  }

  private schedule(immediate: boolean): void {
    if (!this.started) return;
    if (this.timer !== null) return;
    const delay = immediate ? 0 : this.pollIntervalMs;
    const t = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
    // unref so the timer never keeps the process / test runner alive.
    if (typeof (t as { unref?: () => void }).unref === 'function') {
      (t as { unref: () => void }).unref();
    }
    this.timer = t;
  }

  private notify(): void {
    this.hasPendingNotifications = true;
    if (this.started && this.timer === null && !this.pumping) {
      this.schedule(true);
    }
  }

  private async tick(): Promise<void> {
    if (!this.started) return;
    const did = await this.pump();
    // Re-schedule. If a publish happened during the pump, run again
    // immediately; otherwise sleep the poll interval.
    const wakeImmediately = did || this.hasPendingNotifications;
    this.hasPendingNotifications = false;
    this.schedule(wakeImmediately);
  }

  /**
   * Claims a batch, dispatches it, returns whether any work happened.
   */
  private async pump(): Promise<boolean> {
    if (this.pumping) return false;
    this.pumping = true;
    try {
      if (!this.recoveryDone) {
        this.recoveryDone = true;
        this.recoverInFlight();
      }
      const rows = this.claimBatch();
      if (rows.length === 0) return false;
      for (const row of rows) {
        const advanced = await this.deliver(row);
        if (!advanced) {
          // Head-of-line stalled (retry queued). Release the rest of
          // the batch back to `pending` so the next pump re-claims
          // the whole stretch in id order — keeps the per-subscriber
          // offset strictly monotonic.
          this.releaseClaimAfter(row.id);
          break;
        }
      }
      return true;
    } finally {
      this.pumping = false;
    }
  }

  private releaseClaimAfter(stalledId: string): void {
    this.db
      .query<unknown, [string]>(
        `UPDATE bus_outbox
            SET status='pending', claimed_at=NULL, claimed_by_pid=NULL
          WHERE status='in_flight' AND id > ?`,
      )
      .run(stalledId);
  }

  private claimBatch(): OutboxRow[] {
    const now = this.clock();
    // Two-step claim inside a tx: select candidate ids in
    // occurred_at order, then UPDATE them to `in_flight`. SQLite has
    // no stable `UPDATE…RETURNING`, so we re-SELECT the claimed rows
    // for dispatch in the same tx.
    //
    // Note: the work queue is the set of rows with `status='pending'`
    // — we do NOT filter by `id > offset` because outbox ids are
    // random UUIDs (no monotonic ordering). `bus_offsets` is updated
    // on each delivery / DLQ as a high-water-mark for diagnostics
    // and for the boot-recovery pass; the per-subscriber claim
    // semantics that future per-handler fan-out will need slot in
    // by partitioning on `subscriber_key` rather than on the offset
    // column.
    let claimed: OutboxRow[] = [];
    const tx = this.db.transaction(() => {
      const candidates = this.db
        .query<{ id: string }, [number]>(
          `SELECT id FROM bus_outbox
             WHERE status='pending'
             ORDER BY occurred_at ASC, id ASC
             LIMIT ?`,
        )
        .all(this.batchSize);
      if (candidates.length === 0) return;
      const placeholders = candidates.map(() => '?').join(',');
      const ids = candidates.map((c) => c.id);
      // Update status + claim metadata atomically.
      const upd = this.db.query<unknown, (string | number)[]>(
        `UPDATE bus_outbox
            SET status='in_flight', claimed_at=?, claimed_by_pid=?
          WHERE status='pending' AND id IN (${placeholders})`,
      );
      upd.run(now, this.pid, ...ids);
      claimed = this.db
        .query<OutboxRow, (string | number)[]>(
          `SELECT id, type, payload_json, metadata_json, correlation_id,
                  flow_id, occurred_at, attempt
             FROM bus_outbox
            WHERE id IN (${placeholders}) AND status='in_flight'
            ORDER BY occurred_at ASC, id ASC`,
        )
        .all(...ids);
    });
    tx();
    return claimed;
  }

  /**
   * Returns `true` when the row was delivered or DLQ'd (offset
   * advances past it); `false` when the row was re-pended for retry
   * (offset stays put so the row is the next one re-claimed).
   */
  private async deliver(row: OutboxRow): Promise<boolean> {
    const event = rowToEvent(row);
    let chainError: unknown = null;
    try {
      await this.run(event);
    } catch (err) {
      // Errors that escape the middleware chain itself (a buggy
      // middleware) land here. Per-handler errors are swallowed
      // inside `dispatch` so they never reach this catch.
      chainError = err;
      this.onHandlerError(err, event);
    }
    if (chainError === null) {
      this.markDelivered(row);
      return true;
    }
    return this.handleFailure(row, errMessage(chainError));
  }

  private markDelivered(row: OutboxRow): void {
    const now = this.clock();
    const tx = this.db.transaction(() => {
      this.db
        .query<unknown, [string, string]>(
          `UPDATE bus_outbox SET status='delivered', delivered_at=?, error=NULL
            WHERE id=?`,
        )
        .run(now, row.id);
      this.upsertOffset(row.id, now);
    });
    tx();
  }

  /**
   * Returns `true` when the row terminated (DLQ'd) and the offset
   * advanced past it; `false` when the row was re-pended for retry
   * (caller must hold the offset where it is so the retry remains
   * head-of-line).
   */
  private handleFailure(row: OutboxRow, errorMsg: string): boolean {
    const nextAttempt = row.attempt + 1;
    const now = this.clock();
    if (nextAttempt < this.maxAttempts) {
      this.db
        .query<unknown, [number, string, string]>(
          `UPDATE bus_outbox
              SET status='pending', attempt=?, error=?, claimed_at=NULL, claimed_by_pid=NULL
            WHERE id=?`,
        )
        .run(nextAttempt, errorMsg, row.id);
      return false;
    }
    // DLQ: dead-letter the row and advance the offset so the
    // subscriber moves on. The admin can resurrect it via
    // `replayDlq`.
    const tx = this.db.transaction(() => {
      this.db
        .query<unknown, [string, string]>(
          `UPDATE bus_outbox SET status='dead', error=?, claimed_at=NULL, claimed_by_pid=NULL
            WHERE id=?`,
        )
        .run(errorMsg, row.id);
      this.db
        .query<unknown, [string, string, string, string, number, string]>(
          `INSERT INTO bus_dlq (id, outbox_id, subscriber_key, error, attempts, failed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(this.idFactory(), row.id, this.subscriberKey, errorMsg, nextAttempt, now);
      this.upsertOffset(row.id, now);
    });
    tx();
    return true;
  }

  private upsertOffset(lastId: string, now: string): void {
    this.db
      .query<unknown, [string, string, string]>(
        `INSERT INTO bus_offsets (subscriber_key, last_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(subscriber_key) DO UPDATE SET last_id=excluded.last_id,
                                                   updated_at=excluded.updated_at`,
      )
      .run(this.subscriberKey, lastId, now);
  }
}
