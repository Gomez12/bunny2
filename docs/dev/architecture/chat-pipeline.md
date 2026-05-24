# Chat pipeline

> Status: living document.
> Owners: phase 6 introduced this; phase 7+ extends the answerer step
> with retrieval-quality work and (eventually) tool calling.
> Source code: `apps/server/src/chat/pipeline/`,
> `apps/server/src/chat/events.ts`,
> `apps/server/src/chat/repos/`,
> `apps/server/src/http/routes/layer-chat.ts`,
> `apps/server/src/storage/migrations/0014_chat.sql`,
> `packages/shared/src/schemas/chat.ts`,
> tests under `apps/server/tests/chat-pipeline/`,
> `apps/server/tests/chat-routes/`.

This is the single-page tour of bunny2's per-layer chat pipeline.
Companion to [`retrieval.md`](./retrieval.md),
[`event-bus.md`](./event-bus.md),
[`scheduled-tasks.md`](./scheduled-tasks.md),
[`overview.md`](./overview.md), and ADRs
[`0020`](../decisions/0020-chat-pipeline.md) (pipeline contract),
[`0021`](../decisions/0021-embedding-and-lance-auth-tag.md)
(retrieval + LanceDB auth tag) and
[`0022`](../decisions/0022-sse-for-answerer.md) (SSE for the answerer).

---

## 1. What ships in phase 6

Per-layer multi-turn chat. A logged-in user posts a question to
`POST /l/:slug/chat/conversations/:id/messages` and the server
streams the answerer's tokens back via SSE. The answer is grounded
in the entities the caller can see in this layer (companies,
contacts, calendar events, todos — phase 4's four kinds), never on
LLM general knowledge alone.

Four steps run synchronously inside that one HTTP request:

```
                     ┌────────────────────────────┐
POST .../messages   │      runPipeline(ctx)       │
   (user text)  ──► │                            │
                     │  intent  → entities →      │
                     │  retrieval → answer        │
                     │                            │
                     └────────────────────────────┘
                                │
                                ▼
            SSE: step / token / done / error
```

Three of those steps make LLM calls (intent, entities, answer);
retrieval is pure SQL through the entity store. Each step writes
one row to `chat_pipeline_steps`; the orchestrator emits two bus
events per step transition (`chat.step.started` /
`chat.step.succeeded` | `failed`) and three lifecycle events per
message (`chat.message.received`, `chat.message.answered` |
`chat.message.failed`).

ADR [`0020`](../decisions/0020-chat-pipeline.md) records why the
pipeline is hard-coded (not LLM tool-calling), where the auth
boundary lives (retrieval, never the answerer), and why pipeline
runs are request-scoped (not on the durable bus).

---

## 2. Data model

```
chat_conversations
  id            TEXT PRIMARY KEY      -- uuid
  layer_id      TEXT NOT NULL REFERENCES layers(id)
  user_id       TEXT NOT NULL REFERENCES users(id)
  title         TEXT NOT NULL          -- first 60 chars of first user msg
  locale        TEXT NOT NULL
  created_at / updated_at / deleted_at / deleted_by

chat_messages
  id              TEXT PRIMARY KEY
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id)
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','system'))
  content         TEXT NOT NULL
  status          TEXT NOT NULL CHECK
                    (status IN ('queued','running','done','failed'))
  model           TEXT
  tokens_in / tokens_out INTEGER
  correlation_id / flow_id TEXT NOT NULL
  created_at / finished_at

chat_pipeline_runs
  id          TEXT PRIMARY KEY
  message_id  TEXT NOT NULL REFERENCES chat_messages(id)
  status      TEXT NOT NULL          -- pending|running|succeeded|failed
  started_at / ended_at

chat_pipeline_steps
  id            TEXT PRIMARY KEY
  run_id        TEXT NOT NULL REFERENCES chat_pipeline_runs(id)
  kind          TEXT NOT NULL          -- intent|entities|retrieval|answer
  status        TEXT NOT NULL
  attempt       INTEGER NOT NULL DEFAULT 1
  started_at / ended_at
  input_json / output_json
  llm_call_id   TEXT                   -- FK to llm_calls(id), nullable
  error_code    TEXT

chat_message_feedback
  id          TEXT PRIMARY KEY
  message_id  TEXT NOT NULL UNIQUE REFERENCES chat_messages(id)
  user_id     TEXT NOT NULL REFERENCES users(id)
  value       TEXT NOT NULL CHECK (value IN ('up','down'))
  reason      TEXT                     -- only on `down`
  created_at  TEXT NOT NULL
```

Schema lives in `apps/server/src/storage/migrations/0014_chat.sql`.
Soft-delete (`deleted_at` + `deleted_by`) lives on conversations
only — messages, runs, steps, and feedback are immutable once
written. UUID ids, ISO-8601 UTC timestamps — every phase-3+ entity
convention applies.

zod schemas mirror the SQL row shape in
`packages/shared/src/schemas/chat.ts` so the HTTP routes share one
source of truth with the repos.

---

## 3. Module map

`apps/server/src/chat/`:

```
pipeline/
  types.ts          PipelineContext, PipelineStep<I,O>, hook types
  intent-step.ts    LLM call: classify into the small intent enum
  entities-step.ts  LLM call: pick entity kinds + queryHints
  retrieval-step.ts pure code: searchSummaries(layerIds, term) per hint
  answer-step.ts    LLM call (streamed): final response
  step-utils.ts     zod-validate + retry wrapper, error-code mapping
  orchestrator.ts   runPipeline(): drives the four steps, persists
                    every transition, publishes bus events
embeddings/
  embedder.ts       Embedder interface + MockEmbedder + OpenAiEmbedder
  lance-tables.ts   one table per entity kind, layer_id is auth_tag
  subscriber.ts     entity.*  → LanceDB upsert / delete
  backfill-handler.ts  scheduled-task handler kind=chat.embeddings.backfill
repos/
  chat-conversations-repo.ts
  chat-messages-repo.ts
  chat-pipeline-runs-repo.ts
  chat-pipeline-steps-repo.ts
  chat-message-feedback-repo.ts
events.ts           CHAT_EVENT_TYPES (closed set; see §5)
review-layer-handler.ts  kind=chat.review-layer (placeholder; phase 7)
runs-prune-handler.ts    kind=chat.runs.prune (run-history retention)
index.ts            barrel + registerChatScheduledTaskHandlers()
```

HTTP transport lives in
`apps/server/src/http/routes/layer-chat.ts` (six routes; see §6).

---

## 4. Pipeline contract

Each step is a `PipelineStep<TIn, TOut>` (see
`pipeline/types.ts`). The orchestrator hands each step a
`PipelineContext`:

```ts
interface PipelineContext {
  readonly conversationId: string;
  readonly messageId: string;
  readonly layerId: string;
  readonly effectiveLayerIds: readonly string[];
  readonly userId: string;
  readonly correlationId: string;
  readonly flowId: string;
  readonly history: readonly ChatMessage[]; // capped at last 20 turns
}
```

| Step      | Input                              | Output                                                                | Persisted on step row                  | LLM?           |
| --------- | ---------------------------------- | --------------------------------------------------------------------- | -------------------------------------- | -------------- |
| intent    | `{ userText }`                     | `{ intent, confidence }`                                              | input_json + output_json + llm_call_id | yes            |
| entities  | `{ userText, intent }`             | `{ kinds: EntityKind[], queryHints: { term, kind?, timeWindow? }[] }` | input_json + output_json + llm_call_id | yes            |
| retrieval | `{ kinds, queryHints }`            | `{ hits: { kind, id, slug, title, snippet }[] }`                      | input_json + output_json (no llm_call) | no             |
| answer    | `{ history, retrieval, userText }` | `{ content, tokensIn, tokensOut, model }`                             | input_json + output_json + llm_call_id | yes (streamed) |

Step outputs are zod-validated before persistence; a parse failure
counts as a transient error and the step retries once before
moving to `failed` with `error_code='invalid_step_output'`. See
`step-utils.ts` for the wrapper.

### 4.1 The auth boundary

The **retrieval** step is the only step that touches entity data.
It calls `entityStore.searchSummaries(ctx.effectiveLayerIds, term,
{ limit: 5 })` for each `(kind, term)` pair the entities step
produced, aggregates, dedupes by id, and caps at 20 hits. The
answerer only sees the retrieval output — never raw entity rows
from anywhere else.

Aux test: `apps/server/tests/chat-pipeline/orchestrator.test.ts`
asserts a question that would match a layer the caller cannot see
returns retrieval `output_json` without that row, and the
answerer's input doesn't mention it. ADR
[`0020`](../decisions/0020-chat-pipeline.md) §2 and
[`0021`](../decisions/0021-embedding-and-lance-auth-tag.md) §1 pin
this contract; `overall.md` §5 invariant 8 ("authorization-aware
retrieval") is the project-level rule it implements.

### 4.2 Retry + abort

Transient LLM errors retry inline: max 2 attempts, exponential
250 ms → 1 s. On the second failure the step lands `failed` with
`error_code` set, the message moves to `failed`, and the route
emits `event: error` with a localized `errorKey`. Defaults live on
the chat module config (`max_attempts`, `backoff_base_ms`,
`backoff_max_ms`).

Aborts come from two places:

1. **Client closes the SSE connection** — the route ties the LLM
   call's `AbortSignal` to the request lifecycle. The streaming
   wrapper collects the partial response, persists it to
   `chat_messages.content`, flips the message to `failed`, and
   writes one `llm_calls` row with `error='aborted'`.
2. **Upstream LLM throws mid-stream** — same persistence path,
   `error_code='upstream'` on the step row, `event: error` on the
   SSE wire.

A 60-second hard timeout (configurable) caps the total answerer
duration. ADR [`0022`](../decisions/0022-sse-for-answerer.md) §4
records the lifecycle contract.

### 4.3 Sweep handler for orphaned runs

If the server crashes mid-pipeline, the assistant `chat_messages`
row stays in `running`. The `chat.runs.prune` scheduled-task
handler (`runs-prune-handler.ts`, registered via
`registerChatScheduledTaskHandlers`) does double duty:

- **Sweep**: flip `chat_pipeline_runs` rows still `running` past
  the lease window (default 5 min) to `failed`; mark the
  corresponding `chat_messages` row `failed`.
- **Prune**: retain N days of `chat_pipeline_runs` + steps (mirror
  `scheduled.runs.prune`'s shape — default 30 d).

Inventory row at `docs/dev/architecture/job-inventory.md`.

---

## 5. Bus events

Closed set in `apps/server/src/chat/events.ts`:

| Type                    | When                                       | Payload                                          |
| ----------------------- | ------------------------------------------ | ------------------------------------------------ |
| `chat.message.received` | After the user `chat_messages` row inserts | `{ conversationId, messageId, layerId, userId }` |
| `chat.message.answered` | Assistant message flipped to `done`        | `{ messageId, tokensIn, tokensOut, durationMs }` |
| `chat.message.failed`   | Pipeline gave up                           | `{ messageId, errorCode }`                       |
| `chat.step.started`     | Step run() begins                          | `{ runId, messageId, kind, attempt }`            |
| `chat.step.succeeded`   | Step returned                              | `{ runId, messageId, kind, durationMs }`         |
| `chat.step.failed`      | Step threw                                 | `{ runId, messageId, kind, attempt, errorCode }` |

Events are emitted purely for observability — they are **not** the
runtime of the pipeline. ADR
[`0020`](../decisions/0020-chat-pipeline.md) §3 records why
pipeline runs do not go through the durable bus's outbox: the run
is request-scoped, and a retry the user is no longer waiting for
is wasted LLM cost.

All event payloads carry `correlationId` + `flowId` so the
`events` log, `llm_calls`, `chat_messages`, and
`chat_pipeline_steps` rows can be joined for any one message.

---

## 6. HTTP surface

Routes are mounted by `registerLayerChatRoutes(app, deps)` from
`apps/server/src/http/routes/layer-chat.ts`. Every route uses the
phase-3 `createRequireLayer` middleware — non-members see
`404 errors.layer.notVisible`.

| Route                                      | Method | Body / response                                                |
| ------------------------------------------ | ------ | -------------------------------------------------------------- | ---------------------------- |
| `/l/:slug/chat/conversations`              | POST   | `{ title? }` → `{ conversation }`                              |
| `/l/:slug/chat/conversations`              | GET    | `{ conversations: [{…, feedbackUpCount, feedbackDownCount}] }` |
| `/l/:slug/chat/conversations/:id`          | GET    | `{ conversation }`                                             |
| `/l/:slug/chat/conversations/:id`          | DELETE | `{ ok: true }` (soft-delete)                                   |
| `/l/:slug/chat/conversations/:id/messages` | GET    | `{ messages: ChatMessage[] }`                                  |
| `/l/:slug/chat/conversations/:id/messages` | POST   | **SSE.** Body `{ content }` only; rejects `model`              |
| `/l/:slug/chat/messages/:id/feedback`      | POST   | `{ value: 'up'                                                 | 'down', reason? }` → upserts |
| `/l/:slug/chat/board`                      | GET    | `{ cards: BoardCard[] }` (last N hours)                        |

### 6.1 SSE framing

Four event kinds — `step`, `token`, `done`, `error`. ADR
[`0022`](../decisions/0022-sse-for-answerer.md) §2 records the
shape; the wire is exactly:

```
event: step
data: {"kind":"intent","status":"running","attempt":1}

event: step
data: {"kind":"intent","status":"succeeded","durationMs":312}

event: step
data: {"kind":"entities","status":"running","attempt":1}

event: step
data: {"kind":"entities","status":"succeeded","durationMs":287}

event: step
data: {"kind":"retrieval","status":"succeeded","durationMs":7,"hits":3}

event: step
data: {"kind":"answer","status":"running","attempt":1}

event: token
data: {"delta":"Your meeting "}

event: token
data: {"delta":"with Acme "}

event: token
data: {"delta":"is on Friday."}

event: done
data: {"messageId":"...","status":"done","tokensIn":841,"tokensOut":12}
```

On hard failure:

```
event: error
data: {"errorCode":"upstream","errorKey":"chat.errors.upstream","messageId":"..."}
```

Each `data:` payload is JSON. The web client demuxes on `event:`
and treats unknown events as ignorable (forward-compatible).
Keepalive comments (`: keepalive\n\n`) fire every 15 s to defeat
proxy idle-killers. The response sets
`Content-Type: text/event-stream`, `Cache-Control: no-cache`,
`X-Accel-Buffering: no`.

### 6.2 Orchestrator hooks

The HTTP route wires two callbacks into `runPipeline`:

- `chunkSink: (delta) => writeToken(delta)` — forwards every
  answer-step chunk as one `event: token`.
- `onStepEvent: (event) => writeStep(event)` — forwards every
  step transition as one `event: step`.

The orchestrator publishes the corresponding `chat.step.*` bus
events on the **same** transitions, so a Kanban board listening on
the bus and the SSE consumer see the same shape. Both callbacks
are best-effort: if they throw, the orchestrator logs and
continues (see `safeStepEvent` in `orchestrator.ts`).

---

## 7. Authorization

- All routes mount under `/l/:slug/chat/*` and require the caller
  to see the layer (`createRequireLayer`).
- Conversations are scoped to `(layer_id, user_id)`. v1 is
  personal-by-default; a "shared conversation" toggle is recorded
  as a phase-7 follow-up.
- The SSE endpoint never accepts a model override from the client
  (the route returns 400). The per-layer chat model is
  system-default until a phase-7 follow-up adds layer-level
  overrides.
- Retrieval filters on `c.var.effectiveLayers` before
  `searchSummaries` — see [`retrieval.md`](./retrieval.md) for the
  read path's authorization contract and how phase 7 will preserve
  it when LanceDB reads replace LIKE.
- Feedback is scoped to the caller; an `INSERT … ON CONFLICT
(message_id) DO UPDATE` upsert makes the second post overwrite
  the first. `reason` is only accepted on `down`.

---

## 8. Observability

- **Logging**: every step transition writes a
  `chat_pipeline_steps` row; the orchestrator logs errors with
  `console.warn`. Handler errors land in `console.error` (clipped
  to the step row's `error_code`, never the raw stack on the wire).
- **Telemetry (LLM)**: every LLM call (intent + entities + answer)
  produces exactly **one** `llm_calls` row, streamed or not. ADR
  [`0022`](../decisions/0022-sse-for-answerer.md) §3 records the
  one-row-per-call contract and how the streaming wrapper collects
  partial responses on abort.
- **Telemetry (bus)**: the durable-bus middleware writes one
  `events` row per `chat.*` publish.
- **Analytics**: thumbs up / down feedback rows in
  `chat_message_feedback` are the product-level signal. The
  dashboard `RecentChatsWidget` aggregates them per conversation
  (count up + count down).

Cross-references: `events` rows and `llm_calls` rows share the
same `correlation_id` + `flow_id`, so a single message can be
joined across logs, telemetry, and feedback for diagnostics.

---

## 9. Testing the pipeline

- **Unit**:
  `apps/server/tests/chat-pipeline/step-utils.test.ts`
  (retry + zod validation),
  `apps/server/tests/chat-embeddings-*.test.ts` (embedder + writer
  - subscriber + backfill).
- **Repos**:
  `apps/server/tests/chat-conversations-repo.test.ts`,
  `chat-messages-repo.test.ts`,
  `chat-pipeline-runs-repo.test.ts`,
  `chat-pipeline-steps-repo.test.ts`,
  `chat-message-feedback-repo.test.ts`.
- **Orchestrator integration**:
  `apps/server/tests/chat-pipeline/orchestrator.test.ts` against
  the programmable LLM
  (`apps/server/tests/_helpers/programmable-llm.ts`). Asserts the
  4 step rows, the 3 llm_calls rows, and the auth-boundary
  filtering.
- **HTTP / SSE**:
  `apps/server/tests/chat-routes/auth-crud.test.ts`,
  `chat-routes/feedback.test.ts`, `chat-routes/board.test.ts`,
  `chat-routes/sse-stream.test.ts` (happy path + upstream error +
  client abort + body-validation 400).
- **Sweep + retention**:
  `apps/server/tests/chat-runs-prune.test.ts` (sweep stale
  `running` runs to `failed`, prune past retention),
  `chat-review-layer.test.ts` (placeholder body).
- **Smoke**: `apps/server/tests/smoke.test.ts` exercises one
  end-to-end question against a real calendar event in a real
  layer, asserts the streamed answer, the feedback row, and the
  LanceDB row landing then disappearing on soft-delete.
- **Job inventory**:
  `apps/server/tests/docs/job-inventory.test.ts` enforces that
  every registered `kind` has a row in
  [`job-inventory.md`](./job-inventory.md). The three chat kinds
  (`chat.embeddings.backfill`, `chat.review-layer`,
  `chat.runs.prune`) land via `registerChatScheduledTaskHandlers`.

---

## 10. Future extensions

- **Read swap to LanceDB** — phase 7 first sub-phase. The corpus
  is already populated by the write subscriber registered in
  phase 6.2; the read path stays behind the same
  `searchSummaries(layerIds, term)` interface. See
  [`retrieval.md`](./retrieval.md) §4 for the forward contract and
  ADR [`0021`](../decisions/0021-embedding-and-lance-auth-tag.md)
  §4 for the deliberate read/write asymmetry.
- **Tool / function calling** — the hard-coded pipeline ships in
  phase 6 deliberately. Phase 7's self-learning loop is the place
  to revisit this, once we have telemetry on which questions the
  hard-coded shape fails. ADR
  [`0020`](../decisions/0020-chat-pipeline.md) §1 records the
  rejection.
- **Conversation auto-summary** — `chat.summarize-conversation` is
  a reserved scheduled-task kind for phase 7. See follow-up
  `docs/dev/follow-ups/chat-conversation-auto-summary.md`.
- **Stop-generating button** — a `POST .../abort` route. ADR
  [`0022`](../decisions/0022-sse-for-answerer.md) §1 records why
  it's not in phase 6.
- **Per-layer model override** — phase 6 keeps the system-default.
  Follow-up `docs/dev/follow-ups/chat-per-layer-llm-model.md`.
- **Shared / team conversations** — the `(layer_id, user_id)`
  scoping is intentional in v1. Follow-up
  `docs/dev/follow-ups/chat-shared-conversations.md`.
- **Page deep-link to a specific message** — the board card
  deep-link includes `?message=:id` but the page currently ignores
  the query string. Follow-up
  `docs/dev/follow-ups/chat-page-message-deep-link.md`.
