# Admin observability

This guide is for the bunny2 **administrator**. End users do not see
any of these screens — they live under the **Admin · Observability**
section of the top navigation and the server returns `403` if a
non-admin session reaches the underlying endpoints.

If you administer the server but have never opened these pages
before, this guide walks the surface end to end. If you are an end
user, see [`getting-started.md`](./getting-started.md).

---

## 1. Why this surface exists

bunny2 records four kinds of runtime signal in its own database:

- **Logs** — structured `events` rows (one row per "something
  happened", including telemetry events).
- **LLM call history** — every Claude / GPT / etc. request made
  through the central LLM client, with redacted request + response,
  tokens, cost, latency, and the linking `correlation_id`.
- **Chat-pipeline runs** — the per-message step trace
  (`intent → entities → retrieval → answer`) for every assistant
  reply.
- **Analytics events** — product-flow events (`chat_message_sent`,
  `proposal_approved`, …) emitted from the web client into the
  server-side `analytics_events` table.

Before this admin surface existed, the only way to inspect any of
those tables was to open the SQLite file with `sqlite3` or tail the
container stdout. That worked for one developer on a laptop and
nothing else. The viewers exist so an administrator running the
portable build can answer questions like "did the assistant fail
on Anne's last message?" or "what's our weekly LLM bill?" without
touching the database directly.

Each viewer is **read-only** and renders rows that were redacted at
write time. There is no "show me the unredacted version" path on the
server.

---

## 2. How to reach it

In the top header, open the **Admin** dropdown. You will see three
sections:

- **Users & Groups** — Users, Groups.
- **Operations** — Scheduled tasks, Bus ledger.
- **Observability** — Events, LLM calls, Chat pipeline runs,
  Analytics.

The Observability section contains the four new pages this guide
covers. Scheduled tasks (under Operations) carries a per-task
**Runs** drilldown that is also part of the observability story and
is covered below. Bus ledger (also under Operations) now has both a
DLQ tab and an Outbox tab; the Outbox tab is the new one.

Every page in this guide:

- Has a **Refresh** button in the header.
- Has a **filter form** at the top with an Apply / Reset pair.
- Lists rows newest-first.
- Pages forward only — click **Load more** to fetch the next page;
  scrolling does not auto-paginate.
- Opens a **detail drawer** when you click a row.
- Closes the drawer on `Esc`, on the close button, or on clicking
  the backdrop.

---

## 3. Events log

**Admin · Observability · Events**

The canonical log of "something happened". Every domain event,
every telemetry event, every audit-relevant write. If a feature
emits a structured signal, it lands here.

### Filters

- **Kind prefix** — matches `event_type` with a `LIKE` prefix
  (e.g. `chat.` returns every `chat.*` event). Wildcards in your
  input are escaped, so a literal `%` matches the character.
- **From / To** — ISO timestamps. Inclusive of `from`, exclusive of
  `to`.
- **Layer** — filters by layer UUID. Currently shown as a raw id
  (see "What's not here" below).
- **Flow id / Correlation id** — paste the value from another
  viewer's detail drawer to pivot.

### Columns

| Column      | Meaning                                             |
| ----------- | --------------------------------------------------- |
| Occurred at | When the event was emitted (ISO TEXT, sorted DESC). |
| Type        | Stable event name, e.g. `chat.message.done`.        |
| Layer       | Layer the event was scoped to, or `—` if global.    |
| Flow        | `flow_id` if the event was part of a chat pipeline. |
| Correlation | `correlation_id` for cross-viewer joins.            |

### Detail drawer

Shows the row's `payload` and `metadata` JSON. Both are collapsed
behind a `<details>` expander to keep the drawer scannable on
large payloads. The JSON renders in a focusable `<pre>` so you can
tab into it and use the screen reader to read it line by line.

---

## 4. LLM calls

**Admin · Observability · LLM calls**

Every LLM call that went through the central client. Use this for
cost questions, latency questions, error questions, and for tying
a model response back to the chat run that asked for it.

### Rollups card

The top of the page shows two columns of metrics — **last 24h** and
**last 7d**:

- Count
- Error rate (percentage of rows with a non-null `error`)
- Total cost in USD
- p50 latency (ms)
- p95 latency (ms)

The rollups query is separate from the list, so paging through the
list does not recompute the windows.

### Filters

`Model`, `Endpoint`, `Layer`, `User`, `Status` (`Success` or
`Error`), `From`, `To`, `Cost ≥`, `Latency ≤ ms`. Status is
derived from whether the row's `error` column is null.

### Columns

| Column          | Meaning                                                |
| --------------- | ------------------------------------------------------ |
| Started at      | When the call started.                                 |
| Model           | Model id, e.g. `claude-3-5-sonnet-20241022`.           |
| Endpoint        | Provider endpoint, e.g. `/v1/messages`.                |
| Tokens in / out | From the provider response.                            |
| Cost (USD)      | Computed by the LLM client.                            |
| Latency (ms)    | Wall-clock duration of the call.                       |
| Status          | `Success` or `Error` (icon + text — never color-only). |

### Detail drawer

- Request and response JSON, each redacted at write time. Renders
  inside a `<details>` expander; if the payload was larger than
  200 KB the server truncates it and appends a
  `...[truncated; full payload available via API]` marker, with a
  byte count.
- The matching `events` rows (joined by `correlation_id`, capped
  at 50) so you can pivot back to the broader timeline.

### What is redacted

`request` and `response` are passed through the central redactor at
write time (`apps/server/src/llm/redaction.ts`). Key names that
match the secret list (`token`, `key`, `password`, …) become
`"[redacted]"`, and value patterns matching common secret shapes
are scrubbed. No unredacted path exists server-side — the table
column itself carries the redacted text.

---

## 5. Chat-pipeline runs

**Admin · Observability · Chat pipeline runs**

One row per assistant reply. Each row carries its step timeline
(`intent`, `entities`, `retrieval`, `answer`) plus the linked LLM
calls.

### Filters

`Layer`, `User`, `Status` (`Success` / `Error`, derived from the
step-level error count), `From`, `To`.

### Columns

| Column       | Meaning                           |
| ------------ | --------------------------------- |
| Started at   | Run start.                        |
| Conversation | `conversation_id`.                |
| Status       | `Success` or `Error`.             |
| Steps        | `successful steps / total steps`. |
| Duration     | Total wall-clock duration.        |
| LLM calls    | Number of LLM calls in the run.   |

### Detail drawer

Shows the run's metadata, the ordered step timeline (each step's
status, duration, error code if any) as a CSS bar chart, and the
linked `llm_calls` rows.

### Raw chat content — the gate

The `intent` and `entities` step `input_json` columns contain the
**raw user message** by design (the rest of the pipeline depends
on it). The drawer hides those two columns behind an explicit
**Show raw chat content** button. Clicking it re-fetches the run
detail with `?raw=true` and replaces the gated fields with the
actual text.

**Every click is logged.** The server publishes a closed-shape bus
event named `admin.observability.chat-runs.raw-content.viewed`
with a payload of `{ runId, revealedKinds: ('intent' |
'entities')[] }` and writes a matching `console.log` line. The
event records the row id and the gated step kinds whose raw input
was returned — **never the content itself**. One click maps to
one log line and one event; if you open ten different runs and
click the button on each, that produces ten audit events.

This is not a hidden behaviour. It is the deliberate seam between
"admin can debug a chat pipeline" and "admin browses raw
conversation history". Treat the gate as a record of intent: every
click is a small explicit "I need to see this user's words".

The button lives inside a `role="alert"` warning region so a
screen reader announces the warning when the drawer opens.

---

## 6. Scheduled-task runs

**Admin · Scheduled tasks** (under Operations)

The Scheduled tasks list page already showed each task's
configuration. Each row now has a **Runs** link that opens
`/admin/scheduled-tasks/:id/runs`. This page is paginated, lists
runs newest-first, and surfaces:

- Run start.
- Status (`succeeded`, `failed`, `running`, `pending`).
- Duration.
- Attempt number.
- Error message if present.

This is the right place to investigate a misbehaving scheduled
task. Use the events log (§3) with a `kind` filter of
`scheduled.` if you need to see the bus-level activity.

---

## 7. Bus ledger

**Admin · Bus ledger** (under Operations — was "Bus DLQ" before)

The page now renders two tabs:

- **DLQ** — dead-letter queue rows. Behaviour is unchanged from
  before the rename: per-row Replay button with a confirmation
  dialog, refresh button, filter form.
- **Outbox** — non-DLQ outbox rows. Use this to see in-flight,
  delivered, or pending messages that have not landed in the DLQ.

### Outbox columns

| Column      | Meaning                                                       |
| ----------- | ------------------------------------------------------------- |
| Occurred at | When the row was published.                                   |
| Type        | Event type (e.g. `chat.message.created`).                     |
| Status      | `pending` / `in_flight` / `delivered` / `dead` / `abandoned`. |
| Subscriber  | Which subscriber the row was claimed by, if any.              |
| Preview     | First ~500 bytes of the payload.                              |

### Outbox detail drawer

Full `payload` and `metadata` JSON, each rendered in a `<details>`
expander. Payloads over 200 KB are server-truncated with the
`...[truncated; full payload available via API]` marker.

---

## 8. Analytics events

**Admin · Observability · Analytics**

Product-flow events emitted from the web client. The client wires
the HTTP sink (`apps/web/src/lib/analytics-http-sink.ts`) once on
boot. Every `trackEvent('chat_message_sent', …)` call across the
app batches into a `POST /analytics/events` request to the server,
which validates the event against the catalogue in
`docs/dev/observability/analytics.md` and writes a row to the
`analytics_events` table.

### What is and is not in this table

- The **event name** must be in the catalogue. Unknown names are
  rejected at ingest with `400` and a `analytics.events.rejected`
  log line.
- Every **property key** must be in the catalogue for that event
  name. Unknown keys are also rejected — the catalogue is the
  contract.
- Property **values** are restricted at the server to `string`,
  `number`, `boolean`, or `null`. Nested objects or arrays are
  rejected, so a misbehaving client cannot smuggle raw user
  content through a documented key.
- The `user_id` is **hashed server-side** before persist
  (`user_id_hash`). The raw id never lands on disk for this table
  — the deliberate asymmetry with `llm_calls.user_id`, which keeps
  the raw UUID. The rationale lives in
  [`ADR 0031`](../../dev/decisions/0031-analytics-local-sink.md)
  D3.

### Rollups card

Top-5 event names by 24h count and by 7d count, each shown
side by side.

### Filters

`Event name` (select from the catalogue dropdown), `Layer`,
`User hash` (paste the hash from another row), `From`, `To`.

### Detail drawer

Shows the row, the user-id hash, and the row's
`properties_json` — alongside the **documented property schema**
from the catalogue. If the row has a property key that is no
longer in the catalogue, the drawer flags it with a
`role="alert"` line. That is the drift signal.

---

## 9. Retention

Each surface has a scheduled prune job. The defaults are:

| Table                           | Job                      | Default retention |
| ------------------------------- | ------------------------ | ----------------: |
| `events`                        | `events.prune`           |               30d |
| `llm_calls`                     | `llm.calls.prune`        |               30d |
| `chat_pipeline_runs` / `_steps` | `chat.runs.prune`        |               30d |
| `analytics_events`              | `analytics.events.prune` |               90d |
| `bus_outbox` / `bus_dlq`        | bus-internal prune       |  per bus settings |

Retention is overridable per env (e.g.
`ANALYTICS_RETENTION_DAYS`) and per task row via the task's
`config` JSON. See
[`job-inventory.md`](../../dev/architecture/job-inventory.md) for
the full list.

---

## 10. Privacy notes

- Analytics events store hashed user ids. LLM calls store raw user
  ids (admin-only viewer + the link back to layer membership is
  needed for cost attribution).
- Every detail drawer renders **pre-redacted JSON only**. The
  server has no "show me the unredacted version" endpoint.
- The chat-pipeline raw-content gate (§5) is the one explicit seam
  where an admin sees raw user words. Every click is audited.

The authoritative breakdown lives in
[`docs/dev/audits/admin-observability-redaction-2026-05-25.md`](../../dev/audits/admin-observability-redaction-2026-05-25.md).

---

## 11. What's not here

The viewers are deliberately read-only and paginated. These were
the non-goals when the surface shipped, and the seams are worth
knowing about:

- **No real-time tailing.** No Server-Sent Events, no WebSocket
  push. Click **Refresh** to fetch the latest rows. If real-time
  tail becomes useful, it will be a separate follow-up.
- **No CSV / JSON export from the UI.** Use the SQLite file
  directly if you need to export.
- **No edit / delete from the UI.** Pruning is the only delete
  path, and it runs as a scheduled job. The DLQ Replay button is
  the one exception, and it predates this work.
- **No cross-instance aggregation.** Single-server / single-
  desktop only. There is no central log aggregator and no plan
  to add one in this project.
- **No full BI dashboard.** Aggregations are limited to rolling
  24h / 7d count + latency p50 / p95 + total cost per surface.
- **No per-layer "my AI usage" dashboard for non-admins.**
  Observability stays admin-only; per-layer self-service views
  are a separate future decision.
- **UUIDs render raw.** Layer ids, user ids, and message ids
  show as the raw UUID rather than a display name or slug.
  Resolving them is a tracked follow-up — see the tasklist row
  for the admin UUID resolution polish.

---

## 12. Where the code lives

For developers reading this guide:

- Server endpoints — `apps/server/src/http/routes/admin-observability.ts`,
  `apps/server/src/http/routes/analytics.ts`,
  `apps/server/src/http/routes/admin-bus.ts`.
- Web pages — `apps/web/src/pages/admin/Admin*Page.tsx`.
- Analytics catalogue — `apps/server/src/analytics/catalogue.ts`.
- Web analytics sink — `apps/web/src/lib/analytics-http-sink.ts`.
- ADR — `docs/dev/decisions/0031-analytics-local-sink.md`.
- Redaction audit —
  `docs/dev/audits/admin-observability-redaction-2026-05-25.md`.
- Observability docs (event catalogues + privacy rules) —
  `docs/dev/observability/{logging,telemetry,analytics}.md`.
