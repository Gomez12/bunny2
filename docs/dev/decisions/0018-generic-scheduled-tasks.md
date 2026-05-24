# ADR 0018 — Generic scheduled tasks

- Status: accepted
- Date: 2026-05-24
- Phase: 5 (the whole 5.0–5.7 block)
- Related: `docs/dev/plans/done/phase-05-scheduled-tasks.md` §1, §4.2,
  §4.3, §10; `docs/dev/architecture/scheduled-tasks.md`;
  `docs/dev/architecture/job-inventory.md`;
  ADR [`0019`](./0019-durable-sqlite-message-bus.md);
  Source code: `apps/server/src/scheduled/`,
  `apps/server/src/storage/migrations/0012_scheduled_tasks.sql`,
  `packages/shared/src/scheduled-tasks.ts`.

---

## Context

Phase 5 is the point where the project gains its first generic
background-work primitive. Before phase 5 every periodic job
(`llmPrune`, `connectorRunner`, `enrichmentRunner`,
`todoCalendarProjection`) was a hand-rolled `setInterval`. That was
fine while the set was small and every job lived in one place, but
the overall plan §8 Phase 5 explicitly anchored the next wave of
work — digests, sweeps, periodic agents, retention pruning — to a
generic scheduler so non-entity work could be defined, scheduled,
observed, retried, and paused without writing yet another bespoke
runner.

This ADR records the choices that are not obvious from the plan:
schedule shape, retry / backoff formula, claim semantics, the
`croner` dependency, and the idempotency opt-in.

---

## Decisions

### 1. Cron **and** interval, zod-mutex per task

Both schedule kinds are accepted on `scheduled_tasks`:

- **cron** — a 5-field cron expression evaluated in an IANA
  timezone (default `Europe/Amsterdam`). Right for "Monday morning"
  digests, daily prunes pinned to a wall-clock hour, weekly reports.
- **interval** — a positive `intervalMinutes`. Right for ops jobs
  ("every 30 minutes") and quickly-iterated handlers in dev.

A task is one or the other, never both. The zod schema mutexes
`schedule_kind` so the create dialog and the HTTP layer cannot land
an ambiguous row. `next_run_at` is stored in UTC ISO regardless of
the schedule kind so the scheduler tick can compare it lexically.

Alternative considered: cron-only. Rejected — interval is the
ergonomic fit for retention pruning and healthchecks, which is what
the built-in set actually uses. Forcing them into cron would push
the operator into wall-clock thinking ("when's a good off-peak
moment?") for jobs that just want a cadence.

### 2. Retry/backoff: exponential, capped, anchored after the cron slot

On a failed run the run-subscriber computes:

```
attempt = task.attempt + 1
if attempt < task.maxAttempts:
  backoff = min(backoff_max, backoff_base * 2^(attempt-1))
  next_run_at = max(cron-or-interval-next, now + backoff)
else:
  status = 'paused'  -- auto-pause after maxAttempts
  next_run_at = cron-or-interval-next  -- so manual resume picks up
                                       -- the proper cadence
```

Defaults: `max_attempts = 3`, `backoff_base_ms = 60_000`,
`backoff_max_ms = 3_600_000` (1m, 2m, 4m, …, capped at 1h). The
`max(...)` anchor is deliberate: if a daily job fails at 07:00:01,
we do **not** want the retry to land back at the same 07:00 slot
on the next day. Pushing it forward by the backoff keeps the
retries short of the next scheduled slot for sub-day cadences and
slips one cadence for daily / weekly jobs.

The exponential schedule, the cap, and the per-task overrides are
the same pattern bunqueue uses; we picked the formula explicitly so
swapping the bus transport later (per ADR 0019's deferred multi-host
case) does not also change the retry behaviour.

### 3. Auto-pause after `maxAttempts`, never delete

The run row is the diagnostic record. A task that fails its retry
budget moves to `status='paused'` with `paused.reason='max_attempts'`,
and stays paused until an operator either resumes it (status →
`active`, `attempt` → 0) or deletes the task. We never auto-delete
a task. The reasoning: an auto-deletion would also lose the run
history that an operator needs to investigate the failure.

The admin UI surfaces `paused` tasks with a "Resume" button and a
prominent banner explaining the auto-pause reason. The user guide
calls this out: "When an error pauses a task, who can edit it?"

### 4. Claim semantics: atomic UPDATE on the row, per-PID lease

The scheduler tick does NOT publish for every due row indiscriminately.
It runs:

```sql
UPDATE scheduled_tasks
   SET claimed_at = :now,
       claimed_by_pid = :pid
 WHERE id = :id
   AND (claimed_at IS NULL OR claimed_at < :now - :leaseMs)
```

Affected-rows = 1 means we own the tick; affected-rows = 0 means
another worker beat us and we silently move on. The lease window
defaults to 5 minutes — long enough that an in-progress handler
will not be re-claimed mid-run, short enough that a crashed worker
releases its claim within a sane window.

This is the same atomic-UPDATE pattern used by the durable bus's
outbox claim (ADR 0019). Two ticks racing for the same task is a
known case and falls out cleanly: the loser's affected-rows comes
back zero and skips the publish.

The claim is released on every terminal run state (`succeeded`,
`failed`, `skipped_*`) via `repo.releaseClaim`. The
release-then-re-anchor ordering matters: a stuck `claimed_at` would
block the retry's next tick.

### 5. `croner` dependency

Phase 5 adopts `croner` as the cron parser/scheduler.

- Lightweight (~7 KB minified), zero runtime deps, ESM, TypeScript
  types, Bun-compatible.
- Supports IANA timezones, including DST and leap-year edges.
- Single import in `apps/server/src/scheduled/schedule.ts`; not
  pulled into shared or the web bundle.

Rejected alternatives:

- **Hand-roll a 5-field parser.** DST + leap-year edges are a
  well-trodden footgun. A bug there would be a silent run-too-soon
  or run-too-late; the cost of carrying a third-party parser is
  trivial compared to that risk.
- **`node-cron` / `cron`.** Heavier, carry Node-only assumptions
  (some use `child_process` for timezone shimming), more deps.

A deterministic test fixture covers spring-forward and fall-back in
the project's default timezone (`Europe/Amsterdam`). If `croner`
fails on a real edge case the swap is local to one file.

### 6. Idempotency opt-in on the subscriber, default false

Subscribers can pass `{ idempotent: true }` to `bus.subscribe(...)`.
The durable adapter uses this on boot recovery: an `in_flight`
outbox row past the lease window is **re-pended** for an idempotent
subscriber and **abandoned** otherwise (status flips to `abandoned`
and an admin signal fires).

The scheduler run-subscriber declares itself idempotent — the run
row is the dedup key, so replaying a `requested` event lands on the
same `runId` and the `updateRun(...)` calls overwrite the same row
without doubling work. Connector handlers stay opt-out pending
per-connector review.

The default is `false` because re-running a non-idempotent handler
("send the customer their weekly digest") would be worse than
abandoning it for an operator to investigate. Forcing the explicit
opt-in keeps the safer path the default.

---

## Consequences

- The four built-in handlers (`llm.calls.prune`, `system.healthcheck`,
  `scheduled.runs.prune`, `bus.outbox.prune`) are now visible,
  schedulable, pausable, and observable through the same surface as
  any future user-registered job. The job inventory
  (`docs/dev/architecture/job-inventory.md`) is the canonical
  catalogue.
- New domain modules add a single `registerScheduledTaskHandler(...)`
  call from their own boot wiring; the boot orchestrator does not
  need to know about them. Adding a `kind` to the inventory table is
  enforced by `docs:check` + `tests/docs/job-inventory.test.ts`.
- The scheduler tick is intentionally tiny — it claims, inserts a
  run row, and publishes. The actual handler work happens on the bus
  consumer loop. A long-running handler therefore cannot block
  subsequent ticks (plan §14 risk).
- `connectorRunner`, `enrichmentRunner`, and `todoCalendarProjection`
  stay outside the registry (per-link cadence / event-driven). They
  do gain crash-safety from the durable bus (ADR 0019) without code
  changes.

---

## Non-decisions (intentional)

- **No backfill of missed slots.** A laptop sleep or a deploy
  downtime that crosses several cron firings is recorded as a single
  `skipped_offline` row per task and `next_run_at` advances to the
  next slot. Backfilling would storm the bus after a long outage and
  the operator's intent on resume is "go forward from here", not
  "replay yesterday's seven prunes".
- **No per-handler retry override.** The retry / backoff parameters
  live on the **task** row (`max_attempts`, `backoff_base_ms`,
  `backoff_max_ms`), not the handler. A handler that wants different
  retry behaviour configures it at task creation time. Per-handler
  defaults are tracked as a follow-up (see plan §16 close-out).
- **No webhook / external-trigger entrypoint.** Phase 5 is purely
  time-based; manual `POST /l/:slug/scheduled-tasks/:slug/runs` is
  the only non-clock trigger.
- **No fine-grained per-task ACL.** Layer ownership (`canEditLayer`)
  is the edit gate; system jobs live in the `everyone` layer so
  admins manage them via the existing admin path. No new "system"
  layer type.
