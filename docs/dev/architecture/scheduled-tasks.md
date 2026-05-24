# Scheduled tasks

> Status: living document.
> Owners: phase 5 introduced this; future phases extend it.
> Source code: `apps/server/src/scheduled/`,
> `apps/server/src/storage/migrations/0012_scheduled_tasks.sql`,
> `packages/shared/src/scheduled-tasks.ts`,
> `apps/server/tests/scheduled/`.

This is the single-page tour of bunny2's generic scheduled-task
runtime. Companion to [`event-bus.md`](./event-bus.md),
[`overview.md`](./overview.md),
[`job-inventory.md`](./job-inventory.md), and ADRs
[`0018`](../decisions/0018-generic-scheduled-tasks.md) /
[`0019`](../decisions/0019-durable-sqlite-message-bus.md).

---

## 1. What ships in phase 5

A registry of `kind`-keyed handlers, a tick service that publishes
"run requested" events for due tasks, a run-subscriber that drives
each handler through `started → succeeded | failed | skipped`, a
retry/backoff state machine, and a HTTP + web surface for managing
tasks per layer.

Four built-in handlers are seeded into the `everyone` layer on first
boot:

- `llm.calls.prune` — daily LLM-call retention prune
- `system.healthcheck` — heartbeat into `events`
- `scheduled.runs.prune` — runs-table retention
- `bus.outbox.prune` — durable-bus outbox / DLQ retention

A handler is a plain TypeScript function registered via
`registerScheduledTaskHandler({ kind, run })`. Tasks reference
handlers by `kind`; multiple tasks (in different layers) can use
the same kind.

The full catalogue with cadence + owner module is in
[`job-inventory.md`](./job-inventory.md), enforced by
`bun run docs:check` and `tests/docs/job-inventory.test.ts`.

---

## 2. Data model

```
scheduled_tasks
  id                TEXT PRIMARY KEY
  layer_id          TEXT NOT NULL REFERENCES layers(id)
  slug              TEXT NOT NULL                 -- unique per layer
  kind              TEXT NOT NULL                 -- handler key
  name              TEXT NOT NULL                 -- human label
  status            active | paused | canceled
  schedule_kind     cron | interval
  cron_expression   5-field cron, when schedule_kind = 'cron'
  cron_timezone     IANA tz, e.g. 'Europe/Amsterdam'
  interval_minutes  positive integer, when schedule_kind = 'interval'
  config_json       handler-specific config blob
  max_attempts      default 3
  backoff_base_ms   default 60_000
  backoff_max_ms    default 3_600_000
  next_run_at       ISO UTC, computed on save + after each run
  last_run_at       ISO UTC | NULL
  attempt           0 on success / fresh; 1..max on retry
  claimed_at        ISO UTC | NULL  (claim lease)
  claimed_by_pid    INTEGER | NULL  (claim lease)
  version           bumped on every UPDATE
  created_at / created_by / updated_at / updated_by / deleted_at / deleted_by

scheduled_task_runs
  id            TEXT PRIMARY KEY
  task_id       TEXT NOT NULL REFERENCES scheduled_tasks(id)
  status        requested | started | succeeded | failed
                | skipped_offline | skipped_no_handler | skipped_crashed
  attempt       INTEGER NOT NULL
  requested_at / started_at / finished_at  -- ISO UTC
  duration_ms / error / correlation_id
  triggered_by  schedule | manual | retry
```

Indices: `idx_scheduled_tasks_due(status, next_run_at) WHERE
deleted_at IS NULL`, `idx_scheduled_tasks_layer(layer_id)`,
`idx_scheduled_task_runs_task(task_id, requested_at DESC)`.

UUID ids, soft-delete, version-counted — every phase-3+ entity
convention applies.

---

## 3. Runtime

Three independent components share the same SQLite file and the same
`MessageBus`:

```
┌─────────────────────────┐  publish('scheduledtask.run.requested')
│  Scheduler tick         │ ─────────────────────────────────────────►
│  every 30 s, role ∈     │
│  {worker, all}          │
└─────────────────────────┘
                                       │
                                       ▼
                          ┌──────────────────────────┐
                          │  DurableSqliteMessageBus │  (ADR 0019)
                          │  outbox + offsets + DLQ  │
                          └──────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────┐   handle(event)         ┌──────────────────────┐
│  Run subscriber         │ ◄──────────────────────►│  Handler             │
│  on every role          │   updates run row       │  (kind-resolved fn)  │
│  idempotent: true       │                         └──────────────────────┘
└─────────────────────────┘
```

### 3.1 Scheduler tick (`apps/server/src/scheduled/scheduler.ts`)

Role-gated: arms its 30 s timer only on `worker` / `all`. `web`
keeps the scheduler object around for shape parity but
`start()` is a no-op. Every tick:

1. `SELECT id FROM scheduled_tasks WHERE status='active' AND
deleted_at IS NULL AND next_run_at <= :now LIMIT 50`.
2. For each id, atomic claim:
   ```sql
   UPDATE scheduled_tasks
      SET claimed_at = :now, claimed_by_pid = :pid
    WHERE id = :id
      AND (claimed_at IS NULL OR claimed_at < :now - :leaseMs)
   ```
   Affected-rows = 1 → we own the tick. = 0 → another worker won;
   silently move on.
3. `INSERT INTO scheduled_task_runs (status='requested', …)`.
4. `bus.publish('scheduledtask.run.requested', { taskId, runId, … },
correlationId)`.

The tick never `await`-s the handler — that runs on the bus consumer
loop and must not block subsequent ticks (ADR 0018 §4 claim
semantics, plan §14 risk).

### 3.2 Run subscriber (`apps/server/src/scheduled/run-subscriber.ts`)

Subscribes to `scheduledtask.run.requested` with `{ subscriberKey:
'scheduled.run-subscriber', idempotent: true }`. The subscriber
declares itself idempotent because the run row is the dedup key —
replaying the same `requested` event lands on the same `runId` and
the `updateRun(...)` calls overwrite the same row (ADR 0019 §4).

Per event:

1. Resolve `task = repo.getTaskById(taskId)`. Missing → no-op
   (task was soft-deleted between tick and dispatch).
2. Resolve `handler = getScheduledTaskHandler(task.kind)`. Missing →
   `markSkipped(reason='no_handler')`, re-anchor `next_run_at`, release
   claim. Missing handlers reflect a deployment gap, not a transient
   error — `attempt` is **not** incremented.
3. `updateRun({status:'started', startedAt:now})`,
   `publish('scheduledtask.run.started')`.
4. Invoke `handler.run({ task, run, ctx })`. Wrapped in try/catch.
5. **Success** — `updateRun({status:'succeeded', finishedAt:now,
durationMs})`, `attempt → 0`, `next_run_at → computeNextRun(...)`,
   `publish('scheduledtask.run.succeeded')`.
6. **Throw** — `updateRun({status:'failed', error:clipped})`,
   `attempt += 1`, retry-or-pause per §3.3, `publish('scheduledtask.run.failed')`
   (+ `scheduledtask.paused {reason:'max_attempts'}` if exhausted).
7. Finally — `repo.releaseClaim(...)`. Releases happen on every
   terminal state so the next tick can pick the task up at its new
   `next_run_at`.

A handler error is **never** surfaced to the bus dispatch (which
would push the row into the bus DLQ — that surface is reserved for
infrastructure failures, not application-level handler failures).
Handler stacks land in `console.error`; the clipped message lands
on the run row and in the `failed` payload.

### 3.3 Retry / backoff

```
nextAttempt = task.attempt + 1
if nextAttempt < task.maxAttempts:
  backoffMs = min(task.backoffMaxMs,
                  task.backoffBaseMs * 2^(nextAttempt - 1))
  scheduleNext = computeNextRun(task.schedule, now)
  backoffNext  = now + backoffMs
  task.nextRunAt = max(scheduleNext, backoffNext)
  publish('scheduledtask.run.failed', { willRetry: true,
                                        nextRunAt: task.nextRunAt })
else:
  task.status = 'paused'  -- auto-pause; manual resume required
  task.nextRunAt = computeNextRun(task.schedule, now)
  publish('scheduledtask.run.failed',
          { willRetry: false, nextRunAt: task.nextRunAt })
  publish('scheduledtask.paused', { reason: 'max_attempts' })
```

The `max(scheduleNext, backoffNext)` anchor matters: a daily job
that fails at 07:00 plus a 1 m backoff would otherwise re-fire on
the same 07:00 slot tomorrow, doubling the run on the next day. We
push it past the next cron slot for short cadences and slip one
cadence for daily / weekly. ADR 0018 §2.

Defaults: `maxAttempts=3`, `backoffBaseMs=60_000`,
`backoffMaxMs=3_600_000` → 1 m, 2 m, 4 m, …, capped at 1 h.

Paused-after-failure tasks surface in the admin UI with a banner
explaining the auto-pause reason; an operator clicks "Resume" to
reset `attempt` to 0 and flip the status back to `active`.

### 3.4 Boot recovery

The scheduler `start()` runs once per process on `worker`/`all`:

```
graceMs = graceMultiplier (5) * leaseMs (5 min) = 25 min
SELECT id FROM scheduled_tasks
 WHERE status='active' AND deleted_at IS NULL
   AND next_run_at < now - graceMs
→ INSERT one 'skipped_offline' run row per task
→ next_run_at = computeNextRun(schedule, now)
→ publish('scheduledtask.run.skipped', { reason: 'offline' })
```

We record **one** skipped row per task, not one per missed slot. A
long downtime that crosses many cron firings produces one
diagnostic record and a fresh `next_run_at`. ADR 0018 §"Non-decisions"
(no backfill).

In-flight bus rows past their lease window are handled by the
durable bus's own boot recovery (ADR 0019 §4): idempotent
subscribers see them as `pending` again; non-idempotent ones move
to `abandoned`.

---

## 4. Event taxonomy

Registered in `apps/server/src/scheduled/events.ts` —
`SCHEDULED_TASK_EVENT_TYPES` is the closed set, so a new type cannot
land without a registration decision (same pattern as
`ENTITY_EVENT_TYPES` from phase 4).

| Type                          | When                                                         | Payload                                                             |
| ----------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------- |
| `scheduledtask.created`       | `POST /l/:slug/scheduled-tasks`; system-task seed            | `{ taskId, layerId, kind, slug, scheduleKind, createdBy }`          |
| `scheduledtask.updated`       | `PATCH /l/:slug/scheduled-tasks/:slug`                       | `{ taskId, patch, updatedBy }`                                      |
| `scheduledtask.deleted`       | `DELETE /l/:slug/scheduled-tasks/:slug`                      | `{ taskId, slug, deletedBy }`                                       |
| `scheduledtask.paused`        | Manual pause + auto-pause after `maxAttempts`                | `{ taskId, reason: 'manual' \| 'max_attempts', actorId }`           |
| `scheduledtask.resumed`       | Manual resume                                                | `{ taskId, resumedBy }`                                             |
| `scheduledtask.run.requested` | Scheduler tick + manual `POST .../runs` + retry re-emission  | `{ taskId, runId, kind, layerId, triggeredBy, attempt }`            |
| `scheduledtask.run.started`   | Runner before handler invocation                             | `{ taskId, runId }`                                                 |
| `scheduledtask.run.succeeded` | Handler returned without throwing                            | `{ taskId, runId, durationMs }`                                     |
| `scheduledtask.run.failed`    | Handler threw                                                | `{ taskId, runId, error, attempt, willRetry, nextRunAt }`           |
| `scheduledtask.run.skipped`   | `skipped_offline` / `skipped_no_handler` / `skipped_crashed` | `{ taskId, runId, reason: 'offline' \| 'no_handler' \| 'crashed' }` |

Anti-leak invariants:

- `error` carries handler `err.message` only — clipped to 500
  characters. Stacks land in `console.error`, never in a payload.
- `config_json` is **never** published in events. Handlers needing
  secrets read from `layer_attachments` or env at run-time, not
  from the event payload.
- Run events carry `correlationId` so the LLM call log and the
  events table can be joined for any handler that calls an LLM.
  ADR 0013's secret-strip invariant transitively applies.

Bus-DLQ events (`bus.dlq.added`, `bus.dlq.replayed`) are owned by
the durable adapter; see [`event-bus.md`](./event-bus.md) §3 for the
schema.

---

## 5. Roles + the web/worker split

Phase 5 introduces `--role=web|worker|all` (see
[`setup/running.md`](../setup/running.md)).

| Component                 | web | worker | all |
| ------------------------- | --- | ------ | --- |
| HTTP listener             | ✔   | —      | ✔   |
| Durable bus publish       | ✔   | ✔      | ✔   |
| Durable bus consume loop  | ✔   | ✔      | ✔   |
| Scheduler **tick**        | —   | ✔      | ✔   |
| Scheduled-task seed       | ✔   | ✔      | ✔   |
| Built-in handler registry | ✔   | ✔      | ✔   |
| Run subscriber            | ✔   | ✔      | ✔   |
| Boot recovery (scheduler) | —   | ✔      | ✔   |
| Connector poll runner     | —   | ✔      | ✔   |
| Enrichment runner         | —   | ✔      | ✔   |
| Todo→calendar projection  | —   | ✔      | ✔   |

`web` constructs the scheduler so route handlers can call
`tickOnce()` from the manual "Run now" path; the timer never arms.
The run subscriber listens on every role: the worker actually
executes the handler, but a `web` process owning the subscription is
correctness-safe because the durable outbox claim is atomic — at
most one process delivers each row. A future phase may strip the
subscription from `web` once we have a sharper isolation boundary.

---

## 6. Authorization

Reuses the phase-3 contract:

- All scheduled-task routes mount under `/l/:slug/scheduled-tasks/*`
  and use `createRequireLayer()` — non-member sees
  `404 errors.layer.notVisible`.
- **Read** (list, run history): anyone in `effectiveLayers`.
- **Edit** (create, update, pause/resume, run-now, delete):
  `canEditLayer` (layer ownership).
- System jobs live in the `everyone` layer; `canEditLayer` resolves
  to admin-only there — no new "system" layer type required.
- Admin cross-layer view (`GET /admin/scheduled-tasks`) + DLQ view
  (`GET /admin/bus/dlq` + `POST /admin/bus/dlq/:id/replay`) use
  `requireAdmin`.

---

## 7. Adding a new handler

1. Pick a stable `kind` (`<domain>.<verb>`, lowercase, dot-separated).
   The convention is `/^[a-z][a-z0-9.\-_]*$/`; the registry does not
   enforce a regex so test fixtures can register weird kinds.
2. Implement the handler in your domain module:
   ```ts
   export const myHandler: ScheduledTaskHandler = {
     kind: 'reports.weekly-digest',
     defaultSchedule: {
       kind: 'cron',
       cronExpression: '0 7 * * MON',
       cronTimezone: 'Europe/Amsterdam',
     },
     async run({ task, run, db, bus, llm, logger, correlationId }) {
       // ... your work; throw to signal failure.
     },
   };
   ```
3. Register from your domain boot hook
   (`registerScheduledTaskHandler(myHandler)`) before
   `scheduler.start()` runs.
4. Add a row to [`job-inventory.md`](./job-inventory.md) — both
   `bun run docs:check` and `tests/docs/job-inventory.test.ts` fail
   if you forget.
5. (Optional) Seed a default task row in your domain's seed module
   if every install should have one out-of-the-box. Built-in system
   tasks use `seedSystemScheduledTasksIfNeeded` as the reference.

---

## 8. Testing scheduled tasks

- **Unit** — `apps/server/tests/scheduled/schedule.test.ts`,
  `…/registry.test.ts`, `…/backoff.test.ts`. Pure helpers, fixed
  clocks, no DB.
- **Repo** — `…/scheduled-tasks-repo.test.ts`. Real SQLite, drives
  every repo method.
- **Scheduler tick** — `…/scheduled/scheduler.test.ts`. Real bus,
  real repo, asserts atomic claim + publish.
- **Run subscriber** — `…/scheduled/run-subscriber.test.ts`. Drives
  every terminal-state transition.
- **End-to-end** — `…/scheduled/end-to-end.test.ts`. Tick → publish
  → consume → handler succeeds → run row + next_run_at advanced.
- **Boot recovery** — `…/scheduled/scheduler.test.ts` covers the
  `skipped_offline` path against a stale `next_run_at`.
- **Smoke** — `apps/server/tests/smoke.test.ts` registers a one-shot
  task and asserts the runs-table reaches `succeeded`. `apps/server/
tests/smoke-worker.test.ts` does the same with the durable bus and
  the worker role.

The job-inventory test (`tests/docs/job-inventory.test.ts`) parses
the inventory table and asserts every registered `kind` has a row
and every row's `kind` is registered.

---

## 9. Future extensions

- **Per-handler default retry parameters.** Currently the
  per-task fields are the source of truth. A handler may want to
  declare "weekly digests should retry 5 times, not 3" — that
  moves into the handler descriptor in a later phase.
- **Bulk DLQ replay.** Single-row replay only in phase 5; a "replay
  every dead row for this subscriber" affordance is a follow-up.
- **Webhook / external triggers.** Phase 5 is purely time-based.
  External-trigger entrypoints land alongside the chat-pipeline
  work in phase 6+.
- **Cross-host scheduling.** A second host needs the durable bus
  swapped to a transport-shared adapter; ADR 0019 records the
  trigger and shape.
