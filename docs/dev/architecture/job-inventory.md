# Job inventory

> Status: living document.
> Owners: phase 5 introduced this; every domain that registers a
> scheduled-task handler maintains its own row(s).
> Source code: handlers in `apps/server/src/scheduled/built-in/` +
> per-domain `register…Handler` helpers wired in
> `apps/server/src/index.ts`.

Single canonical catalogue of every `kind` registered via
`registerScheduledTaskHandler(...)`. Two checks enforce that this
file stays accurate:

- `bun run docs:check` (extended in phase 5.7) — fails when a
  handler is registered but not listed, or a row references a
  `kind` no handler claims.
- `tests/docs/job-inventory.test.ts` — same diff, runs in `bun
test`.

The columns are the minimum a reviewer needs to evaluate
"should this job exist? in which layer? how often? what does it
touch?". For deeper detail follow the **owner module** link to the
source.

Reference: [`scheduled-tasks.md`](./scheduled-tasks.md),
[`event-bus.md`](./event-bus.md), ADRs
[`0018`](../decisions/0018-generic-scheduled-tasks.md) /
[`0019`](../decisions/0019-durable-sqlite-message-bus.md).

---

## Inventory

<!-- job-inventory:start -->

| kind                   | layer scope | default cadence | owner module                                             | touches LLM? |
| ---------------------- | ----------- | --------------- | -------------------------------------------------------- | ------------ |
| `llm.calls.prune`      | `everyone`  | every 24 h      | `apps/server/src/scheduled/built-in/llm-prune.ts`        | no           |
| `system.healthcheck`   | `everyone`  | every 5 min     | `apps/server/src/scheduled/built-in/healthcheck.ts`      | no           |
| `scheduled.runs.prune` | `everyone`  | every 24 h      | `apps/server/src/scheduled/built-in/runs-prune.ts`       | no           |
| `bus.outbox.prune`     | `everyone`  | every 24 h      | `apps/server/src/scheduled/built-in/bus-outbox-prune.ts` | no           |
| `chat.embeddings.backfill` | `everyone` | every 24 h  | `apps/server/src/chat/embeddings/backfill-handler.ts` | no           |

<!-- job-inventory:end -->

---

## Column reference

- **kind** — the unique handler key passed to
  `registerScheduledTaskHandler({ kind, ... })`. Must match exactly
  (the docs-check and the test parse this column verbatim).
- **layer scope** — which layer the seeded `scheduled_tasks` row
  lives in. `everyone` for built-in system jobs (admin-only edit
  via `canEditLayer`); per-layer for domain jobs whose cadence is
  layer-specific.
- **default cadence** — the `defaultSchedule` the handler advertises
  to the create dialog and the seed module. A layer owner can
  override per-task.
- **owner module** — file path of the handler implementation.
- **touches LLM?** — yes if the handler invokes
  `ctx.llm.chat(...)` on a non-mock endpoint. Helps reviewers spot
  jobs whose pause/resume affects retention of LLM-call data.

---

## How to add a row

1. Implement and register the handler from your domain module.
2. Add a row above between the `<!-- job-inventory:start -->` and
   `<!-- job-inventory:end -->` markers. Preserve the column order
   and the leading/trailing pipes; the parser is intentionally
   strict.
3. If your handler needs a default task row on first boot, add it
   to your domain's seed (mirror
   `apps/server/src/scheduled/seed.ts`).
4. Run `bun run docs:check` and `bun test
tests/docs/job-inventory.test.ts` locally to confirm.
