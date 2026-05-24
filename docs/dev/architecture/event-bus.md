# Event Bus

> Status: living document.
> Owners: phase 1.3 introduced this; phase 5 made the bus durable.
> Source code: `packages/bus/`, `apps/server/src/bus/`,
> `apps/server/src/storage/migrations/0013_durable_bus.sql`.

This document describes the event bus that powers bunny2's
event-sourced core. Every state-changing action in the product
flows through it; the SQLite `events` table is the canonical event
log from which any read model can be rebuilt, and the
`bus_outbox` / `bus_offsets` / `bus_dlq` triple is the durable
delivery ledger that lets a worker take over from a crashed
publisher without losing data.

The phase-5 rewrite supersedes the "in-memory only" framing of the
phase-1.3 doc; see ADR
[`0019`](../decisions/0019-durable-sqlite-message-bus.md) for the
trigger and ADR [`0005`](../decisions/0005-event-sourcing-and-bunqueue.md)
for the original interface decision (still in force; only the
adapter changed).

---

## 1. Goals

1. **Durable publish.** Every `publish()` commits its event to
   SQLite before resolving. If the process dies the next consumer
   picks the row up.
2. **Crash-safe consume.** A handler killed mid-run can replay its
   claim on next boot if the subscriber is idempotent; otherwise
   the row is `abandoned` and an admin signal fires.
3. **Multi-process on one host.** `--role=web` publishes,
   `--role=worker` consumes, both share the SQLite file.
4. **Adapter-pluggable.** The `MessageBus` interface has no DB or
   transport dependencies. Today: `DurableSqliteMessageBus` in
   production, `InMemoryMessageBus` in tests. Tomorrow: anything
   else that fits the interface and passes the contract suite.
5. **Deterministic in tests.** Sequential per-handler dispatch +
   injectable `idFactory`/`clock` keep tests race-free.

---

## 2. Interface

```ts
interface BusEvent<TPayload = unknown> {
  readonly id: string; // UUID, assigned by the bus on publish
  readonly type: string; // dotted, e.g. "chat.requested"
  readonly occurredAt: string; // ISO timestamp, assigned by the bus
  readonly correlationId?: string;
  readonly flowId?: string;
  readonly payload: TPayload;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface PublishInput<TPayload = unknown> {
  readonly type: string;
  readonly payload: TPayload;
  readonly id?: string;
  readonly occurredAt?: string;
  readonly correlationId?: string;
  readonly flowId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface SubscribeOptions {
  /** Stable id used by the durable adapter for offset + DLQ bookkeeping. */
  readonly subscriberKey?: string;
  /** Opt in to replay of `in_flight` rows past the lease window. */
  readonly idempotent?: boolean;
}

interface MessageBus {
  publish<T>(input: PublishInput<T>): Promise<BusEvent<T>>;
  subscribe<T>(type: string, handler: EventHandler<T>, options?: SubscribeOptions): Unsubscribe;
}
```

Key contract guarantees:

- `id` and `occurredAt` are assigned at `publish()` entry, before
  any middleware runs.
- Handlers run **sequentially in registration order** so the chain
  order is observable in tests and derived work cannot accidentally
  race.
- Per-handler isolation: a handler that throws is reported via
  `onHandlerError` (default: `console.error`) but does not skip
  its siblings.
- In the durable adapter, `subscribe(...)` does NOT mean "deliver
  every event from this point". It means "deliver every event past
  the `bus_offsets.last_id` for the adapter's configured
  `subscriberKey`". Boot recovery is the consequence.

---

## 3. Production adapter — `DurableSqliteMessageBus`

`packages/bus/src/adapters/durable-sqlite.ts`. Single production
adapter; every role (`web`, `worker`, `all`) and the Electron
sidecar binds to it. Backed by three tables:

```
bus_outbox
  id              TEXT PRIMARY KEY     -- same id as the events row
  type, payload_json, metadata_json
  correlation_id, flow_id, occurred_at
  status          pending | in_flight | delivered | dead | abandoned
  attempt         INTEGER
  claimed_at, claimed_by_pid          -- lease
  delivered_at, error
  -- idx_bus_outbox_pending(status, occurred_at) WHERE status
  --   IN ('pending', 'in_flight')

bus_offsets
  subscriber_key  TEXT PRIMARY KEY
  last_id         TEXT NOT NULL
  updated_at      TEXT NOT NULL

bus_dlq
  id              TEXT PRIMARY KEY    -- new uuid per dead row
  outbox_id       TEXT NOT NULL REFERENCES bus_outbox(id)
  subscriber_key  TEXT NOT NULL
  error           TEXT NOT NULL
  attempts        INTEGER NOT NULL
  failed_at       TEXT NOT NULL
  -- idx_bus_dlq_subscriber(subscriber_key, failed_at DESC)
```

### 3.1 Publish (atomic)

```
BEGIN
  INSERT INTO events     (...)   -- canonical event log
  INSERT INTO bus_outbox (...)   -- delivery ledger
COMMIT
```

Atomic, single SQLite transaction. The `events` write is inlined
into the adapter via a `writeEvent` callback the server hands in at
construction time — the old `telemetryMiddleware(eventLog.writer)`
pattern is gone in production wiring because it would have written
the `events` row outside the outbox transaction.

### 3.2 Consume (claim → handle → commit)

```
loop (every 250 ms when idle, batch 50):
  UPDATE bus_outbox
     SET status='in_flight', claimed_at=now, claimed_by_pid=pid
   WHERE id IN (
     SELECT id FROM bus_outbox
      WHERE status='pending'
        AND id > (SELECT last_id FROM bus_offsets
                   WHERE subscriber_key = :key)
      ORDER BY id ASC
      LIMIT batch
   )
  for each claimed row:
    try:
      await handler(event)
      UPDATE bus_outbox SET status='delivered', delivered_at=now WHERE id=:id
      UPSERT bus_offsets last_id=:id
    catch err:
      attempt += 1
      if attempt < maxAttempts:
        UPDATE bus_outbox SET status='pending', attempt=:n, error=:msg WHERE id=:id
      else:
        INSERT INTO bus_dlq (...)
        UPDATE bus_outbox SET status='dead' WHERE id=:id
        -> onDlqAdded(...) hook fires after commit
```

One consumer per `subscriberKey` — two consumers of the same key
would step on each other's offset row. Phase 5 ships one process
per role; multi-host sharding stays deferred (ADR 0019).

### 3.3 Boot recovery

On `start()` the adapter walks `bus_outbox WHERE status='in_flight'
AND claimed_at < now - leaseMs`. For each row:

- Any subscriber declared `{ idempotent: true }` → `status='pending'`
  again. The handler may run twice; the handler is expected to
  dedup (the scheduled-task run row, the entity store's upsert by
  id, the layer subscribers' set-based reads are all idempotent).
- Otherwise → `status='abandoned'`, `bus.abandoned` admin signal
  fires.

### 3.4 DLQ surface

`POST /admin/bus/dlq/:id/replay` re-inserts the row as `pending`
with `attempt=0`. The matching `bus_dlq` row stays in place as
history.

The adapter exposes an `onDlqAdded` after-commit hook so the
server can publish `bus.dlq.added` without coupling the bus
package to domain-event naming. The publish is fire-and-forget; a
throw inside the notifier is logged and swallowed.

### 3.5 Middleware chain

A middleware is `(event, next) => Promise<void>`. The production
wiring is:

```
correlationIdMiddleware
  → errorCaptureMiddleware
    → handler dispatch (terminal)
```

The phase-1 `telemetryMiddleware(eventLog.writer)` is **not** in
this chain — the adapter writes the `events` row inside the
outbox transaction directly. Removing it from the middleware
chain is the only call-site impact of the phase-5 switch.

`errorCaptureMiddleware` logs and swallows. The adapter already
isolates per-handler failures; this middleware catches anything
the middleware chain itself throws. **Middleware-chain errors are
the only thing that lands in `bus_dlq`** — handler-application
errors (e.g. a scheduled-task handler throwing) are caught inside
the dispatch and routed through the handler's own error surface
(the run subscriber writes `scheduledtask.run.failed`).

---

## 4. Event log + replay

`apps/server/src/bus/event-log.ts`:

- `writeEventRow(db, event)` — the function the durable adapter
  uses to insert the `events` row inside its publish transaction.
- `createSqliteEventLog(db).count()` — the simple counter the
  `/status` endpoint surfaces.
- `replayEvents(db, opts)` — generator over `events` ordered by
  `(occurred_at, id)`, used by `bun run replay`.

`scripts/replay.ts` opens the DB via the same config loader,
constructs a fresh `InMemoryMessageBus` (replay is a test-shaped
operation, not a production-shape one), subscribes a counting
handler per observed type, and re-publishes every event. The
outbox is **not** the replay source — `events` is.

---

## 5. Scheduled-task event taxonomy

Phase 5.3 introduces the `scheduledtask.*` family.
`apps/server/src/scheduled/events.ts` exports
`SCHEDULED_TASK_EVENT_TYPES` so the closed set is
machine-checkable. Full schemas in
[`scheduled-tasks.md`](./scheduled-tasks.md) §4; reproduced here
for cross-reference:

| Type                          | Payload (summary)                                                   |
| ----------------------------- | ------------------------------------------------------------------- |
| `scheduledtask.created`       | `{ taskId, layerId, kind, slug, scheduleKind, createdBy }`          |
| `scheduledtask.updated`       | `{ taskId, patch, updatedBy }`                                      |
| `scheduledtask.deleted`       | `{ taskId, slug, deletedBy }`                                       |
| `scheduledtask.paused`        | `{ taskId, reason: 'manual' \| 'max_attempts', actorId }`           |
| `scheduledtask.resumed`       | `{ taskId, resumedBy }`                                             |
| `scheduledtask.run.requested` | `{ taskId, runId, kind, layerId, triggeredBy, attempt }`            |
| `scheduledtask.run.started`   | `{ taskId, runId }`                                                 |
| `scheduledtask.run.succeeded` | `{ taskId, runId, durationMs }`                                     |
| `scheduledtask.run.failed`    | `{ taskId, runId, error, attempt, willRetry, nextRunAt }`           |
| `scheduledtask.run.skipped`   | `{ taskId, runId, reason: 'offline' \| 'no_handler' \| 'crashed' }` |

Plus the bus's own DLQ family:

| Type               | When                                     | Payload                                              |
| ------------------ | ---------------------------------------- | ---------------------------------------------------- |
| `bus.dlq.added`    | Durable adapter moved a row to `bus_dlq` | `{ outboxId, subscriberKey, type, attempts, error }` |
| `bus.dlq.replayed` | Admin replayed a DLQ row                 | `{ outboxId, subscriberKey, replayedBy }`            |

Anti-leak invariants:

- `error` strings are clipped to a fixed length; no stack traces in
  payloads.
- `bus.dlq.*` events carry the event `type` and the
  `subscriberKey` but **not** the payload — payloads stay in
  `bus_outbox.payload_json`, accessible only to admins via the DLQ
  page.

---

## 6. How to add a new event type

1. Pick a stable dotted name (`<domain>.<verb>`, past tense,
   English): `chat.requested`, `todo.created`,
   `scheduledtask.run.succeeded`.
2. Define a payload type in `packages/shared/` so producers and
   consumers share the shape. Keep payloads serialisable JSON.
3. Publish: `await bus.publish({ type, payload, correlationId })`.
   If you already have a `correlationId` from the caller (e.g. an
   HTTP request id), pass it — `correlationIdMiddleware` only mints
   one when it is absent.
4. Subscribe with a stable `subscriberKey`:
   ```ts
   bus.subscribe<MyPayload>('my.event', handler, {
     subscriberKey: 'my-domain.consumer',
     idempotent: true,
   });
   ```
5. Add tests: at minimum the contract suite proves the event lands
   in `events` + `bus_outbox` atomically; add a per-handler test
   for the consume side.

---

## 7. Phase 1 + 2 + 3 + 4 event types

Catalogued here for one-stop reference; producer narratives live in
each phase's architecture doc.

### Phase 1 — chat

| Type             | Payload                                              |
| ---------------- | ---------------------------------------------------- |
| `chat.requested` | `{ message: string; model: string \| null }`         |
| `chat.responded` | `{ content; model; tokensIn; tokensOut; latencyMs }` |
| `chat.failed`    | `{ model: string \| null; error: string }`           |

### Phase 2 — auth + users + groups

Full table in the previous version of this file; not reproduced
here. See [`auth-and-sessions.md`](./auth-and-sessions.md) §6.

### Phase 3 — layers

See [`layers-and-auth.md`](./layers-and-auth.md) §6.

### Phase 4 — entities

See [`entities.md`](./entities.md) §6. The `entity.*` taxonomy is
closed over the `kind` parameter; every per-kind store emits
`entity.<kind>.<action>`; every translator emits
`entity.translation.*`; every connector emits
`entity.connector.sync.*`.

---

## 8. Testing appendix — `InMemoryMessageBus`

`packages/bus/src/adapters/in-memory.ts`, exported only from
`@bunny2/bus/test-utils`. **Not** importable from `apps/server`;
`apps/server/tests/_helpers/app.ts` is the gateway tests use to
spin up an in-memory bus + a real app together. The bus contract
suite runs against both adapters so the fixture cannot drift.

Why keep it:

- Synchronous handler dispatch in tests. Most unit tests just want
  to publish and immediately assert the handler fired; the
  in-memory adapter does that without a `drain()` call.
- Zero IO. A failing test on a CI runner with a flaky tempdir
  cannot blame disk IO when the bus is purely in-memory.
- The contract suite proves both adapters honour ordering,
  isolation, and middleware-chain semantics identically.

Features:

- Per-handler isolation via `onHandlerError`.
- Snapshot of the handler set per publish, so a handler that
  unsubscribes during dispatch cannot reorder its siblings.
- Injectable `idFactory` + `clock` for deterministic tests.

Limitations vs production:

- No durability. A publish that returned does not survive a
  process restart.
- No `subscriberKey` semantics. `subscribe(..., { subscriberKey })`
  is accepted for interface parity but ignored.
- No DLQ. Handler errors land in `onHandlerError` only; there is no
  per-subscriber-key retry budget.

If a test exercises **durable** behaviour (boot recovery,
multi-process delivery, DLQ), it must use
`DurableSqliteMessageBus` directly — see
`apps/server/tests/role-split.test.ts` and
`apps/server/tests/smoke-worker.test.ts` for the canonical
patterns.

### `bunqueue` — historical note

`bunqueue` was the originally proposed transport (overall plan
§10.1). After inspection (ADR
[`0005`](../decisions/0005-event-sourcing-and-bunqueue.md)) it did
not match the bus contract: it is a job queue (cron, retries, DLQ,
MCP server), not a pub/sub event bus with a middleware hook.
Phase 1 shipped in-memory only; phase 5 added the durable adapter
described above. Both ADR 0005 and that decision stand.

---

## 9. Operational notes

- The `bus.outbox.prune` scheduled task (default 7 day retention
  on `delivered` rows) keeps the outbox bounded. See
  [`job-inventory.md`](./job-inventory.md).
- A growing DLQ is operator-visible via `bus.dlq.added` bus
  events and via the `/admin/bus/dlq` page.
- `/status.bus` reports `{ adapter: 'durable-sqlite', events: <N> }`
  where `<N>` is the canonical `events` table count.
- Multi-host deployment is **not** supported in phase 5. ADR 0019
  records the trigger to revisit (a real second host).
