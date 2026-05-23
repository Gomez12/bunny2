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

## 8. Event types in phase 1

Phase 1.5 introduces the first three real domain events. They are emitted
by `apps/server/src/http/routes/chat.ts` and consumed (today) only by
the telemetry middleware that writes them to the `events` table —
future phases will add real subscribers.

| Type             | When                                               | Payload shape                                                                                                                                       |
| ---------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat.requested` | At the start of `POST /chat`, before the LLM call. | `{ message: string; model: string \| null }` — `model` is the per-call override, or `null` when the configured default is used.                     |
| `chat.responded` | After a successful LLM round-trip.                 | `{ content: string; model: string; tokensIn: number; tokensOut: number; latencyMs: number }`. Token counts come from the LLM client, not estimated. |
| `chat.failed`    | When the LLM call throws.                          | `{ model: string \| null; error: string }`. The HTTP response is 502 with body `{ error: 'errors.chat.upstream', correlationId }`.                  |

Every event in a single chat round-trip shares the same
`correlationId` and `flowId` (UUID v4, generated at the start of the
handler), so a downstream consumer can join `events` rows on either id
to reconstruct the full flow. The LLM telemetry row (in `llm_calls`)
carries the same `correlationId` and `flowId`, so cross-table joins
are direct.

## 9. Phase 2 events

Phases 2.1 and 2.2 add the `users`, `groups`, `sessions` tables, the
repositories that write them, the session service, the cookie helpers,
and the auth middleware. None of that emits new event types: the repos
are pure DB writes, and the auth middleware reads sessions per
request without publishing.

Phase **2.3** introduces the auth domain events. Phases **2.4** and
**2.5** extend the table with the rest of the user / group lifecycle.
The full set of phase-2 events:

| Type                    | When                                                                                                              | Payload                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `user.created`          | Admin seed (2.3); `POST /admin/users` (2.5)                                                                       | `{ userId, username, seeded: boolean, createdBy?: actingAdminId }` (seed → `seeded: true`; admin path → adds `createdBy`) |
| `user.updated`          | `PATCH /admin/users/:id` (2.5)                                                                                    | `{ userId, patch: { displayName?, groupIds? }, updatedBy: actingAdminId }`                                                |
| `user.deleted`          | `DELETE /admin/users/:id` (2.5)                                                                                   | `{ userId, deletedBy: actingAdminId }`                                                                                    |
| `user.password_changed` | `POST /auth/password`; `POST /admin/users/:id/reset-password` (2.5)                                               | `{ userId, by: actingAdminId \| userId, forced: boolean }` (`true` for admin reset; `false` for self rotation)            |
| `user.login.succeeded`  | `POST /auth/login` success                                                                                        | `{ userId, sessionId }`                                                                                                   |
| `user.login.failed`     | `POST /auth/login` 401 (every failure branch)                                                                     | `{ userId? \| username, reason: 'unknown_user' \| 'soft_deleted' \| 'wrong_password' }`                                   |
| `session.created`       | `POST /auth/login` success                                                                                        | `{ sessionId, userId, expiresAt }`                                                                                        |
| `session.expired`       | `POST /auth/logout`; `POST /auth/password` (per revoked sibling); `DELETE /admin/users/:id`; reset-password (2.5) | `{ sessionId, userId, reason: 'logout' \| 'self_password_change' \| 'admin_password_reset' \| 'user_deleted' }`           |
| `group.created`         | Admin seed (2.3); `POST /admin/groups` (2.4)                                                                      | `{ groupId, slug, name, seeded? }`                                                                                        |
| `group.updated`         | `PATCH /admin/groups/:id` (2.4)                                                                                   | `{ groupId, patch: { name?, description? } }`                                                                             |
| `group.deleted`         | `DELETE /admin/groups/:id` (2.4)                                                                                  | `{ groupId, slug }`                                                                                                       |
| `group.member_added`    | Admin seed (2.3); membership endpoints (2.4); user CRUD (2.5)                                                     | `{ groupId, kind: 'user' \| 'group', userId? \| childGroupId?, seeded? }`                                                 |
| `group.member_removed`  | `DELETE /admin/groups/:id/members/:memberId` (2.4); `PATCH /admin/users/:id` group diff (2.5)                     | `{ groupId, kind: 'user' \| 'group', userId? \| childGroupId? }`                                                          |

Phase 2.4 also adds an **in-memory transitive group resolver**
(`apps/server/src/auth/group-resolver.ts`) that subscribes to
`group.*` and `user.*` events on the bus. The subscriber clears the
resolver's caches so the next `isUserInGroup(userId, groupId)` call
reflects the new graph. See
[`auth-and-sessions.md`](./auth-and-sessions.md) §9 for the resolver
narrative and the recursive-CTE shapes.

Anti-leak invariants:

- `user.login.*` payloads carry the attempted **username** or the
  resolved **userId**, never the supplied password.
- The admin seed prints the initial password to stdout exactly once.
  No bus event ever carries password material (the seed event
  carries only `userId`, `username`, and the `seeded: true` flag).
- `correlationId` is assigned per HTTP request and shared across
  every publish that request makes (e.g. `session.created` and
  `user.login.succeeded` share an id for a single login). Mirrors
  the chat-route pattern from phase 1.5.

See [`auth-and-sessions.md`](./auth-and-sessions.md) for the cross-
event narrative (login → session → password rotation → logout).

## 10. Phase 3 events — layers

Phase 3 introduces the `layers` table and its visibility / membership
/ locale / attachment siblings, and a request-time
effective-layer-set resolver. The `layer.*` event family is the
external surface the resolver's bus subscriber listens on; see
[`layers-and-auth.md`](./layers-and-auth.md) §6 for the producer
narrative and ADRs
[`0009`](../decisions/0009-layer-model.md) /
[`0010`](../decisions/0010-layer-resolver-and-invalidation.md) for
the why.

| Type                          | When                                                                                       | Payload                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `layer.created`               | Layer seed (3.2); `POST /layers` (3.4); `user.created` / `group.created` subscribers (3.2) | `{ layerId, type, slug, name, ownerUserId?, ownerGroupId?, seeded? }`                      |
| `layer.updated`               | `PATCH /layers/:slug` (3.4)                                                                | `{ layerId, slug }`                                                                        |
| `layer.deleted`               | `DELETE /layers/:slug` (3.4); `user.deleted` / `group.deleted` subscribers (3.2)           | `{ layerId, slug, type, ownerUserId?, ownerGroupId? }`                                     |
| `layer.visibility.added`      | Layer seed (3.2); `POST /layers/:slug/visibility` (3.4); `POST /layers` (`everyone` edge)  | `{ parentLayerId, childLayerId, direction: 'top_down' \| 'bottom_up' \| 'both', seeded? }` |
| `layer.visibility.removed`    | `DELETE /layers/:slug/visibility/:parentSlug` (3.4)                                        | `{ parentLayerId, childLayerId }`                                                          |
| `layer.member.added`          | `POST /layers/:slug/members` (3.4); `POST /layers` (owner row)                             | `{ layerId, kind: 'user' \| 'group', role, userId? \| groupId? }`                          |
| `layer.member.removed`        | `DELETE /layers/:slug/members/:memberId` (3.4)                                             | `{ layerId, kind, userId? \| groupId? }`                                                   |
| `layer.locale.set`            | `POST /layers/:slug/locales` (3.4)                                                         | `{ layerId, locales[], defaultLocale }`                                                    |
| `layer.attachment.registered` | `POST /layers/:slug/attachments` (3.4)                                                     | `{ layerId, attachmentId, kind, refId, configPreview }` (≤500 chars)                       |
| `layer.attachment.removed`    | `DELETE /layers/:slug/attachments/:id` (3.4)                                               | `{ layerId, attachmentId, kind, refId }`                                                   |

`apps/server/src/layers/events.ts` exports the
`ALL_LAYER_EVENT_TYPES` constant so the resolver's subscriber list
stays machine-checkable: a new type cannot land without a
subscription decision.

The resolver's bus subscriber
(`apps/server/src/layers/subscribers.ts`) reacts to:

- every `layer.*` type → broad `invalidate()` (layers change rarely,
  so the cheap-when-rare cost beats per-user enumeration).
- `user.created` → seed personal layer + broad invalidate.
- `user.deleted` → soft-delete the user's personal layer +
  `invalidate(userId)`.
- `group.created` → seed group layer + broad invalidate.
- `group.deleted` → soft-delete the group layer + broad invalidate.
- `group.member_added` / `group.member_removed` → targeted
  `invalidate(affectedUserId)` for `kind: 'user'`; for `kind:
'group'` enumerate the transitive user set under the affected
  child branch and invalidate per-user.

Routes also invalidate the caller's entry inline before returning
so the very next handler in the same process sees the new state
without depending on subscriber ordering.

## 12. Phase 4 events — entities

Phase 4.0 introduces the universal entity contract
(`apps/server/src/entities/`) and the `entity.*` event family. The
taxonomy is closed over the `kind` parameter — every per-kind store
emits `entity.<kind>.<action>` events, every translator job emits
the same `entity.translation.*` events, and every connector emits
the same `entity.connector.sync.*` events. No concrete entity kind
ships in 4.0 — per-kind code lands in 4a..4d.

| Type                              | When                                                  | Payload                                               |
| --------------------------------- | ----------------------------------------------------- | ----------------------------------------------------- |
| `entity.<kind>.created`           | `EntityStore.create` after the tx commits             | `{ ref, version, originalLocale, searchableText }`    |
| `entity.<kind>.updated`           | `EntityStore.update` after the tx commits             | `{ ref, version, previousVersion, searchableText }`   |
| `entity.<kind>.deleted`           | `EntityStore.softDelete` after the tx commits         | `{ ref, version, deletedBy }`                         |
| `entity.<kind>.restored`          | `EntityStore.restore` after the tx commits            | `{ ref, version }`                                    |
| `entity.translation.requested`    | Translator job enqueues a per-locale translation      | `{ ref, locale, sourceVersion }`                      |
| `entity.translation.completed`    | Translator writes `entity_translations` and publishes | `{ ref, locale, sourceVersion, latencyMs }`           |
| `entity.connector.sync.requested` | Connector base `markSyncing`                          | `{ ref, connector, externalId }`                      |
| `entity.connector.sync.succeeded` | Connector base `markSucceeded`                        | `{ ref, connector, externalId, syncState, syncedAt }` |
| `entity.connector.sync.failed`    | Connector base `markFailed`                           | `{ ref, connector, externalId, error }`               |

Anti-leak invariants:

- Connector payloads (KvK numbers, Google Calendar refresh tokens,
  encrypted blobs) NEVER appear in a bus event. The connector base
  scrubs `payload_json` before publish via
  `scrubConnectorPayload(...)` — see ADR
  [`0011`](../decisions/0011-entity-contract.md) §"Connector base +
  secret scrubbing".
- `searchableText` is a denormalized digest, not a content dump —
  short enough to live in an event without bloating the log.
- Translation events carry `sourceVersion`, never the translated
  payload itself; the payload lives in `entity_translations`.

Subscribers (announced; not all live in this commit):

- Per-kind translator job — listens for
  `entity.<kind>.{created,updated}` and enqueues re-translation per
  layer locale. Re-translation is skipped when
  `entity_translations.source_version >= entity.version`.
- LanceDB index writer (write-side only; phase-6 reads apply the
  pre-retrieval auth filter).
- Todo→calendar projection (phase 4d.6) — listens for
  `entity.todo.{created,updated,deleted}`.

`apps/server/src/entities/events.ts` exports
`ENTITY_EVENT_TYPES` + `entityEventType(kind, action)` so the
constant set is machine-checkable.

## 11. Future extensions

- Wildcard subscriptions (`'*'`) — currently the replay script manages
  this via per-type subscription on demand.
- Coalescing / debouncing for derived work (overall plan §5.3). Will
  attach as additional middlewares.
- A durable cross-process transport — only needed once we have multiple
  workers; not before phase 5 (general scheduled tasks).
