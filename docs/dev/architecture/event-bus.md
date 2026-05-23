# Event Bus

> Status: living document.
> Owners: phase-1.3 introduced this; later phases extend it.
> Source code: `packages/bus/`, `apps/server/src/bus/`.

This document describes the event bus that powers bunny2's event-sourced
core. Every state-changing action in the product flows through it; the
SQLite `events` table is the source of truth from which any read model can
be rebuilt.

---

## 1. Goals

1. **Event sourcing.** Every published event is persisted before any
   handler runs. State is rebuildable from the log.
2. **Cross-cutting middleware.** Correlation ids, telemetry, error capture
   live in one place and apply to every event.
3. **Adapter-pluggable.** The `MessageBus` interface in `packages/bus/`
   has no DB or transport dependencies. Today: in-process pub/sub. Later:
   anything that fits the interface and the contract test.
4. **Deterministic in tests.** Sequential per-handler dispatch + injectable
   `idFactory`/`clock` keep tests race-free.

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
  // optional overrides
  readonly id?: string;
  readonly occurredAt?: string;
  readonly correlationId?: string;
  readonly flowId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface MessageBus {
  publish<T>(input: PublishInput<T>): Promise<BusEvent<T>>;
  subscribe<T>(type: string, handler: EventHandler<T>): Unsubscribe;
}
```

Key contract guarantees:

- `id` and `occurredAt` are assigned at `publish()` entry, **before** any
  middleware runs, so every middleware sees a complete `BusEvent`.
- Handlers run **sequentially in registration order** so the chain order is
  observable in tests and so derived work (later phases: AI enrichment,
  translation) cannot accidentally race.
- Per-handler isolation: a handler that throws is reported via
  `onHandlerError` (default: `console.error`) but does not skip its
  siblings.

---

## 3. Middleware chain

A middleware is `(event, next) => Promise<void>`. To modify an event for
downstream steps, forward an immutable copy: `await next({ ...event, … })`.

The server wires the chain (outer → inner) as:

```
correlationIdMiddleware
  → telemetryMiddleware(sqliteWriter)
    → errorCaptureMiddleware
      → handler dispatch (terminal)
```

Why this order:

| Position  | Middleware                | Reason                                                                                                                                                          |
| --------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outermost | `correlationIdMiddleware` | Every downstream step (telemetry included) sees the same `correlationId`.                                                                                       |
| Middle    | `telemetryMiddleware`     | Writes to the `events` table **on the way in**, before `next()`. The log captures the event even if a handler later throws.                                     |
| Innermost | `errorCaptureMiddleware`  | Safety net for failures inside the middleware chain. The adapter already isolates per-handler failures; this catches anything the middlewares themselves throw. |

`errorCaptureMiddleware` **logs and swallows**, it does not rethrow.
Rationale: a bad subscriber must not poison the bus or block other
subscribers, and the telemetry middleware (which sits outside this one)
has already captured the event, so the failure is observable post-hoc.

---

## 4. Adapters

### 4.1 `InMemoryMessageBus`

`packages/bus/src/adapters/in-memory.ts`. Primary implementation. Used by
the server and by tests. Features:

- Per-handler isolation via `onHandlerError`.
- Snapshot of the handler set per publish, so a handler that unsubscribes
  during dispatch cannot reorder its siblings.
- Injectable `idFactory` + `clock` for deterministic tests.

### 4.2 `bunqueue` — fit-check outcome

`bunqueue` was the originally proposed transport (overall plan §10.1).
After inspection (see
[ADR 0005](../decisions/0005-event-sourcing-and-bunqueue.md)) it does not
match the bus contract: it is a job queue (cron, retries, DLQ, MCP
server), not a pub/sub event bus with a middleware hook. Phase 1 ships
**in-memory only**; the interface stays adapter-shaped so a real durable
transport can land later without touching call sites.

---

## 5. Event log (`apps/server/src/bus/event-log.ts`)

`createSqliteEventLog(db)` returns:

- a `TelemetryWriter` that inserts each event into the `events` table
  (`id`, `type`, `occurred_at`, `correlation_id`, `flow_id`, `payload` as
  JSON, `metadata` as JSON-or-NULL). Column names match
  `apps/server/src/storage/migrations/0001_init.sql`.
- a `count()` helper used by `/status`.

`replayEvents(db, opts)` is a generator that yields events ordered by
`(occurred_at, id)`. It accepts `type`, `since`, `until`, and `limit`
filters which are pushed into SQL — the log is never loaded eagerly.

---

## 6. Replay

`scripts/replay.ts` wires it all together:

```bash
bun run replay [--type=foo.bar] [--since=ISO] [--until=ISO] [--limit=N]
```

It opens the server's database via the same config loader, constructs a
fresh `InMemoryMessageBus`, subscribes a counting handler per observed
type, and re-publishes every event in `(occurred_at, id)` order. Output is
total + per-type counts. The script proves event sourcing is real: a
fresh process with no live producers can rebuild observable state from
the log alone.

---

## 7. How to add a new event type

1. Pick a stable dotted name (`<domain>.<action>`, past tense, English):
   `chat.requested`, `chat.responded`, `todo.created`.
2. Define a payload type in `packages/shared/` so producers and consumers
   share the shape. Keep payloads serialisable JSON (no functions, no
   classes).
3. Publish: `await bus.publish({ type: 'chat.requested', payload, correlationId })`.
   If you already have a `correlationId` from the caller (e.g. an HTTP
   request id), pass it — `correlationIdMiddleware` will only mint one
   when it is absent.
4. Subscribe in a domain-specific module:
   `bus.subscribe<MyPayload>('chat.requested', handler)`.
5. Add tests: at minimum, assert the event lands in the log (it does,
   automatically) and that the handler reacts as expected.

---

## 8. Future extensions (not in phase 1.3)

- Wildcard subscriptions (`'*'`) — currently the replay script manages
  this via per-type subscription on demand.
- Coalescing / debouncing for derived work (overall plan §5.3). Will
  attach as additional middlewares.
- A durable cross-process transport — only needed once we have multiple
  workers; not before phase 5 (general scheduled tasks).
