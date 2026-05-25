# Admin observability redaction audit — 2026-05-25

Question: for each table the admin observability viewer will expose,
what is the redaction story today, what columns can carry raw user
content, and what column-level rules does the admin viewer need to
enforce on top?

Scope: the source tables named in
`docs/dev/plans/admin-observability-viewer.md` —
`events`, `llm_calls`, `chat_pipeline_steps`, `scheduled_task_runs`,
`bus_outbox`, `bus_dlq`, plus the new `analytics_events` shipped in
phase 6 of the same plan.

Cross-references:

- `docs/dev/observability/logging.md` §5 (redaction surface today)
- `docs/dev/observability/telemetry.md` §1 + §2
- `apps/server/src/llm/redaction.ts` (the only active redactor)
- `apps/server/src/chat/pipeline/orchestrator.ts` + step files
  (`chat_pipeline_steps` writers)

---

## Summary

| Table                        | Has raw user content?  | Redactor                                    | Viewer rule                                                                                          |
| ---------------------------- | ---------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `events`                     | Possible (payload)     | None central                                | Detail drawer only, collapsed JSON                                                                   |
| `llm_calls`                  | Yes (chat content)     | `apps/server/src/llm/redaction.ts`          | Detail drawer; > 200 KB server-side truncated; "show raw" expander                                   |
| `chat_pipeline_steps`        | **Yes, by design**     | None — durability is the feature            | Detail drawer; `input_json` for `intent` step gated behind explicit "show raw chat content" expander |
| `scheduled_task_runs`        | No (error text only)   | Producer-side clip on `error`               | Inline `error` ok; full row in drawer                                                                |
| `bus_outbox` / `bus_dlq`     | Possible (payload)     | None central; bus contract avoids broadcast | Detail drawer only; reuse existing DLQ-page treatment                                                |
| `analytics_events` (phase 6) | No (catalogue-bounded) | Catalogue validation at ingest              | Inline rendering ok; properties table shown alongside documented schema                              |

The two rows in **bold** below are the load-bearing findings;
everything else is "the existing redaction story already covers it"
or "the column does not carry raw content".

### Finding 1 — `chat_pipeline_steps.input_json` for `intent` step contains raw chat text

`apps/server/src/chat/pipeline/orchestrator.ts:489` writes
`inputJson: safeStringify(input)`. For the `intent` step, `input` is
`{ userContent: <raw user message> }`
(`apps/server/src/chat/pipeline/intent-step.ts` — `IntentStepInput`).

This is **intentional**: the chat-pipeline replay path, the Kanban
view (phase 6.6), and the `chat.runs.prune` 60-day retention all
treat the step row as the canonical pipeline trace. Removing the raw
content would break replay. The audit calls it out so the admin
viewer treats it like `llm_calls.request` — collapsed by default,
behind an explicit "show raw chat content" expander, with a
tooltip naming what the user is about to see.

### Finding 2 — `analytics_events.properties_json` must be catalogue-bounded

The new table (ADR 0031) MUST validate every event's property keys
against the catalogue in `docs/dev/observability/analytics.md`.
Without that, the table joins the others in the "possible raw
content" column above, defeating the whole privacy stance documented
at `analytics.md §Privacy`. The ingest endpoint does the validation
(ADR 0031 D2); the viewer relies on it.

---

## Per-table breakdown

### 1. `events` (migration 0001)

Columns:

```
id, type, occurred_at, correlation_id, flow_id, payload, metadata
```

Source: `apps/server/src/bus/durable-sqlite.ts` writes one row per
`bus.publish(...)` inside the publish transaction.

What lands here:

- `payload`: the event-specific JSON payload. Subscribers respect the
  per-event-type contract documented in
  `docs/dev/architecture/event-bus.md` §5 ("payload-free" DLQ events,
  catalogue of payload shapes per event type). Producers must not
  attach raw user content; nothing redacts after the fact.
- `metadata`: correlation/flow ids plus optional small metadata.

Risk: a future event type starts shipping raw user content (e.g. a
hypothetical `chat.message.draft_saved` with `{ text }`) and lands it
in `payload`. The viewer cannot detect this; it is a write-side
discipline issue caught at code review.

Viewer rule:

- Inline columns: `id`, `type`, `occurred_at`, `correlation_id`,
  `flow_id`. No `payload` / `metadata` body inline.
- Detail drawer: full `payload` + `metadata` JSON in a collapsed
  `<pre>` (R3 mitigation — server truncates > 200 KB, viewer
  collapses by default).

### 2. `llm_calls` (migration 0001 + 0016 model_source)

Columns:

```
id, started_at, ended_at, model, endpoint, request, response,
tokens_in, tokens_out, cost_usd, latency_ms, correlation_id,
flow_id, layer_id, user_id, error, model_source
```

Source: `apps/server/src/llm/telemetry.ts::withTelemetry`. Every
`chat()` / `chatStream()` call writes exactly one row.

Redactor: `apps/server/src/llm/redaction.ts` runs on `request` and
`response` before the INSERT. Per `logging.md §5`:

- Key-name match (case-insensitive exact): `apiKey`, `api_key`,
  `authorization`, `bearer`, `password`, `secret`, `token`.
- Value-pattern match: `sk-...`, `sk-ant-...`,
  `Bearer\s+[A-Za-z0-9_\-.=]{16,}`.
- Recursive walk.

Deliberately **not** redacted (per `logging.md §5`):

- Chat message `content` (the conversation itself is the point of
  the log).
- The `Authorization: Bearer …` header is never echoed by providers
  into the request shape, so it stays out by construction.

`user_id` is the **raw UUID**. This is the deliberate asymmetry with
`analytics_events.user_id_hash` (see §7 below + ADR 0031 D3): the
LLM log is the admin audit surface; analytics is the product-flow
surface. Different privacy contracts.

Viewer rules:

- Inline columns: `id`, `started_at`, `model`, `endpoint`,
  `tokens_in`, `tokens_out`, `cost_usd`, `latency_ms`, `layer_id`
  (resolve to slug), `user_id` (resolve to email/handle),
  `model_source`, `error` (truncated).
- Detail drawer: `request` + `response` JSON collapsed by default;
  server truncates payloads > 200 KB with an explicit
  `"... truncated; full payload available via API"` marker (R3).
  Per `AGENTS.md §UI Planning`, the `<pre>` block is `tabindex="0"`
  so screen-reader users can navigate it.

### 3. `chat_pipeline_steps` (migration 0014 + 0016 attribution)

Columns:

```
id, run_id, kind, status, attempt, started_at, ended_at,
input_json, output_json, llm_call_id, error_code, attribution_json
```

Source: `apps/server/src/chat/pipeline/orchestrator.ts` +
`{intent,entities,retrieval,answer}-step.ts`.

Redactor: **none**. The step row is the canonical pipeline trace and
is durable by design (60-day retention via `chat.runs.prune`).

Per-step content breakdown:

| Step      | `input_json` payload                       | `output_json` payload                                                                                                                 | Raw content risk                                                |
| --------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| intent    | `{ userContent: <raw user message> }`      | `{ intent, confidence, reason }` (closed enum + short string)                                                                         | **HIGH — raw chat text is the input**                           |
| entities  | `{ intent, userContent }`                  | `{ entities: [...], kinds: [...], queryHints: [...] }`                                                                                | Same raw text as intent input; query hints can echo user terms  |
| retrieval | `{ intent, entities }`                     | `{ hits: [{ id, kind, layerId, slug, title, text }], skipped }`                                                                       | `text` snippet capped at `SNIPPET_MAX` — entity content excerpt |
| answer    | `{ intent, entities, retrieval, history }` | `{ model, tokensIn, tokensOut, contentBytes, skipped, streamed }` — assistant text deliberately replaced by `contentBytes` byte count | Input includes prior assistant turn history                     |

`answer-step.ts:258` is worth highlighting: the answer step
deliberately stores **only metadata** in `output_json` (`model`,
`tokensIn`, `tokensOut`, `contentBytes`), never the assistant
content. The conversation text lives on `chat_messages.content`
(out of scope for the admin viewer per the plan §2).

Viewer rules:

- Inline columns: `id`, `run_id`, `kind`, `status`, `attempt`,
  `started_at`, duration (computed from `started_at` / `ended_at`),
  `llm_call_id`, `error_code`.
- Detail drawer: `input_json` + `output_json` collapsed by default.
- **Extra gate for the `intent` row's `input_json`**: the drawer
  shows a labelled "show raw chat content" toggle before
  rendering the JSON. The toggle copy makes it explicit that the
  user's typed message is about to appear, so an admin scrolling
  through the viewer does not accidentally read PII.
- Same toggle applies to `entities` step `input_json` (carries the
  same `userContent`).
- `attribution_json` (phase 7.6) is metadata only, safe inline.

### 4. `scheduled_task_runs` (migration 0012)

Columns:

```
id, task_id, status, attempt, triggered_by, requested_at,
started_at, finished_at, duration_ms, error, correlation_id
```

Source: `apps/server/src/scheduled/runner.ts` writes one row per
invocation.

Redactor: none, but `error` is clipped at the producer (handler
errors stringified, no payload bodies).

Risk: a future scheduled-task handler stringifies a payload into its
thrown error. Producer-side discipline. Viewer cannot help.

Viewer rules:

- Inline columns: `id`, `task_id` (resolve to slug), `status`,
  `attempt`, `triggered_by`, `requested_at`, `duration_ms`,
  `error` (truncated to ~200 chars).
- Detail drawer: full `error` text + correlation_id link to events.
- This already matches the existing
  `AdminScheduledTasksPage` per-task runs drilldown (extended in
  phase 5).

### 5. `bus_outbox` + `bus_dlq` (migration 0013)

Columns (`bus_outbox`):

```
id, type, payload_json, metadata_json, correlation_id, flow_id,
occurred_at, status, attempt, claimed_at, claimed_by_pid,
delivered_at, error
```

Columns (`bus_dlq`):

```
id, outbox_id, subscriber_key, error, attempts, failed_at
```

Source: `packages/bus/src/adapters/durable-sqlite.ts`.

Redactor: none, but the bus contract
(`docs/dev/architecture/event-bus.md` §5) keeps payload bodies out of
broadcast `bus.dlq.added` events. Admin viewers reading the row
directly see the payload; subscribers do not.

Risk: same as `events.payload` — a producer that puts raw user
content in a payload lands it on disk. Discipline issue.

Viewer rules:

- Inline columns: `id`, `type`, `status`, `attempt`, `occurred_at`,
  `delivered_at`, `error` (truncated for DLQ rows).
- Detail drawer: `payload_json` + `metadata_json` collapsed.
- The existing `AdminBusDlqPage` already follows this shape; the
  plan's phase 5 extension to non-DLQ outbox rows inherits it.

### 6. `chat_messages` (out of scope)

Listed for completeness — the plan §2 explicitly excludes editing or
exposing `chat_messages.content` from the admin viewer. The chat
content lives on the per-layer conversation page; admin observability
sees it only through the `llm_calls.request` lens (already redacted)
or through the `chat_pipeline_steps.input_json` gate above (raw, but
behind an explicit expander).

### 7. `analytics_events` (new — phase 6)

Columns (per ADR 0031):

```
id, occurred_at, event_name, layer_slug, user_id_hash,
properties_json, ingested_at
```

Source: `POST /analytics/events` from the web sink. Server-side hash
of `user_id` happens before insert (ADR 0031 D3).

Redactor: catalogue validation at ingest (ADR 0031 D2). Unknown
event names rejected with `400`; unknown properties for a known
event also rejected (the property catalogue per event row in
`analytics.md` is closed).

Risk: catalogue drift — a code change adds a new property to an
existing event, server rejects, browser swallows. Mitigation:
`analytics.events.rejected` log line with `eventName`; CI
grep keeps catalogue + call sites in sync.

Viewer rules:

- Inline columns: `id`, `occurred_at`, `event_name`, `layer_slug`,
  `user_id_hash` (short hash render), `ingested_at`.
- Detail drawer: `properties_json` rendered alongside the
  documented schema for the event (so drift is visible at a glance).

---

## What this audit does NOT cover

- **Console output.** `logging.md §5` calls this out: no central
  console redactor; producers follow the rules in `AGENTS.md
§Logging` by hand. Out of scope for the admin viewer (the viewer
  reads SQLite tables, not stdout).
- **`chat_messages.content`** — the chat-transcript table itself.
  Not exposed by this plan (plan §2 non-goal).
- **Future write paths** for any of the tables above. New
  producers must follow the per-table rules above; this audit
  documents the state as of today.

---

## Action items for downstream phases

- **Phase 2 (events viewer):** detail drawer renders `payload` /
  `metadata` collapsed; column list excludes both for inline rows.
- **Phase 3 (llm_calls viewer):** server truncates `request` /
  `response` > 200 KB; drawer expander labelled with a privacy
  note ("contains the redacted chat content").
- **Phase 4 (chat-pipeline runs viewer):** the `intent` /
  `entities` step `input_json` gates behind a "show raw chat
  content" toggle; the toggle is the only path that surfaces the
  raw user message in the admin UI. The toggle action is logged
  as `admin.observability.chat-runs.raw-content.viewed` (no
  content in the log, only the row id) for audit.
- **Phase 6 (analytics viewer + sink):** ingest validates against
  the catalogue per ADR 0031 D2; viewer renders the documented
  schema next to the row's values.
- **Tests** (per plan §6) assert (a) admin viewers reject
  non-admin sessions, (b) `llm_calls` rows in test fixtures
  contain no unredacted sentinel strings, (c) the analytics
  endpoint rejects unknown event names, (d) the analytics
  endpoint stores `user_id_hash`, never the raw id.
