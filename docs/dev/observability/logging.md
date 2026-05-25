# Logging

> Status: living document.
> Owners: cross-cutting; every domain emits logs.
> Source code: `apps/server/src/` (console + structured tables),
> `apps/web/src/` (browser console).
> Authoritative spec: `AGENTS.md` §Logging.

This file documents how logging works **in this codebase today**.
It is not a re-statement of `AGENTS.md`; it pins the concrete
sinks, prefixes, redaction surface, and durable-table contracts
the code actually uses.

---

## 1. Where logs go

Two sinks today:

| Sink                        | Purpose                                        | Implementation                                                                                                                                                                                                                        |
| --------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Console (stdout/stderr)** | Runtime diagnostics, startup, warnings, errors | `console.log` / `console.warn` / `console.error` directly, or via a structured-logger interface (`{ info, warn, error }`) injected into long-lived components (chat pipeline orchestrator, embedding subscriber, scheduled handlers). |
| **SQLite tables**           | Durable diagnostics — the on-disk audit trail  | `events` (canonical event log), `bus_outbox` / `bus_dlq` (delivery ledger + DLQ), `llm_calls` (100% LLM-call log), `scheduled_task_runs` (every scheduled task invocation).                                                           |

There is **no file-based log writer today**. The console is the
runtime sink; the SQLite tables are the durable sink. Packaged
desktop builds get console output via the Bun sidecar's stdout,
which Electron's main process inherits and surfaces in the OS
console / `~/Library/Logs/...` per platform conventions.

`AGENTS.md` §Logging's "file logging" requirement is satisfied
**via durable SQLite tables** rather than per-line text files —
the trade-off is documented here so future contributors don't
add a parallel text-file sink without weighing this. The tables
give structured query access (`SELECT * FROM events WHERE …`)
without parsing log lines.

---

## 2. Server console conventions

### Prefix format

Every server console line starts with a bracketed module tag,
typically derived from the dotted event name:

```
[bunny2] data-dir:    /Users/.../bunny2
[bunny2] role:        web
[chat.pipeline] pipeline.message.done { conversationId, runId, latencyMs }
[entity.search.vector] fallback to LIKE { reason: 'corpus-empty' }
[layers/subscribers] layer.created subscriber failed: Error: ...
[llm] prune removed 142 row(s) older than 2026-04-01T00:00:00.000Z
```

`appName` for system-level boot lines is the project name from
`config.json` (default `bunny2`); see
`apps/server/src/index.ts` startup block. Module tags are the
dotted prefix of the structured event name and stay stable
across versions.

### Structured-logger interface

Long-lived components accept an injected logger:

```ts
type Logger = {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
};
```

Defaults at call site delegate to `console.log` / `warn` /
`error` with a module-tagged prefix; tests inject a capturing
fake. Producers:

- `apps/server/src/chat/pipeline/orchestrator.ts` —
  `pipeline.message.done`, `pipeline.step.ok`,
  `pipeline.step.failed`, `pipeline.message.failed`.
- `apps/server/src/chat/embeddings/subscriber.ts` —
  embedding subscriber lifecycle and per-event encode results.
- `apps/server/src/chat/embeddings/vector-search.ts` —
  vector search fallback paths.
- `apps/server/src/chat/runs-prune-handler.ts` —
  retention prune outcomes.
- `apps/server/src/chat/review-layer-handler.ts` —
  phase-7 proposal-minting window narratives.
- `apps/server/src/llm/prune.ts` — `llm_calls` retention prune.

Event-name shape for the structured logger: dotted, English,
present or past tense matching the event taxonomy (matches the
bus-event naming convention in
[`event-bus.md`](../architecture/event-bus.md) §6).

### Direct `console.*` is allowed for short-lived sites

Boot lines, one-off operational messages, and per-call
fire-and-forget warnings use `console.*` directly with a
bracketed prefix. Examples:

- `apps/server/src/index.ts` — startup banner
  (`[bunny2] data-dir / role / sqlite / lancedb / bus / llm / scheduler / embeddings`).
- `apps/server/src/layers/subscribers.ts` — `console.error`
  inside a per-subscriber error catch so a bad subscriber
  cannot crash boot.

---

## 3. Web console conventions

Browser logs use `console.log` / `console.warn` / `console.error`
with a bracketed module prefix:

```
[session] /me/layers failed: TypeError: ...
[session] bootstrap failed, falling back to guest: ...
[chat.page] conversations load failed { errorKey: 'load_failed' }
[chat.page] stream failed { errorKey: 'stream_failed' }
[chat.page] feedback failed { errorKey: 'submit_failed' }
[chat.page] bad step frame { data: ... }
[analytics] chat.message.feedback.submitted { layerSlug, value }
```

Producers worth knowing:

- `apps/web/src/lib/session.ts` — session bootstrap +
  refresh failures.
- `apps/web/src/pages/LayerChatPage.tsx` and
  `LayerChatBoardPage.tsx` — chat-flow errors. Note the
  comment in the file header documents the policy: "feedback
  failures `console.error()` with non-sensitive fields."
- `apps/web/src/lib/analytics.ts` — emits a single
  `console.log('[analytics] …')` line **only** when both
  `import.meta.env.DEV` is true **and**
  `localStorage['bunny2.debug.analytics'] === '1'`. The
  production bundle never logs analytics events to the
  console.

### Web-only do/don't

- Do: log `errorKey` (closed enum, also used for the i18n
  user-facing message lookup), `layerSlug`, `activeId` —
  stable, non-sensitive identifiers.
- Don't: log raw user input, the full SSE frame body, the
  conversation transcript, or anything that would land in
  the user's browser history if shared.

---

## 4. Durable diagnostics in SQLite

These tables are the "file log" for the project. Every one of
them is queryable from the admin UI (`/admin/*`) or directly
via `sqlite3 bunny2.sqlite`.

| Table                 | Producer                                                                             | Owner doc                                                         |
| --------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `events`              | Every `bus.publish(...)` — inlined into the durable adapter's transaction            | [`event-bus.md`](../architecture/event-bus.md) §4                 |
| `bus_outbox`          | Durable adapter delivery ledger (pending / in_flight / delivered / dead / abandoned) | [`event-bus.md`](../architecture/event-bus.md) §3.1               |
| `bus_dlq`             | Middleware-chain throws (handler throws are caught earlier)                          | [`event-bus.md`](../architecture/event-bus.md) §3.4               |
| `llm_calls`           | Every LLM call (success or failure) via `withTelemetry(...)`                         | [`llm-and-telemetry.md`](../architecture/llm-and-telemetry.md) §4 |
| `scheduled_task_runs` | Every scheduled-task invocation                                                      | [`scheduled-tasks.md`](../architecture/scheduled-tasks.md)        |
| `chat_pipeline_steps` | Per-step trace of every chat run                                                     | [`chat-pipeline.md`](../architecture/chat-pipeline.md)            |

Retention prune jobs (registered as scheduled tasks):

- `llm.calls.prune` — default 180 days.
- `scheduled.runs.prune` — default 30 days.
- `bus.outbox.prune` — default 7 days on `delivered` rows.
- `chat.runs.prune` — default 60 days.
- `proposals.evidence.prune` — default 90 days.

See [`job-inventory.md`](../architecture/job-inventory.md) for
the registered cadences.

---

## 5. Redaction

The redaction surface that matters today lives in
`apps/server/src/llm/redaction.ts` and applies to every row
written to `llm_calls`:

1. **Key-name match (case-insensitive, exact).** Replaces the
   value with `"[REDACTED]"` when a key in any object inside the
   payload equals one of:
   `apiKey`, `api_key`, `authorization`, `bearer`, `password`,
   `secret`, `token`.
2. **Value-pattern match (anywhere).** Replaces matching string
   values with `"[REDACTED]"`:
   - `sk-[A-Za-z0-9_-]{16,}` (OpenAI-style)
   - `sk-ant-[A-Za-z0-9_-]{16,}` (Anthropic-style)
   - `Bearer\s+[A-Za-z0-9_\-.=]{16,}`
3. **Recursive walk.** Objects and arrays are walked; non-object
   non-array values get the value-pattern check only on strings.

Things deliberately **not** redacted, with reasons:

- Chat-message `content` other than embedded provider-key
  shapes. The conversation itself is the point of the log; a
  user pasting a key in is caught by the value-pattern check.
- The `Authorization: Bearer ${apiKey}` HTTP header — the
  provider never echoes it back into the `ChatRequest`, so it
  stays out of the log by construction.

### Other surfaces

- **`bus_dlq`** carries `error` strings (clipped) plus the
  outbox row's payload via `bus_outbox.payload_json`. Payloads
  are NOT echoed in `bus.dlq.added` bus events
  (see [`event-bus.md`](../architecture/event-bus.md) §5).
  Admin DLQ inspection sees the payload; subscribers see only
  metadata.
- **Console output** has no central redactor. Producers must
  follow `AGENTS.md` §Logging "Do not log" list directly. The
  prefix-tag conventions (§2, §3) keep call sites grep-able so
  audit catches new leak shapes during review.

### Audit-flavoured log: chat-runs raw-content gate

The admin chat-pipeline runs viewer (Phase 4 of
`docs/dev/plans/admin-observability-viewer.md`) gates the raw
`input_json` for the `intent` and `entities` steps behind an
explicit "Show raw chat content" expander. The viewer fetches
that gated payload via
`GET /admin/observability/chat-runs/:id?raw=true`; the same
request emits an audit log line plus a paired telemetry event
on the bus so the action is observable from either side:

```
[admin.observability.chat-runs.raw-content.viewed] {
  event: 'admin.observability.chat-runs.raw-content.viewed',
  runId: <chat_pipeline_runs.id>,
  revealedKinds: ['intent' | 'entities'],
}
```

Field set is closed by design: no payload content, no request
metadata, only the row id and which gated step kinds were
revealed. Producers must never widen this shape to include the
raw text — that would defeat the purpose of the gate.

### Analytics ingest + retention log shapes

Phase 6 of
[`docs/dev/plans/admin-observability-viewer.md`](../plans/admin-observability-viewer.md)
adds two stable console-log shapes on the analytics write path.
Both are paired with the bus-event telemetry of the same name
(see [`telemetry.md`](./telemetry.md) §4).

`analytics.events.rejected` — every rejection on
`POST /analytics/events`. The endpoint validates against the
catalogue at
[`apps/server/src/analytics/catalogue.ts`](../../../apps/server/src/analytics/catalogue.ts);
unknown event names, unknown properties, malformed envelopes, and
oversize bodies all land here:

```
[analytics.events.rejected] {
  event: 'analytics.events.rejected',
  eventName: <string | null>,
  reason:    'unknown_name' | 'unknown_property'
            | 'invalid_envelope' | 'payload_too_large'
            | 'invalid_property_value',
}
```

`analytics.events.pruned` — the retention sweep
(`analytics.events.prune`) emits one line per run with the
deleted-row count and the active retention window. No per-row
identifiers leave the handler:

```
[analytics.events.pruned] {
  event: 'analytics.events.pruned',
  deletedCount: <number>,
  retentionDays: <number>,
}
```

Producers must never widen these shapes to include the rejected
payload bytes — privacy contract per
[`analytics.md §Privacy`](./analytics.md#privacy).

---

## 6. Adding a new log call site

1. Pick the right channel:
   - **Console only** for runtime-visible state (start, stop,
     warnings, errors that the durable tables already cover).
   - **A new SQLite table** if you need durable structured
     records that the existing tables don't carry. Discuss in
     an ADR — this is a real schema change.
2. Use the structured-logger interface where one is already
   injected; otherwise `console.*` with a bracketed module
   prefix in the format `[module.subname] <message> { fields }`.
3. Field shape: prefer `event`, `level`, `requestId`,
   `jobId`, `userIdHash`, `durationMs`, `errorCode` from
   `AGENTS.md` §Logging.
4. **Do not** log raw user input, full payloads, secrets, or
   stack traces shown to end users. Server-side internal
   stack traces are fine for the `error` channel.
5. Add a test if the line is operationally load-bearing — the
   structured-logger interface makes capture trivial; see
   `apps/server/src/chat/pipeline/orchestrator.ts` tests for
   the pattern.

---

## 7. What's intentionally missing

- **A file-based log writer.** Durable diagnostics live in
  SQLite tables (§1, §4); a parallel text-file sink would
  duplicate the data without adding query power. Revisit if
  external log shippers (Loki, Datadog) are required.
- **A central log-level switch.** Components log what they log;
  no `LOG_LEVEL=debug` env var. The bracketed prefixes make
  per-module grepping practical at the operator level.
- **A central console redactor.** The risk surface is the LLM
  payload (where 100% logging meets free-form user content);
  that's redacted at the call log writer. Other producers are
  expected to follow `AGENTS.md` §Logging by hand.
- **A web → server log shipper.** Browser errors stay in the
  user's devtools today; user-side error reporting is a
  product decision (see `analytics.md` for the equivalent
  question on the analytics side).
