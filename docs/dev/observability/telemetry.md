# Telemetry

> Status: living document.
> Owners: cross-cutting; LLM telemetry is the only first-class
> metric pipeline today.
> Source code: `apps/server/src/llm/`,
> `apps/server/src/chat/pipeline/`,
> `apps/server/src/bus/`,
> `apps/server/src/scheduled/`.
> Authoritative deep dive on the LLM half:
> [`architecture/llm-and-telemetry.md`](../architecture/llm-and-telemetry.md).
> Authoritative spec for naming + privacy:
> `AGENTS.md` §Telemetry + §Privacy and Data Protection.

This file is the **cross-cutting** telemetry overview: what gets
measured, where the rows land, how to query them, and what is
deliberately not measured yet. It is not a re-statement of
`AGENTS.md`; it pins the concrete tables, dimensions, and
retention windows the code uses today.

---

## 1. What "telemetry" means here

Telemetry in bunny2 is **persisted, queryable, structured rows**
in SQLite — not metrics scraped by a remote collector.
Every signal is a SELECT away. The trade-off is intentional:
local-first deployment, no external dependencies, single source
of truth that the admin UI and the chat pipeline both read from.

Four primary telemetry surfaces:

| Surface             | Sink                    | Cardinality     | Retention default                                                                  |
| ------------------- | ----------------------- | --------------- | ---------------------------------------------------------------------------------- |
| LLM calls           | `llm_calls`             | one row / call  | 180 days (`llm.calls.prune`)                                                       |
| Chat-pipeline steps | `chat_pipeline_steps`   | one row / step  | 60 days (`chat.runs.prune` cascades)                                               |
| Scheduled-task runs | `scheduled_task_runs`   | one row / run   | 30 days (`scheduled.runs.prune`)                                                   |
| Bus outbox + DLQ    | `bus_outbox`, `bus_dlq` | one row / event | 7 days on `delivered` (`bus.outbox.prune`); DLQ is permanent until manually pruned |

The canonical `events` table is the event log, not telemetry —
it is the source-of-truth from which read models can be rebuilt.
Telemetry tables derive their cadence from it but live on their
own retention schedule.

---

## 2. LLM telemetry pipeline (primary)

The fullest pipeline in the project. Detailed in
[`llm-and-telemetry.md`](../architecture/llm-and-telemetry.md);
the essentials for this doc:

### Wrapper

`apps/server/src/llm/telemetry.ts::withTelemetry(client, opts)`
wraps every `LlmClient` returned from `createLlmClient(...)`.
Every `chat()` and `chatStream()` call writes **exactly one**
row to `llm_calls`, success or failure, including aborted
streams.

### Row shape (`llm_calls` table)

| Column                     | Source                                          | Notes                                                                                                                                                                                                                              |
| -------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | `crypto.randomUUID()` per call                  | Independent of the provider's id.                                                                                                                                                                                                  |
| `started_at` / `ended_at`  | wrap-time `clock()`                             | ISO-8601 strings.                                                                                                                                                                                                                  |
| `model`                    | provider response `model`, else pre-call        | Real-call model preferred for accuracy.                                                                                                                                                                                            |
| `endpoint`                 | `client.endpoint`                               | Stable across calls.                                                                                                                                                                                                               |
| `request` / `response`     | redacted, stringified JSON                      | See §5 redaction.                                                                                                                                                                                                                  |
| `tokens_in` / `tokens_out` | provider response                               | `NULL` on error.                                                                                                                                                                                                                   |
| `cost_usd`                 | `estimateCostUsd(...)`                          | `NULL` when pricing unknown — honest gap.                                                                                                                                                                                          |
| `latency_ms`               | `ended_at - started_at`                         | Around the provider call only.                                                                                                                                                                                                     |
| `correlation_id`           | `metadata.correlationId`                        | Joins to `events.correlation_id`.                                                                                                                                                                                                  |
| `flow_id`                  | `metadata.flowId`                               | Joins to `events.flow_id`.                                                                                                                                                                                                         |
| `layer_id`                 | `metadata.layerId`                              | Stable layer UUID; never a slug.                                                                                                                                                                                                   |
| `user_id`                  | `metadata.userId`                               | Stable user UUID.                                                                                                                                                                                                                  |
| `error`                    | `String(err)` on failure                        | `NULL` on success.                                                                                                                                                                                                                 |
| `model_source`             | `metadata.modelSource` (`'system'` / `'layer'`) | Records whether the model came from the system default or a per-layer `layer_chat_settings.model` override (per-layer chat settings follow-up). `NULL` for callers that do not stamp it; historical rows backfilled to `'system'`. |

### Stable dimensions

The metadata-promoted columns are the **only** stable
dimensions for grouping LLM calls:
`model`, `endpoint`, `layer_id`, `user_id`, `flow_id`,
`correlation_id`, `model_source`. Avoid grouping by anything
inside the `request` / `response` JSON — that's debug data, not a
metric dimension.

### Cost

`estimateCostUsd(model, tokensIn, tokensOut, pricing)` returns
`null` when `model` is not in the user-configured pricing map.
Stored as SQL `NULL` (not `0`). This is the project's
"honest about gaps" policy — fake zeros would silently
under-report.

---

## 3. Other telemetry surfaces

### Chat-pipeline steps (`chat_pipeline_steps`)

Every chat-pipeline step (router → resolver → retrieval →
answerer; plus phase-7 additions) writes one row. Joins to
`llm_calls` via `llm_call_id` so per-step cost / latency /
token use is a SQL JOIN, not a separate metric.

Producer: `apps/server/src/chat/pipeline/orchestrator.ts`
through the `recordStepOk` / `recordStepFailed` paths; the
on-call hook in `withTelemetry(...)` hands the freshly-minted
`llm_calls.id` back to the orchestrator before the LLM call
returns so the step row never has to query the table back.

Doc: [`chat-pipeline.md`](../architecture/chat-pipeline.md).

### Scheduled-task runs (`scheduled_task_runs`)

Every scheduled-task invocation writes one row keyed by
`(task_id, attempt)` with `started_at` / `ended_at` /
`status` / `error`. The closed enum of `kind` values is
catalogued in
[`job-inventory.md`](../architecture/job-inventory.md) and
enforced by `tests/docs/job-inventory.test.ts`.

Bus events emitted alongside the table (see
[`event-bus.md`](../architecture/event-bus.md) §5):

- `scheduledtask.run.requested` / `started` / `succeeded` /
  `failed` / `skipped`. Closed enum on `reason` for `skipped`.
- `error` strings are clipped; no stack traces in payloads.

### Bus delivery (`bus_outbox`, `bus_dlq`)

The durable adapter's claim/lease ledger doubles as telemetry
on bus health. Useful queries:

- `SELECT status, COUNT(*) FROM bus_outbox GROUP BY status;`
  — quick view of pending / in_flight / delivered / dead /
  abandoned rows.
- `SELECT subscriber_key, COUNT(*) FROM bus_dlq GROUP BY 1;`
  — per-subscriber DLQ size; growing rows are the operator's
  cue to look.

Bus events emitted on DLQ transitions:

- `bus.dlq.added` — carries `outboxId`, `subscriberKey`,
  event `type`, `attempts`, clipped `error`. Does **not**
  carry the payload (event-bus.md §5).
- `bus.dlq.replayed` — carries `outboxId`, `subscriberKey`,
  `replayedBy`.

`/status.bus` surface shows `{ adapter, events: <N> }`.

---

## 4. Naming conventions

Per `AGENTS.md` §Telemetry: stable names, consistent
dimensions, avoid high-cardinality labels, avoid sensitive
values.

In this codebase telemetry "names" appear in two places:

1. **Bus event `type`** — dotted, English, past tense:
   `scheduledtask.run.succeeded`, `chat.message.failed`,
   `entity.calendar.created`, `bus.dlq.added`. The closed
   sets are exported as constants (e.g.
   `SCHEDULED_TASK_EVENT_TYPES`) for machine-checking.
2. **Structured-logger `event` field** — same shape, used by
   `logger.info(msg, fields)` so log lines and bus events
   stay grep-able by the same dotted name. Example
   producers: `pipeline.message.done`, `pipeline.step.ok`,
   `pipeline.step.failed`, `pipeline.message.failed`,
   `proposal.mint.window-start`.

There are no Prometheus-style `_count` / `_duration_ms`
suffixed metric names today — the SQL tables play that role
(`COUNT(*)`, `AVG(latency_ms)`, `SUM(cost_usd)` against the
table directly).

### Forbidden in dimensions / payloads

- Raw user input (prompt text outside the redacted
  `llm_calls.request` body).
- Proposal id / layer id as a **label dimension** in any
  count metric whose cardinality would grow without bound.
  Layer id is fine as a JOIN key on `llm_calls.layer_id`
  because the table is queried, not aggregated into a
  per-label series.
- Full payloads inside DLQ bus events.
- Stack traces in event payloads (clipped `error` strings only).

---

## 5. Redaction (cross-reference)

The redactor at `apps/server/src/llm/redaction.ts` is the only
content-aware redaction surface today and runs on every
`llm_calls.request` / `response` write. Full rules in
[`logging.md`](./logging.md) §5; recap:

1. Key-name match (case-insensitive, exact) on `apiKey`,
   `api_key`, `authorization`, `bearer`, `password`,
   `secret`, `token`.
2. Value-pattern match on `sk-…`, `sk-ant-…`, `Bearer …`.
3. Recursive walk; non-strings pass through.

Other telemetry surfaces rely on producer discipline +
clipped string fields (DLQ `error`, scheduled-task `error`).

---

## 6. How to add new telemetry

1. **First ask: is a new SQLite column or table the right
   thing?** Yes when you have a derivable signal that other
   parts of the system will query (cost, latency, throughput
   keyed by stable dimensions). No when it's a one-off log
   line — use the structured logger in
   [`logging.md`](./logging.md) §2.
2. **Use existing tables when possible.** A new chat-pipeline
   step type? Add a `kind` value in `chat_pipeline_steps`,
   no new table. A new scheduled-task kind? Register through
   the existing handler registry — `scheduled_task_runs`
   covers it for free.
3. **New table?** ADR-worthy. Discuss naming, retention prune
   job, and dimensions before writing the migration.
4. **Dimensions:** prefer stable UUIDs over slugs (a layer
   slug can be renamed; the id cannot), closed enums over
   free-form strings, bucketed numerics over raw counts in
   labels.
5. **Retention:** every new telemetry table needs a prune job
   registered through `apps/server/src/scheduled/` and listed
   in [`job-inventory.md`](../architecture/job-inventory.md).
6. **Test the producer:** capture the row through the same
   interface the runtime uses (the `LlmCallLog` shape, the
   structured logger, the bus's contract suite). Tests for
   "this dimension is never set to user input" are
   especially worth writing.

---

## 7. What's intentionally missing

- **External metrics collector (Prometheus, OTel exporter).**
  The local-first deployment story doesn't yet need one;
  every signal is in SQLite. Revisit when (a) federation
  lands (overall §"Later"), or (b) an operator needs
  cross-instance dashboards.
- **Per-call cost ceilings.** Sketched in
  [`llm-and-telemetry.md`](../architecture/llm-and-telemetry.md)
  §10 as a future middleware between the client and the
  telemetry wrapper — would reject calls whose estimated
  cost exceeds a per-flow budget without bypassing the
  telemetry row.
- **Per-layer embedding budget telemetry.** Implemented by the
  per-layer chat settings follow-up (plan
  [`chat-per-layer-settings.md`](../plans/done/chat-per-layer-settings.md)):
  `embedding.tokens.spent` counter + structured log per successful
  encode (`{ layerId, day, tokensSpent }`); `chat.embeddings.deferred`
  counter when a cap is hit. The persistent counters live in
  `layer_embedding_spend`.
- **Conversation auto-summary telemetry.** Implemented by the
  conversation auto-summary follow-up (plan
  [`chat-conversation-auto-summary.md`](../plans/done/chat-conversation-auto-summary.md)):
  - `chat.summarize.completed` counter on every successful title
    rewrite, plus `chat.summarize.duration_ms` observation.
  - `chat.summarize.failed` counter with a closed-enum `reason`
    dimension (`empty-title` / `llm-error`).
  - Analytics event `chat_conversation_title_regenerated` (web,
    manual path only) — no message content; layer slug only.
- **A `LOG_LEVEL`-equivalent telemetry-level switch.** Every
  call is logged at 100%; sampling is not configurable.
  Retention prune is the only "fewer rows" lever.
- **A web-side telemetry pipeline.** Browser-side events
  flow through `trackEvent` in
  `apps/web/src/lib/analytics.ts` (analytics, not telemetry).
  Browser-side errors stay in the user's devtools today —
  see [`logging.md`](./logging.md) §3.
