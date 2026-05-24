# Scheduled tasks

bunny2 can run periodic jobs on your behalf — a weekly digest, a
nightly clean-up, a heartbeat that confirms everything is alive.
This guide explains what a scheduled task is, how to create one,
and how to read its history.

> Developers / admins: the technical write-up lives in
> `docs/dev/architecture/scheduled-tasks.md` and the registered
> handler catalogue in
> `docs/dev/architecture/job-inventory.md`. Decisions:
> `docs/dev/decisions/0018-generic-scheduled-tasks.md` and
> `docs/dev/decisions/0019-durable-sqlite-message-bus.md`.

---

## 1. What is a scheduled task?

A **scheduled task** is a recurring job tied to a layer. Each task
points at a registered **handler** (the actual work — for example
"prune old LLM-call logs", "send the team a weekly summary") and a
**schedule** (when the handler should run). The same handler can
be reused by several tasks across different layers, each with its
own cadence.

bunny2 ships with a small set of built-in system tasks that live
in the **Everyone** layer. They keep the system tidy:

- **LLM calls retention prune** — daily clean-up of the LLM
  call log past its retention window.
- **System healthcheck** — short heartbeat that writes one event
  every five minutes; useful when checking whether the server is
  alive.
- **Scheduled-task run-history prune** — keeps the run history
  bounded.
- **Bus outbox prune** — trims the durable message bus's outbox.

You'll see these on the admin overview page (`/admin/scheduled-tasks`)
and on the **Everyone** layer's scheduled-tasks page. Only
administrators can edit them — that falls out of the layer's
edit gate automatically.

---

## 2. Creating a scheduled task

You can create your own scheduled tasks inside any layer where you
have edit rights:

1. Switch to the layer using the **Layer Switcher** in the app
   header.
2. Open the layer's **Scheduled tasks** page from the sidebar.
3. Click **Add task**.
4. Fill in:
   - **Name** — human label that shows up in the list.
   - **Slug** — auto-derived from the name; stays stable so URLs
     don't change.
   - **Kind** — pick a registered handler. The dropdown lists
     every `kind` available on this server. If the handler you
     want is not there, the deployment doesn't have it wired up —
     ask a developer to add it (and to add it to the **job
     inventory** doc; the docs check rejects PRs that skip that
     step).
   - **Schedule** — choose **Cron** or **Interval**.
5. Click **Create task**.

The new row appears immediately. **Next run** shows the upcoming
execution time, based on the schedule you picked.

### Cron vs Interval

Both shapes are accepted, but they fit different needs.

- **Cron** — five fields plus a timezone. Pick this when the job
  needs to fire at a specific wall-clock moment, like every Monday
  at 07:00 in Europe/Amsterdam, or every 1st of the month at
  midnight. Example: `0 7 * * MON` with timezone `Europe/Amsterdam`.
- **Interval** — every N minutes from "now". Pick this for ops
  jobs that just want a steady cadence — a healthcheck every 5
  minutes, a digest every 30, a sweep every 24 hours.

A task is one or the other, never both. You can switch between
them later by editing the task.

---

## 3. Pause, resume, and "Run now"

Each row in the scheduled-tasks list carries three actions:

- **Run now** — fires the handler immediately, in addition to the
  normal schedule. The new run shows up in the history with
  `Triggered by: Manual`. The schedule is not disturbed; the
  task's regular cadence continues.
- **Pause** — flips the task to **Paused**. No new runs will
  fire until you resume. The run history is kept.
- **Resume** — re-arms a paused task. The next scheduled slot
  resumes from "now" forward.
- **Delete** — soft-deletes the task. The history stays in the
  database for audit; the task disappears from the layer's view.
  You can ask an admin to restore it if needed.

The **Pause** and **Resume** actions are the right tool when you
want to skip a job for a while without losing its configuration.

---

## 4. Reading the run history

Click the chevron on the right of a row to expand its **Recent
runs** section. Each row shows:

- **Status** — Succeeded, Failed, Skipped, or one of the
  in-progress states (Requested / Started).
- **Started** — when the handler invocation began.
- **Duration** — wall-clock time the handler spent running.
- **Triggered by** — Schedule, Manual, or Retry.
- **Attempt** — `1` on the first attempt, `2` on the first retry,
  and so on.
- **Error** — the short error message when the run failed. Stack
  traces never reach the UI — they land in the server log.

The **Recent runs** widget on the layer dashboard surfaces the
last few runs across every task in the layer, so you can spot a
job that's flapping without opening each task.

### Skipped runs

You may see runs with one of these reasons:

- **Skipped (offline)** — the server was down across one or more
  scheduled slots. bunny2 records a single "we missed N slots"
  marker rather than firing every missed slot, then re-anchors to
  the next slot. No backfill happens automatically.
- **Skipped (no handler)** — the task references a handler `kind`
  the server doesn't know about. Most often this means a
  deployment doesn't have the relevant module wired up. Ask a
  developer.
- **Skipped (crashed)** — the handler was interrupted mid-run
  (server killed, container restart). The next consumer either
  retries (for idempotent handlers) or marks the row for review.

---

## 5. When an error pauses a task

Each task has a **max attempts** budget (default `3`). On a
failed run bunny2 retries with an exponential backoff
(`1m → 2m → 4m`, capped at one hour). Each retry shows up in the
history as a separate row with the **Attempt** counter
incrementing.

If the task exhausts its retry budget, bunny2 **auto-pauses** it
and shows a banner explaining why. The task stays paused — and
its history stays in place for inspection — until someone clicks
**Resume**. We deliberately don't auto-delete the task, because
the history is exactly the diagnostic record you'd want before
deciding what to do next.

Resuming resets the attempt counter and the task picks up at its
next scheduled slot.

---

## 6. Who can edit which?

Scheduled tasks inherit the layer's ownership model from phase 3:

- Tasks in a **project** layer can be edited by the layer's
  owner and by anyone the owner added as an editor.
- Tasks in a **group** layer can be edited by site
  administrators.
- Tasks in your **personal** layer are yours to edit.
- Tasks in the **Everyone** layer (the built-in system tasks) can
  only be edited by administrators.

If a button is greyed out for you, you have read access to the
layer but not edit access. Ask the layer owner (or an admin) to
make the change.

---

## 7. Where to find the admin views

If you are an administrator, two pages give you the full picture:

- **Admin · Scheduled tasks** (`/admin/scheduled-tasks`) — every
  task across every layer in one list, with the same expand-to-see-runs
  affordance. Useful when you want to spot a failing job whose
  layer you don't normally browse.
- **Admin · Dead-letter queue** (`/admin/bus/dlq`) — the durable
  message bus's dead-letter queue. A row here means the bus could
  not deliver an event to a subscriber after the configured
  retries. Each row has a **Replay** button (with a confirmation
  dialog) that re-enqueues the event for the same subscriber. If
  the underlying failure still applies, the row may return to the
  queue.

---

## 8. Related reading

- [`working-with-layers.md`](./working-with-layers.md) — what a
  layer is and how membership / ownership work.
- [`admin-managing-users.md`](./admin-managing-users.md) — admin
  surface for users and groups.
- `docs/dev/architecture/scheduled-tasks.md` — developer-facing
  deep dive (data model, runtime, retry math, role split).
