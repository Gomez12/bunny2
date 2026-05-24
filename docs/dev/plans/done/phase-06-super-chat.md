# Phase 6 — Super Chat

> Parent: [`overall.md`](./overall.md) §8 Phase 6.
> Scope of this document: **detailed plan for phase 6 only**.
> Inherits from `overall.md` §4 (stack), §5 (event-sourced core,
> layered scoping, soft-delete, UUIDs, i18n, authorization-aware
> retrieval), §10 (LLM provider + telemetry decisions).
> Builds on phase 3
> ([`done/phase-03-layers.md`](./done/phase-03-layers.md)) — every
> conversation lives inside one layer, retrieval reads through
> `c.var.effectiveLayers`, every mutation publishes a bus event.
> Builds on phase 4
> ([`done/phase-04-first-entities.md`](./done/phase-04-first-entities.md))
> for the entity catalogue, the shared `EntityStore.searchSummaries`
> primitive, the `searchable_text` column on every per-kind table,
> and the AI-enrichment fields (calendar `meetingSummaryNote`,
> company `description`).
> Builds on phase 5
> ([`done/phase-05-scheduled-tasks.md`](./done/phase-05-scheduled-tasks.md))
> for the scheduled-task registry (one `kind` per built-in handler)
> and the durable SQLite-backed bus (ADR
> [`0019`](../decisions/0019-durable-sqlite-message-bus.md)).
> Supersedes the single-turn phase-1 `POST /chat` surface as the
> "real" chat — the phase-1 page stays as a diagnostic for the
> system-level LLM config only.

---

## 1. Goal

Make the entities the user has accumulated (companies, contacts,
calendar events, todos) **answerable from a chat box**, per layer,
multi-turn, with the answerer's working state visible. The
originalplan.md spec is one question — _"wanneer heb ik de ontmoeting
met 2ba"_ — and the system must:

1. Route the intent (lookup vs summary vs command vs smalltalk).
2. Resolve which entity kinds + search terms are involved.
3. Retrieve real entity rows the user is allowed to see.
4. Compose a streamed answer that cites those rows.
5. Capture thumbs up/down feedback per assistant message.
6. Show the pipeline on a Kanban board so the user sees what the
   agent is doing right now.

After phase 6 a logged-in user should be able to:

1. Open `/l/<slug>/chat`, start a conversation, ask "when do I meet
   Acme?", and read a streamed answer that names the right event
   date — pulled from real entity data, never hallucinated past
   what retrieval handed the LLM.
2. Thumbs-down with an optional reason; thumbs-up. Both persist
   across reloads.
3. Open `/l/<slug>/chat/board` and see one card per recent message
   moving through the pipeline columns
   `queued → intent → entities → retrieval → answering → done`
   (or `failed`) in real time for the active conversation.
4. See a "Recent chats" widget on the layer dashboard listing the
   last 5 conversations together with their thumbs-up/down ratio.
5. Switch layers; the chat is gone (a different layer is a
   different conversation set).
6. Inspect `/admin/llm/logs` and find three `llm_calls` rows for any
   processed message (router, resolver, answerer). Retrieval makes
   zero LLM calls — it goes straight through `searchSummaries`.

Phase 6 is **also** where vector storage starts paying its phase-1
investment: every entity write encodes its `searchable_text` and
upserts a LanceDB row tagged with `layer_id`. Phase 6 does **not**
read from LanceDB; phase 7 flips the read path once the corpus is
there.

---

## 2. Scope

In scope:

- New tables: `chat_conversations`, `chat_messages`,
  `chat_pipeline_runs`, `chat_pipeline_steps`,
  `chat_message_feedback`. Migration `0014_chat.sql`.
- Pipeline orchestrator (router → resolver → retrieval → answerer);
  each step persisted to `chat_pipeline_steps`, each transition
  emitted on the bus.
- Layer-filtered retrieval over the four phase-4 entity kinds via
  the existing `EntityStore.searchSummaries(layerIds, query)`.
  No LanceDB reads.
- LanceDB **write** scaffold: one table per entity kind, schema
  `{ id, layer_id, kind, slug, text, vector }`, `layer_id` is the
  **auth_tag**. Upserts on `entity.created` / `entity.updated`
  bus events; removes on `entity.deleted` / `entity.softDeleted`
  so the corpus respects soft-delete. Configurable embedder with
  `MockEmbedder` default (deterministic hash → 32-dim vector;
  keeps CI offline) and `OpenAiEmbedder` for real deployments.
- Per-layer HTTP routes under `/l/:slug/chat/*` (conversations
  CRUD + post message + SSE stream of the assistant turn).
- Streaming variant of the LLM client (`chatStream`) for the
  answerer step only. One `llm_calls` log row per call, streamed
  or not.
- Web UI `/l/:slug/chat` — three-pane page (conversation list +
  thread + composer) with EventSource-based token streaming.
- Web UI `/l/:slug/chat/board` — per-message pipeline Kanban,
  visual shape reused from `TodosKanbanView`.
- `RecentChatsWidget` registered via the existing widget registry.
- Three scheduled-task handlers registered: `chat.embeddings.backfill`
  (real; rate-limited), `chat.review-layer` (placeholder body —
  phase 7 fills it), `chat.runs.prune` (retention, mirrors
  `scheduled.runs.prune`).
- ADR `0020 — chat pipeline contract`, ADR `0021 — embedding
pipeline + LanceDB auth_tag`, ADR `0022 — SSE for the answerer
step`.
- `docs/dev/architecture/chat-pipeline.md` (orchestrator + step
  persistence + SSE framing), `docs/dev/architecture/retrieval.md`
  (LIKE-now + LanceDB-later read-swap; auth_tag invariant), user
  guide `docs/user/guides/working-with-chat.md`.
- Smoke extension: create a calendar event, ask about it, assert
  the answer references it, thumbs-up, assert the feedback row,
  assert the LanceDB row for the event, soft-delete and assert
  the LanceDB row is gone.
- i18n keys under `chat.*` (en + nl 1:1).
- `tests/docs/job-inventory.test.ts` updated with the three new
  kinds (matches the AGENTS.md §Pull Requests `docs:check` rule).

Out of scope (deferred, called out so a sub-phase cannot drag them
in):

- LanceDB **reads**. Read-path swap is a phase-7 follow-up; rows
  are already there so backfill is not needed.
- LLM tool/function-calling. The pipeline is hard-coded; tools are
  a phase-7+ alternative once the self-learning loop starts
  proposing them.
- Streaming for router/resolver/retrieval. Only the answerer
  streams; the other three steps surface on the Kanban as discrete
  transitions.
- Self-learning / review-job body. `chat.review-layer` registers
  in phase 6 but the run body is a no-op until phase 7.
- Threshold automation. Phase 8.
- New entity kinds. The "Later" catalogue from `overall.md` §6
  stays "Later".
- Cross-layer chat. One conversation lives in one layer; switching
  layers switches conversations.
- Shared / multi-user conversations. v1 is `(layer_id, user_id)`
  scoped. A "shared" toggle is recorded as a phase-7 follow-up
  candidate.
- Mobile or non-Electron clients (per `overall.md` §3).
- Streaming over WebSockets. SSE only (ADR 0022 records why).

---

## 3. Sub-phases

| #   | Title                                                                                                                                                                                                                                                            | Estimate | Output                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------: | --------------------------------------------------------------------------- |
| 6.0 | This detail plan + ADR stubs (`0020`, `0021`, `0022` as `proposed`)                                                                                                                                                                                              |       3h | plan + ADR drafts; tasklist rows 6.1–6.7 open                               |
| 6.1 | Migration `0014_chat.sql` + repos (`chat_conversations`, `chat_messages`, `chat_pipeline_runs`, `chat_pipeline_steps`, `chat_message_feedback`) + zod schemas in `packages/shared/src/schemas/chat.ts` + repo unit tests                                         |       5h | schema migration applied; CRUD round-trips green                            |
| 6.2 | `apps/server/src/chat/embeddings/{embedder,lance-tables,subscriber}.ts` + config gate + `chat.embeddings.backfill` scheduled task + unit tests (Mock determinism, idempotency, soft-delete removes vector row)                                                   |       6h | every entity create/update/soft-delete writes through to LanceDB            |
| 6.3 | `apps/server/src/chat/pipeline/` (types, router step, resolver step, retrieval step, answerer step, orchestrator) + per-step persistence + bus events `chat.message.*` + `chat.step.*` + integration test against the mock LLM                                   |       8h | orchestrator runs end-to-end on the mock LLM; four step rows per message    |
| 6.4 | HTTP routes `/l/:slug/chat/conversations`, `/conversations/:id/messages` (SSE), `/messages/:id/feedback` + `chatStream` on `LlmClient` + telemetry-wrapper streaming variant + route integration tests (including client-abort)                                  |       6h | curl-able SSE; auth tests green; feedback upsert pinned                     |
| 6.5 | Web UI `/l/:slug/chat`: conversation list, thread with streaming assistant bubbles + feedback buttons + composer; api hooks in `apps/web/src/lib/api.ts`; routes wired in `apps/web/src/App.tsx`; phase-1 `/chat` label tweaked to "System chat (diagnostic)"    |       8h | a real conversation can be held in dev                                      |
| 6.6 | Web UI `/l/:slug/chat/board` (Kanban) reusing `TodosKanbanView` shape + `RecentChatsWidget` registered + `chat.review-layer` placeholder + `chat.runs.prune` registered                                                                                          |       5h | board visible; widget on dashboard; job inventory ready                     |
| 6.7 | Smoke (`apps/server/tests/smoke.test.ts` + `apps/server/tests/smoke-worker.test.ts`) + en/nl i18n + ADRs 0020/0021/0022 accepted + `architecture/chat-pipeline.md` + `architecture/retrieval.md` + user guide + `architecture/job-inventory.md` rows + close-out |       5h | green CI; plan moves to `done/`; overall.md §8 phase-6 status block written |

Each sub-phase needs its own `open → done` row in `docs/dev/tasklist.md`
referencing this plan. 6.0 closes when this file + the three ADR
stubs + the seven new tasklist rows land in one commit.

---

## 4. Approach

### 4.1 Pipeline contract (lands in 6.3)

```ts
// apps/server/src/chat/pipeline/types.ts (new)
export type PipelineStepKind = 'intent' | 'entities' | 'retrieval' | 'answer';
export type PipelineStepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface PipelineContext {
  readonly conversationId: string;
  readonly messageId: string;
  readonly layerId: string;
  readonly effectiveLayerIds: readonly string[];
  readonly userId: string;
  readonly correlationId: string;
  readonly flowId: string;
  readonly history: readonly ChatMessage[]; // capped at last 20 turns
}

export interface PipelineStep<TIn, TOut> {
  readonly kind: PipelineStepKind;
  run(input: TIn, ctx: PipelineContext, deps: PipelineDeps): Promise<TOut>;
}
```

- **Intent** (LLM): classify into a small enum
  (`question.entity_lookup`, `question.summary`, `command.create`,
  `command.update`, `smalltalk`, `unsupported`). Output JSON
  validated with zod. Phase 6 only fully handles `question.*`;
  `command.*` returns a polite "not yet supported in phase 6"
  answer (still logged so phase 7 can mine the gap).
- **Entities** (LLM): given user text + intent + the registered
  entity kinds, output `{ kinds: EntityKind[], queryHints: { term:
string, kind?: EntityKind, timeWindow?: { from: string, to:
string } }[] }`. zod-validated.
- **Retrieval** (code, **no LLM**): for each `(kind, term)`, call
  `entityModule.store.searchSummaries(ctx.effectiveLayerIds, term,
{ limit: 5 })`. Aggregate, dedupe by id, cap at 20 hits. **This
  is the auth boundary** — layer filtering happens before the
  answerer sees a row, satisfying `overall.md` §5 invariant 8
  ("authorization-aware retrieval").
- **Answer** (LLM, **SSE-streamed**): system prompt + history +
  retrieval JSON + user message. Streamed token-by-token to the
  client; the full response is collected and persisted with
  `tokens_in` / `tokens_out` when the stream closes. On stream
  error, the partial content is saved and the message moves to
  `failed`.

Each step persists a `chat_pipeline_steps` row (`started_at`,
`ended_at`, `status`, `input_json`, `output_json`, `error_code`,
`llm_call_id`). The orchestrator emits `chat.step.started`,
`chat.step.succeeded`, `chat.step.failed`, and the whole-message
events `chat.message.received`, `chat.message.answered`,
`chat.message.failed`.

Retries are **synchronous within one HTTP request**. Transient
LLM errors retry inline (max 2 attempts, 250 ms then 1 s). On
hard failure the message is `failed` and surfaces on the Kanban.
Pipeline runs do **not** go through the durable bus — that's
reserved for cross-process work. ADR 0020 records this.

### 4.2 Storage shape (lands in 6.1)

```sql
-- 0014_chat.sql sketch (final SQL lands in the 6.1 PR)

CREATE TABLE chat_conversations (
  id TEXT PRIMARY KEY,                  -- uuid
  layer_id TEXT NOT NULL REFERENCES layers(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  locale TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,                      -- soft delete (overall §5)
  deleted_by TEXT
);
CREATE INDEX idx_chat_conversations_layer_user
  ON chat_conversations(layer_id, user_id, deleted_at);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('queued','running','done','failed')),
  model TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  correlation_id TEXT NOT NULL,
  flow_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_chat_messages_conv_created
  ON chat_messages(conversation_id, created_at);

CREATE TABLE chat_pipeline_runs (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES chat_messages(id),
  status TEXT NOT NULL,                 -- pending|running|succeeded|failed
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE chat_pipeline_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES chat_pipeline_runs(id),
  kind TEXT NOT NULL,                   -- intent|entities|retrieval|answer
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  input_json TEXT,
  output_json TEXT,
  llm_call_id TEXT,                     -- FK to llm_calls(id), nullable
  error_code TEXT
);
CREATE INDEX idx_chat_pipeline_steps_run_kind
  ON chat_pipeline_steps(run_id, kind);

CREATE TABLE chat_message_feedback (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE REFERENCES chat_messages(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  value TEXT NOT NULL CHECK (value IN ('up','down')),
  reason TEXT,
  created_at TEXT NOT NULL
);
```

zod schemas live in `packages/shared/src/schemas/chat.ts` (follow
the file shape from `scheduled-tasks.ts`).

### 4.3 Embedding scaffold (lands in 6.2)

- `apps/server/src/chat/embeddings/embedder.ts` — interface
  `{ encode(text: string): Promise<readonly number[]> }`,
  implementations:
  - `MockEmbedder` — deterministic hash → 32-dim float vector.
    Default when no embeddings endpoint is configured (tests, CI,
    dev without an external LLM).
  - `OpenAiEmbedder` — reuses `LlmConfig` plus an
    `embeddings.model` field.
- `apps/server/src/chat/embeddings/lance-tables.ts` — opens four
  tables (`entity_company`, `entity_contact`, `entity_calendar_event`,
  `entity_todo`) with schema `{ id, layer_id, kind, slug, text,
vector }`. **`layer_id` is the auth_tag.** ADR 0021 fixes the
  column name as a forward contract: phase 7's read path filters on
  `layer_id IN (?)` _before_ the vector query, per `overall.md` §5
  invariant 8.
- `apps/server/src/chat/embeddings/subscriber.ts` — subscribes to
  the existing `entity.created` / `entity.updated` /
  `entity.deleted` / `entity.softDeleted` / `entity.restored` bus
  events. Subscriber is **async off the bus** (declared
  `idempotent: true`); the entity write transaction does not wait
  on the embedding call. Soft-delete and hard-delete both remove
  the LanceDB row — the corpus must never surface content the
  primary store hid.
- New scheduled-task handler `chat.embeddings.backfill` registered
  via `registerScheduledTaskHandler` (phase 5.3 contract). Iterates
  `entityModule.store.listSummaries(allLayerIds, ...)` per kind,
  encodes anything missing in LanceDB. Rate-limited (default 50
  entities/min, configurable); idempotent by entity `id`.
- Config: `embeddings: { endpoint?: string; model?: string;
apiKey?: string }`. Absent → `MockEmbedder`.

This is the **only LanceDB write path** in phase 6. **Reads** stay
on `searchSummaries`. ADR 0021 records the deliberate read/write
asymmetry.

### 4.4 Streaming wrapper (lands in 6.4)

- Extend `apps/server/src/llm/types.ts` with
  `chatStream(req: ChatRequest): AsyncIterable<ChatChunk>` (added
  as an optional method on `LlmClient`).
- `MockLlmClient.chatStream` yields fixed chunks for tests.
- `OpenAiCompatibleClient.chatStream` consumes `text/event-stream`
  per the OpenAI spec.
- `withTelemetry()` handles the streaming variant: collects all
  chunks, writes **one** `llm_calls` row when the stream finishes
  (success or error). Same logging contract as phase 1.
- HTTP route `POST /l/:slug/chat/conversations/:id/messages` runs
  router + resolver + retrieval synchronously (logging steps),
  then writes SSE events: `step` (one per pipeline-step
  transition), `token` (answerer chunks), `done` (final message
  id + tokens), `error` (with error code). The web client handles
  all four.
- This is the **only SSE consumer** in the project. ADR 0022
  records the SSE-vs-WebSocket choice and the framing contract.

### 4.5 Frontend (lands in 6.5 + 6.6)

- `/l/:slug/chat` — three-pane page: conversation list (left),
  thread (center, auto-scrolling), composer (bottom). Native
  `EventSource` for the SSE stream; assistant bubble's
  `aria-live="polite"` so screen readers announce updates, but
  buffered at sentence boundaries (avoid per-chunk verbosity).
  Feedback buttons under each assistant bubble — real `<button>`
  with `aria-pressed`.
- `/l/:slug/chat/board` — Kanban with columns `queued | intent |
entities | retrieval | answering | done | failed`. Cards = last
  N hours of messages; click jumps back to the conversation
  thread. Reuses the `TodosKanbanView` shape
  (`apps/web/src/pages/TodosPage.tsx:374–437`): same grid +
  `<section>` per column, no drag-and-drop, status text from i18n.
- `RecentChatsWidget` registered via `registerWidget()`
  (`apps/web/src/dashboard/widget-registry.ts`), imported in
  `apps/web/src/dashboard/widgets.ts`. Shows latest 5
  conversations + thumbs ratio for the current layer.
- Phase-1 `/chat` page label changes to "System chat
  (diagnostic)" with a banner pointing at the per-layer chat. The
  underlying single-turn route is unchanged — it's kept for
  ops to sanity-check LLM config outside any layer.

---

## 5. Affected modules

- **New**: `apps/server/src/chat/` (pipeline, embeddings, repos),
  `apps/server/src/http/routes/layer-chat.ts`,
  `apps/web/src/pages/LayerChatPage.tsx`,
  `apps/web/src/pages/LayerChatBoardPage.tsx`,
  `apps/web/src/dashboard/RecentChatsWidget.tsx`,
  `packages/shared/src/schemas/chat.ts`.
- **Migrated / extended**:
  `apps/server/src/storage/migrations/0014_chat.sql` (new),
  `apps/server/src/llm/client.ts` + `telemetry.ts` (streaming
  variant), `apps/server/src/llm/types.ts` (`chatStream` +
  `ChatChunk`), `apps/web/src/App.tsx` (two new routes),
  `apps/web/src/i18n/locales/{en,nl}.json` (new keys),
  `apps/web/src/dashboard/widgets.ts` (barrel import),
  `apps/web/src/lib/api.ts` (new functions),
  `apps/web/src/pages/ChatPage.tsx` (label / description tweak
  only).
- **Reused unchanged**: `LayerResolver`
  (`apps/server/src/layers/resolver.ts`), `withEffectiveLayers` /
  `requireLayer` middleware, `EntityStore.searchSummaries`, the
  durable bus, the scheduled-task registry, the `llm_calls`
  telemetry table, shadcn primitives in
  `apps/web/src/components/ui/`, the `TodosKanbanView` shape.
- **Docs**: `docs/dev/architecture/chat-pipeline.md` (new),
  `docs/dev/architecture/retrieval.md` (new),
  `docs/dev/architecture/job-inventory.md` (three new rows),
  `docs/dev/architecture/overview.md` (chat module added),
  `docs/dev/decisions/0020-chat-pipeline.md`,
  `docs/dev/decisions/0021-embedding-and-lance-auth-tag.md`,
  `docs/dev/decisions/0022-sse-for-answerer.md`,
  `docs/user/guides/working-with-chat.md` (new),
  `docs/dev/plans/overall.md` §8 phase-6 status block (added at
  close-out), `docs/dev/tasklist.md` (eight rows total for phase 6).

---

## 6. Tests

- **Unit**: repos (CRUD + soft-delete propagation), zod schemas
  (round-trip), `MockEmbedder` determinism, the embedding
  subscriber (entity write → vector row; soft-delete → vector
  row gone), `chat.embeddings.backfill` idempotency, intent step
  zod validation (parse failure → retry once → `error_code =
'invalid_step_output'`).
- **Integration (the headline test)**: against the mock LLM, post
  a question. Assert one `chat_pipeline_runs` row, four
  `chat_pipeline_steps` rows, three `llm_calls` rows (one each for
  router / resolver / answerer; retrieval has none), one assistant
  `chat_messages` row with `tokens_in` / `tokens_out` set.
- **Auth boundary (critical, per `overall.md` §5 invariant 8)**:
  user A in layer X asks a question that would match an entity in
  layer Y. Assert the retrieval step's `output_json` does **not**
  contain the layer-Y row, and the answerer's prompt never
  mentions it. Add a parallel test that user-A reads a LanceDB
  table directly: rows tagged `layer_id = Y` exist but a
  hypothetical query filtered by user-A's effective layers
  returns none. (Phase 6 doesn't actually read from LanceDB, but
  the test pins the ADR 0021 contract for phase 7.)
- **Streaming**: SSE route emits the expected `step` / `token` /
  `done` sequence. Client abort mid-stream marks the message
  `failed`, persists the partial assistant content, writes one
  `llm_calls` row with the partial response.
- **Feedback**: thumbs up/down upsert against the UNIQUE
  `message_id` constraint; second post overwrites; `reason` only
  accepted on `down`.
- **i18n**: existing `tests/docs/i18n.test.ts` catches missing
  Dutch keys.
- **Job inventory**: existing `tests/docs/job-inventory.test.ts`
  catches missing entries for `chat.embeddings.backfill`,
  `chat.review-layer`, `chat.runs.prune`.
- **Smoke** (extends `apps/server/tests/smoke.test.ts` and
  `apps/server/tests/smoke-worker.test.ts`): create a calendar
  event titled "Acme strategy", ask "when do I meet Acme?", assert
  the streamed answer contains the event's date string, thumbs-up,
  assert the feedback row, assert the `entity_calendar_event`
  LanceDB row exists with the right `layer_id`, soft-delete the
  event, assert the LanceDB row is gone.

---

## 7. Docs impact

- New: `docs/dev/architecture/chat-pipeline.md` (orchestrator
  contract, step persistence, SSE framing, retry policy);
  `docs/dev/architecture/retrieval.md` (LIKE-now + LanceDB-later
  read swap; auth_tag invariant; soft-delete contract);
  `docs/user/guides/working-with-chat.md` (open a conversation,
  thumbs up/down, what the board shows).
- Updated: `docs/dev/architecture/overview.md` (chat module in the
  module map), `docs/dev/architecture/job-inventory.md` (three new
  rows), `docs/dev/plans/overall.md` §8 phase-6 row marked done at
  close-out (mirror the phase-5 block).
- Three ADRs accepted (status `proposed` in 6.0, flipped to
  `accepted` in 6.7): 0020 chat pipeline contract; 0021 embedding
  pipeline + LanceDB auth_tag (write-only in phase 6); 0022 SSE
  for the answerer step.

---

## 8. i18n impact

New namespace under `chat.*`:

- `chat.conversation.{newCta,emptyTitle,emptyDescription,deleteCta,deleteConfirm}`
- `chat.message.{userYou,assistant,statusQueued,statusRunning,statusDone,statusFailed}`
- `chat.feedback.{upLabel,downLabel,upAria,downAria,reasonLabel,reasonPlaceholder,submit,saved}`
- `chat.pipeline.steps.{intent,entities,retrieval,answer}.{queued,running,succeeded,failed,skipped}`
- `chat.board.{title,description,cardEmpty,jumpToMessage}`
- `chat.empty.{noConversations,startWith}`
- `chat.composer.{placeholder,sendCta,enterToSend,shiftEnterNewline}`
- `chat.errors.{network,upstream,validation,layerNotVisible,streamAborted,intentInvalid}`
- `layer.dashboard.widgets.recentChats.{title,emptyDescription,loading,errorLoadFailed,linkOpen}`
- `nav.chat` (already present for phase 1; the existing key is
  reused — phase-1 page label updates the **page title** only,
  not the nav entry).

Pipeline-step status text in the Kanban must come from i18n; never
hardcoded. en.json is primary; nl.json must be 1:1 — CI catches
drift.

---

## 9. Accessibility impact

- Streaming assistant bubble: `aria-live="polite"` on the message
  container; buffer at sentence boundaries before announcing so
  screen readers don't read every chunk.
- Feedback buttons: real `<button>` elements, `aria-pressed`
  reflecting current feedback; `aria-label` from i18n (no
  emoji-only accessible names); keyboard reachable.
- Conversation list: list-of-`<Link>` pattern (matches todos
  list); focus ring via the project-standard
  `focus-visible:ring-2 focus-visible:ring-ring` utilities.
- Kanban board: each column is a `<section>` with an `<h2>` heading
  carrying the localized title + count; cards are focusable; the
  empty-column state has a localized message.
- Composer textarea: Enter submits, Shift+Enter newlines (matches
  the phase-1 chat behaviour); the i18n placeholder documents this.
- Dialog confirmations (delete conversation, thumbs-down reason)
  use the existing native `<dialog>` wrapper with focus trap.

---

## 10. Security impact

- Retrieval **must** filter by `c.var.effectiveLayers` before
  calling `searchSummaries`. The auth-boundary test (above)
  pins this contract — a regression here would violate
  `overall.md` §5 invariant 8.
- LanceDB upsert subscriber stores `layer_id` as the auth*tag;
  soft-delete and hard-delete remove the row. The phase-7
  read path filters on `layer_id IN (?)` \_before* the vector
  query. ADR 0021 records this.
- Embedder endpoint is OpenAI-compatible config — same secret
  rules as the chat LLM (env var or config file, never logged).
- Conversations are scoped to `(layer_id, user_id)`. v1 is
  personal-by-default; a "shared conversation" toggle is a
  phase-7+ follow-up candidate, **not** in phase 6.
- SSE route uses the same session cookie as the rest of the app;
  `requireUser` + `requireLayer` middleware unchanged. The SSE
  endpoint never accepts a model override from the client (the
  per-layer chat model is system-default until a phase-7 follow-up
  adds layer-level override).
- The answerer's system prompt explicitly instructs the LLM to
  answer **only** from the supplied retrieval JSON and to say "I
  don't know" if the JSON is empty. Reduces the surface for
  hallucinated entity data being shown to the user.

---

## 11. Risks

| Risk                                                          | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                 |
| ------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| LIKE retrieval misses obvious matches ("ami" vs `www.ami.nl`) | Med        | Med    | `searchable_text` mixes title + key fields at write time; per-`(kind, term)` `limit=5` keeps noise low; phase 7 swaps in LanceDB reads (rows already present, no backfill).                                                                |
| LLM step returns invalid JSON                                 | Med        | Med    | zod-validate every step output; on parse failure retry once; on second failure step is `failed` with `error_code='invalid_step_output'` and the message falls through to a graceful "I couldn't process that" answer rather than crashing. |
| Streaming connection leaks                                    | Low        | Med    | Hard 60-second timeout on the answerer call; SSE handler tied to the request lifecycle; explicit `finally` closes the writer; integration test covers client-abort.                                                                        |
| LanceDB write subscriber slows entity writes                  | Med        | Low    | Subscriber runs **async off the bus**, not in the entity write transaction. A delayed embedding is acceptable; a stalled CRUD write is not.                                                                                                |
| Embedding cost explosion on backfill                          | Low        | Med    | Backfill is rate-limited (default 50 entities/min, configurable) and only encodes missing rows.                                                                                                                                            |
| Phase-1 `/chat` page confuses users away from per-layer chat  | Med        | Low    | Page label becomes "System chat (diagnostic)"; banner links to per-layer chat. Nav entry left in place because it's still the only way to test the system-default LLM config outside a layer.                                              |
| Soft-delete leak via stale LanceDB rows                       | Med        | High   | Subscriber listens to `entity.deleted` **and** `entity.softDeleted`; integration test asserts the LanceDB row is gone post-soft-delete. ADR 0021 records this as a contract, not an implementation detail.                                 |
| Per-message LLM cost grows quickly (3 calls per question)     | Med        | Med    | All three calls are logged with token counts in `llm_calls`; per-layer LLM budgeting is a phase-7 follow-up (telemetry is already there). System prompts kept short; resolver output capped via zod.                                       |

---

## 12. Open questions (answered before sub-phase 6.3 starts; do not block 6.0–6.2)

1. **History window**: cap at last 20 turns (10 user + 10 assistant)
   per conversation, or until a token budget? Default to **20
   turns** unless we hit budget complaints; reconfigurable per
   layer as a phase-7 follow-up.
2. **Conversation title**: first 60 chars of the user's first
   message in v1; a `chat.summarize-conversation` scheduled-task
   kind is **reserved** for phase 7 to add an LLM-summary job.
3. **Per-layer chat model override**: should each layer pick its
   own model for chat, or stay system-default? Phase 6 keeps
   **system-default** to limit the config surface; per-layer
   override is a phase-7 follow-up candidate.

These three are the only loose ends, and they don't block landing
6.0 / 6.1 / 6.2.

---

## 13. Verification

End-to-end manual smoke (matches the `AGENTS.md` "Done Means Done"
checklist; runs at 6.7 close-out):

1. `bun install && bun run dev` → log in as admin, switch to a
   layer that has a calendar event titled "Acme strategy".
2. Open `/l/<slug>/chat`. Ask "When is my Acme strategy meeting?".
3. Watch the assistant bubble stream a real answer containing the
   event date.
4. Thumbs-down → write a short reason → submit → reload, feedback
   persists.
5. Open `/l/<slug>/chat/board`. The message card sits in `done`.
6. `/admin/llm/logs` shows three rows for that message
   (router/resolver/answerer); retrieval makes zero.
7. SQLite: one row in `chat_conversations`, two in `chat_messages`
   (user + assistant), one in `chat_pipeline_runs`, four in
   `chat_pipeline_steps`, one in `chat_message_feedback`.
8. LanceDB inspection: `entity_calendar_event` contains the row
   for the Acme event with `layer_id` matching.
9. Soft-delete the calendar event in the UI → the LanceDB row
   disappears (the subscriber handled `entity.softDeleted`).
10. CI (matches `AGENTS.md §Pull Requests`):
    `bun run format:check && bun run lint && bun run typecheck
&& bun test && bun run build && bun run docs:check && bun run
i18n:check` all green.
11. Smoke (`bun test apps/server/tests/smoke.test.ts`) and
    `smoke-worker` both green.

---

## 14. Close-out checklist (from `AGENTS.md`)

When phase 6 closes:

- All 8 tasklist rows for phase 6 are `done`.
- This plan moves from `docs/dev/plans/phase-06-super-chat.md` →
  `docs/dev/plans/done/phase-06-super-chat.md`; tasklist
  `Related document` paths updated.
- `docs/dev/plans/overall.md` §8 phase-6 status block written
  (mirror the §8 phase-5 block).
- Three new ADRs accepted (0020 / 0021 / 0022).
- `docs/dev/architecture/job-inventory.md` lists the three new
  `chat.*` job kinds; `tests/docs/job-inventory.test.ts` green.
- No new entries in `docs/dev/risks/` beyond what `§11` already
  identifies (or new files if any `§11` rows promote to first-class
  risks).
- Open follow-ups recorded as `docs/dev/follow-ups/*.md`:
  per-layer LLM model override; conversation auto-summary;
  LanceDB read swap; shared / team conversations; tool-calling
  answerer; per-layer embedding budget.
