# ADR 0005 — Event sourcing and the bunqueue fit-check

- Status: accepted
- Date: 2026-05-23
- Phase: 1.3
- Related: `docs/dev/plans/overall.md` §5, §10.1; `docs/dev/plans/done/phase-01-system-foundation.md` §4.2 / §10; `docs/dev/architecture/event-bus.md`.

---

## Context

The overall plan commits to an event-sourced core (overall §5.1) and
proposes [`egeominotti/bunqueue`](https://github.com/egeominotti/bunqueue)
as the transport (overall §10.1), behind a thin internal interface so it
can be replaced without touching call sites. Phase 1.3 is the first place
that actually has to integrate something, so it owns the fit-check.

What we need from the bus:

1. Pub/sub: publish a typed event, fan it out to N subscribers.
2. Persisted event log: every event ends up in the SQLite `events` table
   (id, type, occurred_at, correlation_id, flow_id, payload, metadata).
3. Middleware chain: correlation id, telemetry, error capture, plus room
   for future coalesce/debounce/rate-limit middlewares.
4. Replay: rebuild state by re-emitting the log to fresh subscribers.
5. Deterministic behaviour in tests; no surprise threading or cron.

---

## Decision

1. **Ship an in-memory `MessageBus` as the only adapter for phase 1.3.**
   `packages/bus/src/adapters/in-memory.ts` implements the full contract
   (publish, subscribe, unsubscribe, middleware chain, per-handler
   isolation).
2. **Keep the `MessageBus` interface adapter-shaped** so a durable or
   cross-process transport can land later without touching call sites.
   The interface lives in `packages/bus/src/types.ts`; nothing in it
   leaks SQLite or any transport.
3. **Persist every event via a `telemetryMiddleware`** wired in
   `apps/server/src/index.ts` against
   `apps/server/src/bus/event-log.ts::createSqliteEventLog`. The bus
   package itself stays DB-agnostic; the writer is an injected
   `(event) => void | Promise<void>`.
4. **Do not adopt `bunqueue` at this time.** See "bunqueue fit-check"
   below.

## bunqueue fit-check (npm `bunqueue@2.7.14`, inspected 2026-05-23)

- Package description: "High-performance job queue for Bun & AI agents.
  SQLite persistence, cron scheduling, priorities, retries, DLQ,
  webhooks, native MCP server."
- Surface area is a **job queue**, not a pub/sub event bus with a
  middleware chain. There is no "subscribe to a topic, get every event,
  run middleware around delivery" shape; jobs are claimed by workers,
  retried with backoff, and dead-lettered.
- Required peer: `bun ^1.3.9` (fine, we are on 1.3.13).
- Dependency footprint: 4 runtime deps including
  `@modelcontextprotocol/sdk` (large, MCP-specific) and `zod ^4.3.6`
  while this repo standardises on `zod ^3.23.x` (server config schema).
  Adopting bunqueue would either fork zod versions across packages or
  force an early zod-4 migration unrelated to the bus.
- Unpacked size ~3.3 MB; portable-binary footprint matters (overall §4).
- Behavioural mismatch with our model:
  - We want every event delivered to every subscriber (fan-out), then
    persisted exactly once to the event log. A job queue gives the
    opposite: persist a job once, hand it to exactly one worker.
  - Cron / retry / DLQ are valuable but belong to phase 5 (general
    scheduled tasks), not the event bus.

**Conclusion:** `bunqueue` is a fine library for what it is — a job
queue — but it is not the shape we need for the event-sourced bus.
Forcing it into that role would mean (a) treating every fan-out
subscriber as a separate job, multiplying persistence and complicating
replay, (b) carrying an MCP SDK and a zod-version split for no current
benefit. We ship the in-memory bus and revisit when a real need appears.

## When do we revisit?

When the in-memory bus becomes a bottleneck **or** we need cross-process
delivery — realistically not before phase 5 (general scheduled tasks),
which is where durable scheduling + retries earn their keep. The bus
interface is adapter-shaped, so adopting `bunqueue` (for the job-queue
parts) or a different transport later is additive, not a rewrite.

---

## Consequences

**Positive**

- Phase 1.3 ships with the smallest possible foundation: one
  in-process adapter, a SQLite-backed event log, and a replay script
  that proves event sourcing is real.
- No new runtime deps in `packages/bus`.
- Tests are deterministic (sequential dispatch, injectable clock + id
  factory).
- Future durable transport slots in behind the same interface; producers
  and consumers do not change.

**Negative / accepted**

- No cross-process delivery yet. Acceptable: phase 1 is single-process
  (Bun server + Electron sidecar).
- No automatic retry / DLQ for handlers that throw. Acceptable: the
  event is already persisted (telemetry writes BEFORE dispatch), so a
  later operator-driven replay or an explicit retry middleware can
  recover.
- The overall plan (§10.1) names bunqueue specifically; this ADR
  supersedes that pick. Overall plan now reads "messaging: thin internal
  `MessageBus`; in-memory adapter today, transport revisited at phase 5"
  — see the linked section of the architecture doc for the current
  state.

---

## Alternatives considered

1. **Adopt bunqueue anyway, map fan-out to per-subscriber jobs.**
   Rejected: doubles persistence, complicates replay, drags in MCP SDK
   and zod-4 split for no current benefit.
2. **Write a thin SQLite-backed pub/sub now.** Rejected: speculative.
   The in-memory adapter satisfies every phase-1 requirement and the
   interface is ready for a durable swap when a real need appears.
3. **Use Node's `EventEmitter` directly.** Rejected: no async middleware
   chain semantics, no event-shape contract, harder to test
   deterministically.

---

## Follow-ups

- Phase 5 plan must answer: do scheduled tasks reuse the bus
  (publish-and-handle) plus a scheduler middleware, or do we adopt a job
  queue (possibly `bunqueue`) for the scheduler half? Either is
  compatible with this ADR.
- Add a wildcard subscription primitive to `InMemoryMessageBus` when the
  first real consumer needs one (replay currently sidesteps this by
  subscribing per observed type).
