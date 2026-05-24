# ADR 0020 — Chat pipeline contract

- Status: proposed
- Date: 2026-05-24
- Phase: 6 (sub-phases 6.0 through 6.7; flips to `accepted` in 6.7)
- Related: `docs/dev/plans/phase-06-super-chat.md` §1, §4.1, §6, §11;
  `docs/dev/architecture/chat-pipeline.md` (lands in 6.7);
  ADR [`0019`](./0019-durable-sqlite-message-bus.md) (durable bus
  semantics phase 6 deliberately stays out of);
  ADR [`0021`](./0021-embedding-and-lance-auth-tag.md) (the
  retrieval auth contract this pipeline depends on);
  ADR [`0022`](./0022-sse-for-answerer.md) (how the streamed
  answerer step is transported);
  Source code (lands in 6.3 / 6.4):
  `apps/server/src/chat/pipeline/`,
  `apps/server/src/storage/migrations/0014_chat.sql`,
  `packages/shared/src/schemas/chat.ts`.

---

## Context

Phase 1 shipped a single-turn `POST /chat` that ignores entities
and runs outside any layer (`apps/server/src/http/routes/chat.ts`).
Phase 6 turns chat into the headline feature: a layer-scoped
multi-turn assistant that answers questions from real entity data
the caller is allowed to see.

The `overall.md` §6 paragraph on chat already fixes the shape:
**intent router → entity resolver → retrieval → answerer**, with
user thumbs feedback and a Kanban visualization of the agent's
working state. The originalplan.md "wanneer heb ik de ontmoeting
met 2ba" canonical example pins the same flow.

Before any code lands, four decisions need to be recorded so the
sub-phases (6.1–6.7) cannot drift:

1. **Hard-coded pipeline vs LLM tool/function-calling.** The user
   explicitly chose hard-coded (see plan §Approach decision).
2. **Where the auth boundary lives.** It has to live somewhere
   inside the pipeline, and the choice has knock-on effects on
   the answerer's prompt shape.
3. **Pipeline persistence + bus eventing.** Phase 5 left a generic
   scheduler and a durable bus available. Should pipeline runs go
   through that machinery, or stay synchronous within the request?
4. **Retry policy.** Synchronous vs asynchronous; how many
   attempts; what counts as "transient".

---

## Decisions

### 1. Hard-coded four-step pipeline; no LLM tool-calling in phase 6

Pipeline steps in order, each its own function call from the
orchestrator:

- **Intent** (LLM call) — classify into a small enum
  (`question.entity_lookup`, `question.summary`, `command.create`,
  `command.update`, `smalltalk`, `unsupported`). zod-validated.
- **Entities** (LLM call) — given user text + intent +
  registered entity kinds, output
  `{ kinds: EntityKind[], queryHints: { term, kind?, timeWindow? }[] }`.
  zod-validated.
- **Retrieval** (code, **no LLM**) — for each `(kind, term)` call
  `entityModule.store.searchSummaries(ctx.effectiveLayerIds, term,
{ limit: 5 })`, aggregate, dedupe, cap at 20 hits.
- **Answer** (LLM call, **SSE-streamed**) — system prompt +
  capped history + retrieval JSON + user message.

Rejected: **LLM tool/function-calling.** The current
`apps/server/src/llm/client.ts` has no tool-calling surface, so
adopting it would expand the LLM client API in the same phase that
introduces the pipeline. The hard-coded shape is also easier to
visualize on the Kanban (one card moves through known columns) and
easier to audit per step from `chat_pipeline_steps`. Phase 7's
self-learning loop is the natural place to revisit this, once the
loop has telemetry on which questions the hard-coded pipeline
fails.

`command.*` intents are recognised but **not handled** in phase 6
— the answerer returns a polite "not yet supported in phase 6"
message. Recognition is still useful because phase 7 will mine the
recognised-but-unhandled gap.

### 2. The auth boundary lives in the **retrieval** step

Retrieval is the **only** step that touches entity data. It must
call `searchSummaries(ctx.effectiveLayerIds, term)` — never any
other store method that skips the layer filter. The answerer
prompt is built **only** from retrieval's `output_json`; the
orchestrator never hands the answerer raw entity rows from
anywhere else.

This makes the auth-boundary test very specific (plan §6, "Auth
boundary"): post a question that would match an entity in a layer
the user cannot see, assert retrieval's `output_json` does not
contain that row, and assert the answerer's prompt does not
mention it. A regression here violates `overall.md` §5 invariant 8
("authorization-aware retrieval"), so the test pins it tightly.

A consequence: retrieval is **synchronous and in-process**. We do
not pass retrieval off to a worker because the auth context
(`c.var.effectiveLayers`, the session) is request-bound. Phase 7's
LanceDB read swap (ADR 0021) keeps retrieval in-process for the
same reason.

### 3. Per-step persistence; bus events for observability **only**

Each step writes a `chat_pipeline_steps` row at start and at end
(`started_at`, `ended_at`, `status`, `input_json`, `output_json`,
`error_code`, `llm_call_id`). The whole message gets a
`chat_pipeline_runs` row.

Bus events emitted on transitions:

- `chat.message.received`, `chat.message.answered`,
  `chat.message.failed` — one each per message.
- `chat.step.started`, `chat.step.succeeded`, `chat.step.failed`
  — one each per step transition.

These events are **for observability** (Kanban subscribes, dashboard
"Recent runs" mirrors). They are **not** the runtime of the
pipeline — handlers do not consume `chat.step.started` to _do_ the
step. That keeps the pipeline easy to reason about: it's a normal
synchronous function with side-effect writes, not an actor system.

Pipeline runs **do not** go through the durable bus's outbox
(ADR 0019). The outbox is for cross-process, crash-safe delivery
of long-running work (the enrichment runner, the scheduler). The
chat pipeline is **request-scoped**: when the HTTP request ends,
the run ends. If the server dies mid-pipeline, the message moves
to `failed` on the next read (a sweeper handler — phase 6.3 — flips
any `running` row older than its lease to `failed`).

### 4. Retries: synchronous, two attempts, exponential 250 ms / 1 s

Transient LLM failures retry inline. On the second failure the
step is `failed` with `error_code` set; the message moves to
`failed` and surfaces on the Kanban. zod parse failures count as
the same "transient" — retry once with a stricter system prompt
hint, then fail.

Rejected: **enqueue retries on the durable bus.** Same reason as
§3: chat is request-scoped. A retry the user is no longer waiting
for is wasted LLM cost. Phase 7's review-job is the right place
to revisit failures that look retryable in hindsight.

`max_attempts`, `backoff_base_ms`, `backoff_max_ms` are
configuration on the chat module (defaults `2 / 250 / 1000`), not
per-message overrides. A single config dial keeps phase-6
telemetry comparable.

---

## Consequences

- A new chat module (`apps/server/src/chat/`) owns the pipeline,
  the embedding scaffold (ADR 0021), and the SSE route (ADR 0022).
  It has no entry in the scheduled-task registry except for three
  background jobs (`chat.embeddings.backfill`, `chat.review-layer`
  placeholder, `chat.runs.prune`).
- The `llm_calls` telemetry table from phase 1 captures all three
  LLM calls per processed message. No new telemetry tables —
  phase 5's `architecture/job-inventory.md` and the existing
  `events` log give cross-references.
- The `chat_pipeline_steps` table is the **diagnostic record**.
  Phase 7's review-job reads from it directly. Phase 8's threshold
  automation uses its aggregate (success/failure rate per intent)
  as one input.
- A failed pipeline still leaves a usable trail: the message row
  is `failed`, partial step rows are `failed`/`skipped`, the bus
  emitted `chat.message.failed`. The Kanban surfaces this; the
  user sees a localized error in place of the assistant bubble.
- Because pipeline runs are not on the durable bus, a server crash
  mid-pipeline orphans one message. The on-boot sweeper
  (`chat.runs.prune` from 6.6, sweep variant from 6.3) flips
  `running` rows older than the configured lease (default 5 min)
  to `failed`. No data is lost; the user re-asks.

---

## Non-decisions (intentional)

- **No streaming for non-answerer steps.** Router / resolver /
  retrieval are tens to hundreds of milliseconds, well under the
  threshold where streaming changes feel. Their transitions show
  up on the Kanban so the user has a "something is happening"
  signal during the answerer wait. ADR 0022 records the SSE
  framing for the answerer specifically.
- **No per-layer system-prompt override.** Phase 6 has one system
  prompt for the router, one for the resolver, one for the
  answerer, all in code under
  `apps/server/src/chat/pipeline/prompts.ts`. Per-layer prompt
  customization is a phase-7 follow-up.
- **No streaming abort hook from the client.** The SSE route ties
  the answerer call to the request lifecycle; the client closing
  the EventSource ends the request, which ends the LLM call.
  A "stop generating" button is a phase-7 follow-up — it requires
  a separate `POST .../abort` endpoint that is more wiring than
  it's worth in phase 6.
- **No multi-LLM voting / consensus.** One LLM per step.
- **No caching of router / resolver outputs.** Repeated identical
  questions repeat all three LLM calls. The intent / entity
  decisions are cheap relative to the answerer; caching them adds
  invalidation complexity that buys very little in v1.
