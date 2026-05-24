# Phase 5 — General Scheduled Tasks + Durable Bus

> Parent: [`overall.md`](./overall.md) §8 Phase 5.
> Scope of this document: **detailed plan for phase 5 only**.
> Inherits from `overall.md` §4 (stack), §5 (event-sourced core,
> layered scoping, soft-delete, UUIDs, i18n), §10 (durable
> bus-transport decision — now picked up here).
> Builds on phase 3
> ([`done/phase-03-layers.md`](./done/phase-03-layers.md)) — every
> scheduled task lives inside a layer, every list/edit goes through
> `c.var.effectiveLayers`, every mutation publishes a bus event.
> Builds on phase 4
> ([`done/phase-04-first-entities.md`](./done/phase-04-first-entities.md))
> for the event-emission and per-layer rate-limit patterns the
> enrichment runner already proved (see ADR
> [`0013`](../decisions/0013-entity-enrichment.md)).
> Supersedes ADR [`0005`](../decisions/0005-event-sourcing-and-bunqueue.md)'s
> "in-memory only" stance on the bus adapter (ADR 0019 in this
> phase ships the SQLite-backed durable adapter that ADR 0005
> kept the interface open for).

---

## 1. Goal

Introduce two interlocking pieces that the overall plan
explicitly anchored to phase 5:

1. A **generic scheduled-task model** so non-entity work
   (digests, sweeps, health checks, retention pruning, periodic
   agents) can be defined, scheduled, observed, retried, and
   paused without writing a bespoke `setInterval` for every job.
2. A **durable, claim-based, cross-process message-bus adapter**
   (SQLite-backed) so the scheduler — and any future worker
   subscriber — survives crashes, replays unfinished work on
   boot, and can run in a separate Bun process from the HTTP
   server. Anchored by `overall.md` §10.1 and
   `architecture/event-bus.md` §11.

After phase 5 a developer should be able to:

1. Register a handler with
   `registerScheduledTaskHandler({ kind: 'reports.weekly-digest', run })`.
2. Have a layer owner open `/l/<slug>/scheduled-tasks`, pick that
   kind from a dropdown, set a cron (`0 7 * * MON`) or interval
   (every 240 minutes), and save.
3. See the next run on the page; press **Run now** to fire
   immediately; press **Pause** to stop firing without losing
   history.
4. On a failed run see the error message, the attempt counter, and
   the next backoff time. After `maxAttempts` failures the task
   stays paused until manually resumed.
5. Start a second process (`bun run start --role=worker`) on the
   same machine that consumes the same SQLite-backed bus,
   shares the scheduler claim, and counts towards the same
   run-history. Killing the HTTP process mid-handler leaves the
   run in `started`; the next worker boot replays the event and
   either re-runs (idempotent handlers) or marks it
   `skipped_crashed` (non-idempotent handlers, opt-in flag).
6. Watch the same telemetry surface the entity flows already use
   (`events` table, correlation ids, LLM call log if the handler
   calls an LLM) — phase 5 is **additive** on top of the existing
   bus, not a parallel runtime.

---

## 2. Scope

In scope — **scheduled tasks**:

- New tables `scheduled_tasks` + `scheduled_task_runs`
  (UUID, soft-delete, layer-scoped, version-counted).
- Shared zod payload + cron-or-interval schema.
- In-process **handler registry** + **scheduler service** (tick
  loop, claim, fan-out via `bus.publish`).
- New event family `scheduledtask.*`.
- HTTP routes per layer + admin cross-layer overview.
- Retry/backoff via event re-emission.
- Web UI: list + create dialog + pause/resume + run-now + history.
- Dashboard widget "Recent runs".
- Migrate one existing daily job (`llmPrune`) to the registry as
  the dogfood proof.
- ADR `0018 — generic scheduled tasks`.
- `architecture/scheduled-tasks.md`, `architecture/job-inventory.md`
  - the matching `tests/docs/job-inventory.test.ts` referenced by
    `AGENTS.md §Pull Requests`.
- User guide `docs/user/guides/scheduled-tasks.md`.
- i18n keys under `scheduledTasks.*`.

In scope — **durable bus**:

- New `DurableSqliteMessageBus` adapter implementing the existing
  `MessageBus` interface from `packages/bus/`. **This becomes
  the only production adapter** — dev runs, the Electron sidecar,
  and any deployed role all use it. The existing
  `InMemoryMessageBus` is downgraded to a test fixture exported
  from `packages/bus/test-utils` (not from the package main
  entry); `apps/server` no longer imports it. Rationale:
  zero in-memory state means the server can be killed at any
  point without data loss — the user-stated invariant for this
  phase.
- New tables `bus_outbox`, `bus_offsets`, `bus_dlq` (see §5).
  The existing `events` table stays — it remains the canonical
  event log; the outbox is the **delivery** ledger.
- Atomic publish: every `publish()` inserts into `events` AND
  `bus_outbox` in one SQLite transaction.
- Claim-based consumer loop with per-subscriber `bus_offsets`
  rows so consumers progress independently.
- Crash-safe handler invocation: a row stays `in_flight` until
  the consumer commits its `succeeded` / `failed` write. On
  boot the loop replays any row still `in_flight` past a grace
  window.
- Per-subscriber `maxAttempts` + dead-letter queue (`bus_dlq`)
  surfaced in the admin UI.
- Process role split: `bun run start --role=web` (HTTP only,
  publishes, no scheduler tick), `--role=worker` (scheduler +
  bus consumers, no HTTP), `--role=all` (current behavior,
  default for dev + Electron). All roles run the durable
  adapter and share the SQLite DB.
- ADR `0019 — durable SQLite-backed message bus`.
- `architecture/event-bus.md` rewritten around the single
  production adapter; the in-memory fixture is mentioned only
  in the "testing" appendix.
- Smoke extension: end-to-end create → tick → run with `--role=all`,
  plus a second smoke (`smoke-worker`) that runs
  `--role=worker` against a pre-seeded DB.

Out of scope (deferred):

- Cross-**host** transport (Redis, NATS, Postgres LISTEN/NOTIFY).
  The SQLite-backed adapter is multi-process on one host (the
  shape `overall.md` §10.1 actually needs for phase 5). A
  multi-host adapter slots into the same interface in a later
  phase if federation lands.
- Migrating `connectorRunner` to the generic registry — its
  per-link cadence comes from `layer_attachments.config` and
  does not fit a single cron/interval. Stays where it is.
- Migrating `enrichmentRunner` or `todoCalendarProjection` —
  both are **event-driven**, not scheduled. They are not
  user-visible schedules and stay on the bus directly. They
  DO benefit from the durable bus (their subscriptions become
  crash-safe) without code changes.
- A UI to author handlers. Handlers live in code; the UI only
  picks from registered `kind`s.
- Backfilling missed cron slots from server downtime. Missed
  slots are recorded as a single `skipped_offline` row per
  task (see §4.2).
- Webhook / external-trigger entry points. Phase 5 is purely
  time-based.

---

## 3. Non-Goals (phase 5)

- No cron parser written from scratch — pull in `croner` (see
  §10 "Dependencies").
- No new bus interface — `MessageBus` in `packages/bus/` keeps
  its current contract; the durable adapter is the only
  production implementation behind it. The in-memory adapter
  is preserved as a unit-test fixture only (it stays inside
  the package, but moves under `packages/bus/test-utils` and
  is no longer importable by `apps/server`).
- No multi-tenant isolation beyond what layers already give us —
  layer scoping IS the multi-tenant boundary.
- No fine-grained per-task ACL beyond `canEditLayer` from
  phase 3.3. Layer owners manage tasks in their layer; admins
  manage `everyone`-layer tasks (= the system jobs).
- No SQLite-specific SQL beyond what the existing
  migrations already use (per `overall.md` §10 and ADR 0002 —
  must stay portable to Postgres). The outbox tables use only
  the same SQL features the `events` and `entity_*` tables
  use today.
- No multi-host transport (see §2 deferred).

---

## 4. Approach

### 4.1 Sub-phases (delivery order — one tasklist row each)

| Sub | What ships                                                                                                                                                                                                                                                                                                                            | Commit subject                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| 5.0 | Migration `0012_scheduled_tasks.sql`, repos, shared types/zod (`packages/shared/src/scheduled-tasks.ts`), cron-or-interval schema, `croner` dependency note                                                                                                                                                                           | `feat(scheduled): schema + repo (phase 5.0)`                       |
| 5.1 | Migration `0013_durable_bus.sql` (outbox + offsets + dlq), `DurableSqliteMessageBus` adapter in `packages/bus/`, atomic-publish path, replay-on-boot, contract tests parameterized over both adapters                                                                                                                                 | `feat(bus): durable sqlite adapter (phase 5.1)`                    |
| 5.2 | `--role=web                                                                                                                                                                                                                                                                                                                           | worker                                                             | all`CLI flag wiring in`apps/server/src/index.ts`; role gating around scheduler-runner, connector-runner, enrichment-runner, todo-projection; bus-consumer loop honors the role split | `feat(server): role split (web/worker/all) (phase 5.2)` |
| 5.3 | Handler registry (`apps/server/src/scheduled/registry.ts`), scheduler service (`scheduler.ts`) with tick + claim + fan-out, `scheduledtask.*` event taxonomy (`events.ts`); retry/backoff + paused states + run-history retention (registered as a scheduled task — the second dogfood)                                               | `feat(scheduled): registry + scheduler + retry (phase 5.3)`        |
| 5.4 | HTTP routes `/l/:slug/scheduled-tasks/*` (CRUD + `POST .../runs` + `GET .../runs`), admin `/admin/scheduled-tasks` + `/admin/bus/dlq`, `requireLayer` + `canEditLayer` reuse                                                                                                                                                          | `feat(scheduled): http routes + dlq view (phase 5.4)`              |
| 5.5 | Migrate `llmPrune` to the generic registry (`kind: 'llm.calls.prune'`); register `system.healthcheck` + `scheduled.runs.prune`; document why `connectorRunner` / `enrichmentRunner` / `todoCalendarProjection` stay outside                                                                                                           | `refactor(llm): prune as scheduled task + healthcheck (phase 5.5)` |
| 5.6 | Web UI `/l/:slug/scheduled-tasks` (list, create dialog, pause/resume, run-now, history) + admin DLQ page + dashboard widget "Recent runs"                                                                                                                                                                                             | `feat(scheduled): web UI + dlq page (phase 5.6)`                   |
| 5.7 | i18n keys, smoke step (create → run-now → history), `smoke-worker` smoke variant exercising `--role=worker`, ADRs `0018` + `0019`, `architecture/scheduled-tasks.md`, rewrite of `architecture/event-bus.md` to cover both adapters, `architecture/job-inventory.md` + `tests/docs/job-inventory.test.ts`, user guide, plan close-out | `test(scheduled,bus): smoke + i18n + docs + close-out (phase 5.7)` |

PR cadence: **one PR for the whole phase 5 block**, mirroring
phase 4's per-block cadence. The eight sub-phases each ship as
one focused commit on the same branch.

### 4.2 Lifecycle of a scheduled task

```
scheduled_tasks row:
  status ∈ { active, paused, canceled }
  schedule ∈ { cron: "<5-field>", timezone } | { intervalMinutes }
  next_run_at: TEXT ISO (UTC), computed on save + after each run
  last_run_at: TEXT ISO | NULL
  attempt: INTEGER (0 on success / fresh; 1..maxAttempts on retry)
  max_attempts: INTEGER (default 3)
  backoff_base_ms: INTEGER (default 60_000)
  backoff_max_ms: INTEGER (default 3_600_000)

scheduler tick (default 30s, runs only on roles {worker, all}):
  1. SELECT * FROM scheduled_tasks
       WHERE status='active'
         AND deleted_at IS NULL
         AND next_run_at <= now
       LIMIT N
  2. UPDATE … SET claimed_at=now, claimed_by_pid=?
       WHERE id=? AND (claimed_at IS NULL OR claimed_at < now - <lease>)
     (affected-rows == 1 → we own the tick)
  3. INSERT scheduled_task_runs (status='requested', requested_at=now)
  4. bus.publish('scheduledtask.run.requested', { taskId, runId, kind, layerId, ... })

run subscriber:
  1. lookup handler by kind; missing → publish
     'scheduledtask.run.skipped' with reason='no_handler'
  2. UPDATE run SET status='started', started_at=now
     bus.publish('scheduledtask.run.started')
  3. await handler.run({ task, run, ctx })
  4. on success:
       UPDATE run SET status='succeeded', finished_at=now
       UPDATE task SET attempt=0, last_run_at=now,
                       next_run_at=<cron-next or now+interval>,
                       claimed_at=NULL
       bus.publish('scheduledtask.run.succeeded')
  5. on throw:
       UPDATE run SET status='failed', error=<message>
       attempt++; if attempt < max_attempts:
         backoff = min(backoff_max, backoff_base * 2^(attempt-1))
         next_run_at = max(<cron-next>, now + backoff)
       else:
         status='paused'  -- auto-pause after maxAttempts
       bus.publish('scheduledtask.run.failed')

boot recovery (per worker process):
  -- scheduled tasks
  SELECT id FROM scheduled_tasks
    WHERE status='active' AND next_run_at < now - <grace>
  → INSERT one 'skipped_offline' run row per task; re-anchor
    next_run_at to the next cron slot. Single row per task —
    we don't replay every missed slot, that would storm the bus
    after a long outage.

  -- in-flight bus rows (see §4.4)
  SELECT id FROM bus_outbox WHERE status='in_flight'
    AND claimed_at < now - <lease>
  → if subscriber declared idempotent: republish
  → else: status='abandoned' + 'bus.abandoned' admin signal
```

### 4.3 Decisions resolved before start

1. **Durable cross-process bus transport.** `overall.md` §10.1
   and `event-bus.md` §11 flagged this as a phase-5 revisit
   point. **Decision: ship a SQLite-backed durable adapter in
   phase 5** (sub-phases 5.1 + 5.2). One host, multiple
   processes, claim via DB row UPDATE. Cross-host transport
   (Redis, NATS, Postgres LISTEN/NOTIFY) stays deferred — that
   is "federation" territory, not "single-host worker split".
   ADR 0019 records the rationale and the trigger for revisiting
   (a real second host).
2. **Bestaande runners.** `llmPrune` migrates to the generic
   registry (the dogfood proof). `connectorRunner` stays
   specialized (per-link cadence from `layer_attachments`
   doesn't fit one cron). `enrichmentRunner` and
   `todoCalendarProjection` are event-driven, not scheduled.
   The scheduled-tasks UI therefore shows **only** generic
   tasks; the connector cadence stays on the connector page;
   enrichment/projection are not user-visible. All four
   inherit crash-safety from the durable bus without code
   changes.
3. **Layer scope of system jobs.** System jobs (`llm.calls.prune`,
   `system.healthcheck`, `scheduled.runs.prune`) live in the
   **`everyone` layer**, edit-gated by `canEditLayer` (=
   admin-only). No new "system" layer type, no separate flag.
4. **Cron vs interval.** Both accepted; zod-mutex so a task is
   one or the other. Interval is convenient for ops jobs;
   cron is right for "Monday morning". Documented in the user
   guide with one example each.
5. **Timezone.** Per-task `timezone` field (default = system
   default `Europe/Amsterdam`). `croner` evaluates `cron` in
   that timezone; `next_run_at` is stored in UTC.
6. **Backfill.** Do not backfill missed runs from downtime. A
   single `skipped_offline` row is recorded; `next_run_at`
   anchors forward.
7. **Default process role.** `--role=all` stays the default for
   dev runs and for the Electron sidecar. Production-style
   deployments can split into `--role=web` + `--role=worker`.
   Phase 5 ships the seam; deployment docs note both
   recipes. **No in-memory fallback** for any role: every
   process binds to the durable adapter, so restarts never
   lose data and a worker can take over a web-published event
   even if the web process crashes mid-publish (the publish
   is the atomic INSERT into `events` + `bus_outbox`).
8. **Idempotency declaration.** Subscribers opt in to "replay
   on abandoned in-flight" via a flag in `bus.subscribe(...,
{ idempotent: true })`. Default is **false** (safer). The
   scheduler runner declares itself idempotent (because the
   run row is the dedup key); the entity event handlers do
   too (UPSERT-based). Connector handlers stay opt-out
   pending per-connector review.

### 4.4 Durable bus design sketch

The interface (`packages/bus/src/index.ts`) stays as it is.
What changes is the adapter set:

- `DurableSqliteMessageBus` — new. The **only** production
  adapter. Wraps the existing middleware chain with a
  persistent outbox + per-subscriber offset tracker. Used by
  every role (`web`, `worker`, `all`) and by the Electron
  sidecar.
- `InMemoryMessageBus` — preserved only as a test fixture
  under `packages/bus/test-utils`. Not exported from the
  package main entry, not importable by `apps/server`. Lets
  unit tests of bus-using code run without touching disk;
  the bus contract suite still runs against both so the
  fixture cannot drift.

**Publish (atomic with SQLite tx):**

```
BEGIN
  INSERT INTO events (...)            -- existing canonical log
  INSERT INTO bus_outbox (id, type, payload_json, occurred_at,
                          status='pending', attempt=0)
COMMIT
```

If the publishing process dies between `INSERT events` and the
subscriber consuming, the outbox row stays `pending` and a
worker picks it up.

**Consume (per subscriber, leased):**

```
loop:
  -- claim a batch this subscriber hasn't seen
  UPDATE bus_outbox
    SET status='in_flight', claimed_at=now, claimed_by_pid=?
    WHERE id IN (
      SELECT id FROM bus_outbox
       WHERE status='pending'
         AND id > (SELECT last_id FROM bus_offsets
                    WHERE subscriber_key=?)
       ORDER BY id ASC LIMIT batchSize
    )
    -- subscriber_key = stable string per subscriber, e.g.
    -- 'scheduler.run-subscriber', 'enrichment.runner',
    -- 'layer.subscriber'

  for each row:
    try:
      await handler(event)
      UPDATE bus_outbox SET status='delivered',
                           delivered_at=now WHERE id=?
      UPDATE bus_offsets SET last_id=? WHERE subscriber_key=?
    catch err:
      attempt++; if attempt < maxAttempts:
        UPDATE bus_outbox SET status='pending',
                             error=<msg>, attempt=attempt
                             WHERE id=?
      else:
        INSERT INTO bus_dlq (...) -- one row per (subscriberKey, eventId)
        UPDATE bus_outbox SET status='dead' WHERE id=?
```

Idempotent subscribers can opt in to re-delivery on boot of
`in_flight` rows past a lease window; non-idempotent
subscribers see them as `abandoned` and a developer must
inspect.

Polling cadence: 250ms when caught up, batch of 50. Tuneable
in config. A SQLite `UPDATE` returning affected-rows == 0 means
no work and the loop sleeps. A future `pg_notify`-style signal
slots in via the same interface (a no-op on SQLite).

---

## 5. Schema sketch

```sql
-- 0012_scheduled_tasks.sql

CREATE TABLE scheduled_tasks (
  id                TEXT PRIMARY KEY,
  layer_id          TEXT NOT NULL REFERENCES layers(id),
  slug              TEXT NOT NULL,                 -- unique per layer
  kind              TEXT NOT NULL,                 -- registered handler key
  name              TEXT NOT NULL,                 -- human label
  status            TEXT NOT NULL CHECK (status IN
                       ('active','paused','canceled')),
  schedule_kind     TEXT NOT NULL CHECK (schedule_kind IN ('cron','interval')),
  cron_expression   TEXT,                          -- 5-field, when schedule_kind='cron'
  cron_timezone     TEXT,                          -- IANA tz, e.g. 'Europe/Amsterdam'
  interval_minutes  INTEGER,                       -- when schedule_kind='interval'
  config_json       TEXT NOT NULL DEFAULT '{}',    -- handler-specific config
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  backoff_base_ms   INTEGER NOT NULL DEFAULT 60000,
  backoff_max_ms    INTEGER NOT NULL DEFAULT 3600000,
  next_run_at       TEXT NOT NULL,                 -- ISO UTC
  last_run_at       TEXT,
  attempt           INTEGER NOT NULL DEFAULT 0,
  claimed_at        TEXT,
  claimed_by_pid    INTEGER,
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  created_by        TEXT NOT NULL REFERENCES users(id),
  updated_at        TEXT NOT NULL,
  updated_by        TEXT NOT NULL REFERENCES users(id),
  deleted_at        TEXT,
  deleted_by        TEXT REFERENCES users(id),
  UNIQUE (layer_id, slug)
);
CREATE INDEX idx_scheduled_tasks_due
  ON scheduled_tasks(status, next_run_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_scheduled_tasks_layer ON scheduled_tasks(layer_id);

CREATE TABLE scheduled_task_runs (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES scheduled_tasks(id),
  status        TEXT NOT NULL CHECK (status IN
                   ('requested','started','succeeded','failed',
                    'skipped_offline','skipped_no_handler','skipped_crashed')),
  attempt       INTEGER NOT NULL,
  requested_at  TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT,
  duration_ms   INTEGER,
  error         TEXT,
  correlation_id TEXT,                              -- for joining `events` + `llm_calls`
  triggered_by  TEXT NOT NULL CHECK (triggered_by IN ('schedule','manual','retry'))
);
CREATE INDEX idx_scheduled_task_runs_task
  ON scheduled_task_runs(task_id, requested_at DESC);
```

```sql
-- 0013_durable_bus.sql

CREATE TABLE bus_outbox (
  id              TEXT PRIMARY KEY,                -- same id as the events row
  type            TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  metadata_json   TEXT,
  correlation_id  TEXT,
  flow_id         TEXT,
  occurred_at     TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN
                     ('pending','in_flight','delivered','dead','abandoned')),
  attempt         INTEGER NOT NULL DEFAULT 0,
  claimed_at      TEXT,
  claimed_by_pid  INTEGER,
  delivered_at    TEXT,
  error           TEXT
);
CREATE INDEX idx_bus_outbox_pending
  ON bus_outbox(status, occurred_at) WHERE status IN ('pending','in_flight');

CREATE TABLE bus_offsets (
  subscriber_key  TEXT PRIMARY KEY,
  last_id         TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE bus_dlq (
  id              TEXT PRIMARY KEY,                -- new uuid per dead row
  outbox_id       TEXT NOT NULL REFERENCES bus_outbox(id),
  subscriber_key  TEXT NOT NULL,
  error           TEXT NOT NULL,
  attempts        INTEGER NOT NULL,
  failed_at       TEXT NOT NULL
);
CREATE INDEX idx_bus_dlq_subscriber
  ON bus_dlq(subscriber_key, failed_at DESC);
```

---

## 6. Shared types

```ts
// packages/shared/src/scheduled-tasks.ts
export type ScheduledTaskStatus = 'active' | 'paused' | 'canceled';
export type ScheduledTaskRunStatus =
  | 'requested'
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'skipped_offline'
  | 'skipped_no_handler'
  | 'skipped_crashed';

export interface ScheduledTaskSchedule {
  readonly kind: 'cron' | 'interval';
  readonly cronExpression?: string; // when kind === 'cron'
  readonly cronTimezone?: string; // IANA tz
  readonly intervalMinutes?: number; // when kind === 'interval'
}

export interface ScheduledTaskSummary {
  readonly id: string;
  readonly layerId: string;
  readonly slug: string;
  readonly kind: string;
  readonly name: string;
  readonly status: ScheduledTaskStatus;
  readonly schedule: ScheduledTaskSchedule;
  readonly nextRunAt: string;
  readonly lastRunAt: string | null;
  readonly attempt: number;
}

export interface ScheduledTaskRunSummary {
  readonly id: string;
  readonly taskId: string;
  readonly status: ScheduledTaskRunStatus;
  readonly attempt: number;
  readonly requestedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly error: string | null;
  readonly triggeredBy: 'schedule' | 'manual' | 'retry';
  readonly correlationId: string | null;
}

// packages/bus/src/types.ts (additive — interface unchanged)
export interface SubscribeOptions {
  /** Stable id used by the durable adapter for offset + DLQ rows. */
  readonly subscriberKey?: string;
  /** Opt in to replay of `in_flight` rows past the lease window. */
  readonly idempotent?: boolean;
}
```

---

## 7. Events

New family registered in
`apps/server/src/scheduled/events.ts` (constants exported so a
new type cannot land without a registration decision — mirrors
`ENTITY_EVENT_TYPES`).

| Type                          | When                                                 | Payload                                                             |
| ----------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| `scheduledtask.created`       | `POST /l/:slug/scheduled-tasks`                      | `{ taskId, layerId, kind, slug, scheduleKind, createdBy }`          |
| `scheduledtask.updated`       | `PATCH /l/:slug/scheduled-tasks/:slug`               | `{ taskId, patch, updatedBy }`                                      |
| `scheduledtask.deleted`       | `DELETE /l/:slug/scheduled-tasks/:slug`              | `{ taskId, slug, deletedBy }`                                       |
| `scheduledtask.paused`        | Manual pause + auto-pause after `maxAttempts`        | `{ taskId, reason: 'manual' \| 'maxAttempts' }`                     |
| `scheduledtask.resumed`       | Manual resume                                        | `{ taskId, resumedBy }`                                             |
| `scheduledtask.run.requested` | Scheduler tick + manual `POST .../runs`              | `{ taskId, runId, kind, layerId, triggeredBy, attempt }`            |
| `scheduledtask.run.started`   | Runner before handler invocation                     | `{ taskId, runId }`                                                 |
| `scheduledtask.run.succeeded` | Handler returned without throwing                    | `{ taskId, runId, durationMs }`                                     |
| `scheduledtask.run.failed`    | Handler threw                                        | `{ taskId, runId, error, attempt, willRetry: boolean, nextRunAt? }` |
| `scheduledtask.run.skipped`   | `skipped_offline` / `no_handler` / `skipped_crashed` | `{ taskId, runId, reason: 'offline' \| 'no_handler' \| 'crashed' }` |
| `bus.dlq.added`               | Durable bus moved a row to `bus_dlq`                 | `{ outboxId, subscriberKey, type, attempts, error }`                |
| `bus.dlq.replayed`            | Admin replayed a DLQ row                             | `{ outboxId, subscriberKey, replayedBy }`                           |

Anti-leak invariants:

- `error` carries handler `err.message` only — no stack, no
  payload echo. Stack lands in `console.error` like every other
  runner.
- `config_json` is NEVER published in events. Handlers that
  need secrets (none in phase 5) must read from
  `layer_attachments` or env, not from event payloads.
- Run events carry `correlationId` so the LLM call log and the
  events table can be joined for any handler that calls an LLM.
- DLQ events carry `type` (event name) but NOT the full payload —
  payload stays in `bus_outbox.payload_json`, accessible only
  via the admin DLQ page with proper authorization.

---

## 8. Authorization

Phase 5 reuses the phase-3 contract:

- All scheduled-task routes mount under
  `/l/:slug/scheduled-tasks/*` and use
  `createRequireLayer()` — non-member sees `404 errors.layer.notVisible`.
- **Read** (list, run history): anyone in `effectiveLayers`.
- **Edit** (create, update, pause/resume, run-now, delete):
  `canEditLayer` (layer ownership). System jobs live in
  `everyone` so only admins can edit them — exactly the
  existing semantics, no new code.
- Admin cross-layer view (`GET /admin/scheduled-tasks`) +
  DLQ view (`GET /admin/bus/dlq` + `POST /admin/bus/dlq/:id/replay`)
  use `requireAdmin` from phase 2.

---

## 9. Tests

1. **Bus contract tests** (`packages/bus/tests/contract.ts`) —
   parameterized over both adapters. Every existing assertion
   (publish ordering, isolation, middleware chain) runs against
   `DurableSqliteMessageBus` too. Adds:
   - publish + crash before consume → boot replay delivers exactly once
   - non-idempotent subscriber + `in_flight` past lease →
     `abandoned`, not redelivered
   - subscriber error past `maxAttempts` → `bus_dlq` row
   - admin replay reinserts as `pending`, delivers once
2. **Scheduler unit tests** —
   `apps/server/tests/scheduled/`:
   - cron-next is deterministic against a fixed clock
   - interval rolls forward correctly
   - claim is single-shot per row per tick (two workers, one
     wins)
   - backoff sequence (1m, 2m, 4m, …, capped) matches the formula
   - `skipped_offline` boot recovery runs exactly once per missed task
3. **Role split tests** — spin up two `apps/server/src/index.ts`
   processes with `--role=web` and `--role=worker` pointing at the
   same tempdir SQLite. Web POSTs a task, worker ticks, run lands.
4. **HTTP-route integration tests** — real bus + real DB:
   - CRUD round-trip; non-member → 404
   - `POST .../runs` triggers a `scheduledtask.run.requested`
   - pause/resume changes `status` and `next_run_at`
   - failed run → retry → eventual `paused` after `maxAttempts`
   - admin DLQ page lists rows; admin replay flips status
5. **Migration test** — `0012` and `0013` each apply cleanly to
   a fresh DB and are forward-only.
6. **`tests/docs/job-inventory.test.ts`** (new) — fails when a
   handler is registered via `registerScheduledTaskHandler` but
   not listed in `docs/dev/architecture/job-inventory.md`.
   Mirrors the entity-module ↔ docs check `AGENTS.md`
   describes but does not yet enforce.
7. **Extended smoke** (`apps/server/tests/smoke.test.ts`):
   register a one-shot task with `intervalMinutes=1`, force a
   tick, assert one `scheduled_task_runs` row with
   `status='succeeded'`.
8. **Worker smoke** (`apps/server/tests/smoke-worker.test.ts`) —
   new: pre-seed DB, boot `--role=worker`, assert ticks + DLQ
   semantics end-to-end in a separate process.

---

## 10. Dependencies

- **`croner`** (new). Lightweight cron parser/scheduler, zero
  runtime deps, ESM, TypeScript types, ~7 KB minified, supports
  RFC-5545-style weekdays + IANA timezones, Bun-compatible.
  Per `AGENTS.md §Dependencies`: chosen over hand-rolling a
  5-field parser because DST + leap-year edge cases are a
  well-trodden footgun, and over `node-cron` / `cron` because
  those carry deps and Node-only assumptions. Registered in
  `apps/server/package.json` only — not pulled into shared.

No other new runtime deps. The scheduler service and the
durable bus adapter are plain TypeScript over `bun:sqlite` +
the existing `MessageBus`.

---

## 11. Docs impact

- New: `docs/dev/architecture/scheduled-tasks.md` — the
  registry, tick loop, event lifecycle, retry/backoff,
  boot-recovery semantics. Cross-links to ADR 0018 and to the
  per-handler entries in the job inventory.
- New: `docs/dev/architecture/job-inventory.md` — the table
  `AGENTS.md §Pull Requests` already references. Phase 5 is the
  first time we have a generic registry to inventory; the doc
  lists every handler `kind` registered via the per-domain
  helpers in `src/server/index.ts`, with one row per kind:
  `kind | layer scope | default cadence | owner module |
touches LLM?`. Matching `tests/docs/job-inventory.test.ts`
  fails CI if a registered kind is missing from the table.
- New: `docs/user/guides/scheduled-tasks.md` — user-facing
  walkthrough (create, pause, run-now, read history).
- Updated:
  - `docs/dev/architecture/overview.md` — add a "scheduled"
    band + a note on the web/worker process split.
  - `docs/dev/architecture/event-bus.md` — rewritten around
    the single production adapter (`DurableSqliteMessageBus`)
    plus the `scheduledtask.*` taxonomy. The in-memory
    adapter is documented only in the "testing" appendix.
    Supersedes the §4.2 / §11 "in-memory only" framing.
  - `docs/dev/architecture/llm-and-telemetry.md` — note that
    `llm.calls.prune` is now a scheduled-task handler, not a
    bespoke `setInterval`.
  - `docs/dev/setup/running.md` — document the
    `--role=web|worker|all` flag and the two deployment recipes.
- New ADRs:
  - `0018 — generic scheduled tasks` — cron+interval choice,
    retry/backoff model, claim semantics, `croner` dependency.
  - `0019 — durable SQLite-backed message bus` — outbox +
    offsets + DLQ shape, idempotency opt-in, why SQLite over
    Redis/NATS for v1, the trigger for revisiting (a real
    second host).

---

## 12. i18n impact

New namespaces `scheduledTasks.*` + `admin.bus.*`:

- `scheduledTasks.list.*` — page title, empty state, columns
- `scheduledTasks.dialog.*` — create / edit dialog labels +
  validation errors
- `scheduledTasks.schedule.cron`, `scheduledTasks.schedule.interval`
- `scheduledTasks.status.active|paused|canceled`
- `scheduledTasks.run.status.*` — one per run-status enum value
- `scheduledTasks.actions.runNow|pause|resume|delete`
- `admin.bus.dlq.*` — list page + replay confirm dialog
- `errors.scheduledTasks.*` —
  `notFound|slugTaken|invalidCron|invalidInterval|handlerUnknown|notInLayer`
- `errors.bus.*` — `dlqReplayFailed|outboxClaimRace`

English is primary fallback. Missing keys fail
`bun run i18n:check`.

---

## 13. Accessibility impact

Every new view follows `AGENTS.md §Accessibility`: semantic
HTML, keyboard-operable buttons (Pause / Resume / Run now /
Replay), labelled inputs in the create dialog, focus visible
on the table rows, screen-reader-friendly error states on
failed runs (run-history row uses `role="status"` for the
latest error). DLQ replay confirms via the existing shared
confirmation dialog (same pattern as the layer "Delete layer"
danger zone shipped earlier this week).

---

## 14. Risks

| Risk                                                                | Likelihood | Impact | Mitigation                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tick drift after a long suspend (laptop sleep)                      | High       | Low    | Each tick re-anchors `next_run_at` from `claimed_at`, not from `lastTick + interval`. Documented in the user guide ("we don't backfill missed slots").                                                             |
| Long-running handler blocks subsequent ticks                        | Low        | Med    | The scheduler tick only `bus.publish`-es; the handler runs on the bus consumer loop, which is async-safe. The scheduler tick itself never awaits a handler.                                                        |
| Two ticks (two workers) claim the same task                         | Med        | Med    | `UPDATE … WHERE claimed_at IS NULL OR claimed_at < now-<lease>` is atomic in SQLite WAL mode; the affected-rows count gates the publish.                                                                           |
| Two consumers claim the same outbox row                             | Med        | Med    | Same atomic-UPDATE pattern on `bus_outbox`; `bus_offsets` is per-subscriber, so two consumers of the same subscriber would step on each other — phase 5 ships **one consumer per subscriberKey** and documents it. |
| `croner` produces a wrong cron-next around DST                      | Low        | Med    | A deterministic test fixture covers spring-forward + fall-back per timezone. If `croner` fails on a real edge case, swap is local to one file.                                                                     |
| Handler throws something un-serialisable as `error`                 | Low        | Low    | `String(err)` fallback; the bus event carries a clipped string, the full thing goes to `console.error`.                                                                                                            |
| User pauses `llm.calls.prune` and the LLM-call log grows unbounded  | Low        | Med    | The system jobs are `everyone`-layer + admin-edit only; the admin UI shows a warning banner when a system job is paused. User guide flags it.                                                                      |
| SQLite write contention with two processes hammering `bus_outbox`   | Med        | Med    | WAL mode + batched UPDATEs + 250ms idle sleep; benchmark in 5.1 against a 50k-event seed. If hot, raise the batch size; if still hot, document as the trigger for a real transport.                                |
| Non-idempotent subscriber gets replayed                             | Low        | High   | Idempotency is opt-in (`default false`); non-idempotent `in_flight` rows move to `abandoned` and need admin action. Documented in ADR 0019 + the troubleshooting guide.                                            |
| Outbox grows unbounded                                              | Med        | Low    | `delivered` rows pruned by a scheduled task (`bus.outbox.prune`) registered out-of-the-box; default 7-day retention. Same dogfood pattern as `llm.calls.prune`.                                                    |
| Web/worker process split adds deployment confusion                  | Med        | Low    | `--role=all` stays the default; only ops-focused deployments split. `docs/dev/setup/running.md` covers both recipes with copy-pasteable invocations.                                                               |
| Dev experience degrades from removing the in-memory production path | Low        | Low    | Tests still have the in-memory fixture; dev itself uses the same SQLite path it already opens for entities. Marginal cost = the 250ms outbox poll, which `unref`-s the timer.                                      |

---

## 15. Open questions

1. **Per-kind default schedule.** Should `registerScheduledTaskHandler`
   accept a `defaultSchedule` that the UI offers as a sensible
   pre-fill on the create dialog? (Lean: yes, optional, in 5.3.)
2. **Run-history retention default.** Default is "keep last 200
   per task **or** runs older than 30 days, whichever cuts more"?
   Resolve in 5.3.
3. **Dashboard widget format.** "Recent runs" widget: cross-task
   list of the last 10 runs in the current layer, or per-task
   compact strip? Resolve in 5.6 once the list page exists.
4. **Manual `Run now` while a tick is in flight.** Reject with
   409 or queue behind? (Lean: queue with `triggeredBy='manual'`,
   no rejection; resolve in 5.4.)
5. **DLQ replay batching.** Single-row replay only, or "replay
   all dead rows for this subscriber"? (Lean: start with single
   row + a confirm; bulk replay is a follow-up.)
6. **Bus-consumer poll cadence on the Electron sidecar.** The
   sidecar runs `--role=all` and binds to the durable adapter
   like every other role (no in-memory fallback per the
   decision above). The 250ms idle poll is cheap on disk but
   adds a wake every quarter-second. Acceptable? Or should
   the sidecar widen its idle poll to 1 s? (Lean: leave at
   250 ms — `events` is small, the wake is sub-millisecond;
   reopen only if a profile shows it matters. Resolve in 5.2.)

---

## 16. Plan close-out (filled in when phase 5 ships)

Each sub-phase's commit updates this section with: what shipped,
where the developer narrative now lives, which ADRs landed,
which follow-ups remain. On all sub-phases `done`, the plan
moves to `docs/dev/plans/done/phase-05-scheduled-tasks.md` and
the tasklist `Related document` paths get rewritten in the same
commit.
