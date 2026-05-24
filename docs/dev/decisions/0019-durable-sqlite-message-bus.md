# ADR 0019 — Durable SQLite-backed message bus

- Status: accepted
- Date: 2026-05-24
- Phase: 5 (sub-phases 5.1 + 5.2)
- Supersedes the in-memory-only stance of ADR
  [`0005`](./0005-event-sourcing-and-bunqueue.md) — the `MessageBus`
  interface stays as it was; this ADR introduces a durable
  implementation behind it and makes it the only production adapter.
- Related: `docs/dev/plans/done/phase-05-scheduled-tasks.md` §2
  ("durable bus") + §4.4; `docs/dev/architecture/event-bus.md`;
  ADR [`0018`](./0018-generic-scheduled-tasks.md). Source code:
  `packages/bus/src/adapters/durable-sqlite.ts`,
  `apps/server/src/storage/migrations/0013_durable_bus.sql`.

---

## Context

ADR 0005 picked `MessageBus` + an in-memory adapter as the phase-1
shape and deferred the durable transport to a later phase. The
overall plan §10.1 and `architecture/event-bus.md` §11 both flagged
phase 5 as the revisit point: phase 5 introduces a generic
scheduled-task model whose runtime depends on **crash-safe
delivery** of `scheduledtask.run.requested` events to a worker that
may live in a separate process from the publisher.

We needed: durable publish, crash-safe delivery (a worker killed
mid-handler can replay its claim on next boot), multi-process
support on a single host (so `--role=web` + `--role=worker` can
share one event stream), DLQ semantics for poison messages, and
zero changes to call sites (the existing `MessageBus` interface).

We did **not** need: cross-host federation, multi-tenant transport
isolation, an external broker. The plan §2 explicitly defers
multi-host transport.

---

## Decisions

### 1. SQLite-backed outbox + per-subscriber offsets + DLQ

Three new tables (`0013_durable_bus.sql`):

- `bus_outbox` — one row per published event. Columns:
  `(id, type, payload_json, metadata_json, correlation_id, flow_id,
occurred_at, status, attempt, claimed_at, claimed_by_pid,
delivered_at, error)`. `status ∈ {pending, in_flight, delivered,
dead, abandoned}`. The same `id` as the `events` row — the existing
  canonical event log stays the source of truth, the outbox is the
  **delivery ledger**.
- `bus_offsets` — one row per `subscriber_key` carrying the last
  successfully-delivered outbox id. Lets consumers progress
  independently and lets boot recovery resume where it stopped.
- `bus_dlq` — one row per `(subscriberKey, outboxId)` pair that
  exhausted its retry budget. Carries the error and attempt count;
  the payload itself stays in `bus_outbox.payload_json` so an admin
  inspecting the queue sees the full context.

Indices: `idx_bus_outbox_pending(status, occurred_at) WHERE status
IN ('pending', 'in_flight')` (the hot path for the claim query),
plus `idx_bus_dlq_subscriber` for the admin DLQ list.

### 2. Atomic publish: `events` + `bus_outbox` in one SQLite tx

Every `publish()` writes both rows inside one transaction:

```
BEGIN
  INSERT INTO events       (...)   -- canonical log
  INSERT INTO bus_outbox   (...)   -- delivery ledger
COMMIT
```

If the publishing process dies between the `INSERT events` and the
subscriber consuming, the outbox row stays `pending` and any worker
picks it up on the next claim sweep. This is the user-stated phase-5
invariant: "every process can be killed at any point without data
loss".

This is also the reason the old `telemetryMiddleware(eventLog.writer)`
was removed from the production wiring — that middleware would have
written the `events` row outside the outbox transaction, defeating
atomicity. The durable adapter inlines the `events` write via the
`writeEvent` callback that the server hands it at construction
time.

### 3. Claim-based consume with per-subscriber `subscriberKey`

The consumer loop runs:

```
UPDATE bus_outbox
   SET status = 'in_flight', claimed_at = :now, claimed_by_pid = :pid
 WHERE id IN (
   SELECT id FROM bus_outbox
    WHERE status = 'pending'
      AND id > (SELECT last_id FROM bus_offsets
                 WHERE subscriber_key = :key)
    ORDER BY id ASC
    LIMIT :batchSize
 )
```

Affected-rows tells the consumer how many rows it owns this round.
On handler success: `status='delivered'` and `bus_offsets.last_id` is
advanced. On handler error: `attempt++`; if under `maxAttempts` the
row flips back to `pending` for another worker, otherwise a `bus_dlq`
row is inserted and the outbox status flips to `dead`.

Polling cadence: 250 ms when caught up, batch of 50, both tuneable.
A future `pg_notify`-style signal can slot in via the same interface
(a no-op on SQLite); for now the 250 ms poll is cheap on disk and
sub-millisecond per wake.

`subscriberKey` is a stable string per logical subscriber
(`scheduled.run-subscriber`, `enrichment.runner`,
`layer.subscriber`, …). **One consumer per subscriberKey** is the
contract — two consumers of the same key would step on each other's
`bus_offsets` row. Phase 5 ships one process per role; multi-host
sharding stays deferred.

### 4. Idempotency declared at subscribe-time

`bus.subscribe(type, handler, { subscriberKey, idempotent: true })`.
Boot recovery walks `bus_outbox` rows in `in_flight` past the lease
window and:

- **Idempotent subscriber declared:** re-pend the row. The handler
  may run twice; the handler is expected to dedup (the scheduler's
  run row is the dedup key — see ADR 0018).
- **Otherwise:** flip the row to `abandoned`, publish a
  `bus.abandoned` admin signal, leave it for the operator to
  decide.

Default is `false` because re-running a non-idempotent handler
("send the customer their weekly digest") would be worse than
abandoning it for an operator.

### 5. DLQ surface + admin replay

`POST /admin/bus/dlq/:id/replay` re-inserts the row as `pending` with
`attempt=0`. The matching `bus_dlq` row stays in place as history.
The admin UI (`/admin/bus/dlq`) lists all dead rows with their event
type, subscriber key, attempt count, error message, and a single-row
"Replay" action behind a confirmation dialog. Bulk replay is a
follow-up (plan §15 open question #5).

The adapter exposes an `onDlqAdded` hook so the server can publish
`bus.dlq.added` events without coupling the bus package to
domain-event naming. The publish is fire-and-forget; a throw inside
the notifier is logged and swallowed so a misbehaving observer
cannot starve the consume loop.

### 6. The in-memory adapter survives — but only as a test fixture

`InMemoryMessageBus` moves to `packages/bus/test-utils` and is no
longer exported from the package main entry. `apps/server` never
imports it. Tests that want a synchronous-dispatch bus import it
explicitly from the test-utils entrypoint; the bus contract suite
runs against **both** adapters so the fixture cannot drift from the
real one.

This collapses the production surface to one adapter — every role
(`web`, `worker`, `all`) and the Electron sidecar all bind to the
same `DurableSqliteMessageBus`. No in-memory fallback for any code
path means a restart never loses an in-flight event.

---

## Consequences

- The server can be killed at any point. A `publish()` that returned
  successfully has already committed the SQLite transaction; the
  outbox row will be picked up by the next consumer that runs.
- A `--role=worker` process can take over a `--role=web` process's
  publishes. The two share the SQLite file; the worker's
  `bus_offsets` row tracks its progress.
- Boot recovery is fast: it walks `bus_outbox WHERE status='in_flight'
AND claimed_at < now - lease`, which the
  `idx_bus_outbox_pending` index covers. The scan is O(stuck rows),
  not O(every event ever).
- The `events` table stays the canonical log. Replay (`bun run
replay`) keeps working against the in-memory fixture; the durable
  adapter's outbox is not the replay source.
- A bug in a subscriber that flips a poison message into the DLQ no
  longer wedges the consume loop — the row moves to `dead` and the
  next pending row claims through.

---

## Non-decisions (intentional)

- **No cross-host transport.** Multi-host federation is a separate
  problem; the trigger to revisit is a real second host, not a
  speculative one. When it lands the same `MessageBus` interface
  accepts the new adapter and call sites stay untouched.
- **No Postgres LISTEN/NOTIFY shim today.** The 250 ms poll is fine
  on SQLite. A Postgres adapter (when ADR 0002's "Postgres later"
  trigger fires) gets to choose whether to LISTEN/NOTIFY or keep
  polling; both fit the same interface.
- **No replay-from-arbitrary-timestamp.** The outbox is a delivery
  ledger, not a replay log. To replay history, point a fresh
  subscriber at the `events` table via `bun run replay`.
- **No payload size limit on the outbox.** SQLite happily stores
  arbitrary BLOBs as TEXT; the entity contract's existing
  secret-scrubbing already keeps payloads small. If a future
  payload bloats the table, the `bus.outbox.prune` scheduled task
  is the lever.
- **No per-subscriber rate limit at the bus layer.** Rate limiting
  lives on the handler (the enrichment runner's per-layer limiter is
  the existing example). The bus delivers; throttling is a domain
  concern.

---

## Operations

- The default outbox retention is 7 days on `delivered` rows. The
  built-in `bus.outbox.prune` scheduled task runs daily and trims
  `delivered`/`dead`/`abandoned` rows past the cutoff. Inventory
  row in `architecture/job-inventory.md`.
- A DLQ row alarming is operator-visible via `bus.dlq.added` bus
  events; consumers (a future external alert pipe, a UI badge) can
  subscribe to the same event family. The phase-5.6 admin page is
  the v1 surface.
- Migration `0013_durable_bus.sql` is forward-only; rolling back the
  schema requires a full data-dir reset (the established
  bunny2-on-SQLite contract per ADR 0002).
