# Plan — per-layer chat settings

> Combines two open follow-ups:
> `docs/dev/follow-ups/chat-per-layer-llm-model.md` +
> `docs/dev/follow-ups/chat-per-layer-embedding-budget.md`.

## Goal

Let a layer pin its own chat LLM model (router / resolver /
answerer) AND cap how many embedding tokens its connectors are
allowed to spend per day / per 30 days. Absent settings keep the
phase-6 behaviour byte-for-byte.

## Scope

- New SQLite table `layer_chat_settings` (1:1 with `layers(id)`).
- New SQLite table `layer_embedding_spend` (daily token counters).
- New `llm_calls.model_source` column.
- `chatModelForLayer` resolver + orchestrator wiring.
- Embedding-subscriber gate + spend writer.
- `GET/PUT /l/:slug/settings/chat` HTTP routes.
- Chat tab on `LayerSettingsPage` + i18n.

## Non-goals

- Per-step model overrides. The same model is used for every step.
- Per-user budgets. Caps are per-layer.
- A separate token-cost view (the existing `llm_calls` JOIN already
  surfaces it).

## Approach (bullets)

- Migration `0018_layer_chat_settings.sql`: both tables additive,
  `model_source` ALTER + backfill to `'system'`.
- Repo `apps/server/src/chat/repos/layer-chat-settings-repo.ts` —
  thin upsert + find on the PRIMARY KEY.
- Repo `apps/server/src/chat/repos/layer-embedding-spend-repo.ts` —
  `addTokens` (UPSERT-with-increment), `getDayTokens`, `sumLastDays`.
- `apps/server/src/chat/pipeline/model-resolver.ts` exposes
  `createChatModelResolver({ settingsRepo, systemDefault })`.
- The orchestrator threads the resolved `{ model, source }` into
  `PipelineContext.chatModel`; each LLM-backed step forwards `model`
  - stamps `metadata.modelSource`.
- `withTelemetry` promotes `metadata.modelSource` → `llm_calls.model_source`.
- The embedding subscriber gains optional `settingsRepo` + `spendRepo`
  deps; when wired, it consults the cap BEFORE encode (drop + log +
  `deferred` counter on hit), and increments `tokens_spent` after a
  successful encode using a `chars/4` heuristic (the embedder
  interface does not yet report token counts).

## Affected modules

- `apps/server/src/storage/migrations/0018_layer_chat_settings.sql`
- `apps/server/src/llm/call-log.ts`
- `apps/server/src/llm/telemetry.ts`
- `apps/server/src/chat/repos/layer-chat-settings-repo.ts`
- `apps/server/src/chat/repos/layer-embedding-spend-repo.ts`
- `apps/server/src/chat/pipeline/model-resolver.ts`
- `apps/server/src/chat/pipeline/orchestrator.ts`
- `apps/server/src/chat/pipeline/{intent,entities,answer}-step.ts`
- `apps/server/src/chat/embeddings/subscriber.ts`
- `apps/server/src/http/routes/layer-chat-settings.ts`
- `apps/server/src/http/router.ts`, `apps/server/src/index.ts`
- `packages/shared/src/chat.ts`
- `apps/web/src/pages/LayerSettingsPage.tsx`
- `apps/web/src/lib/api.ts`
- `apps/web/src/i18n/locales/{en,nl}.json`

## Phases

- Migration + repos + zod schema.
- Telemetry surface (`model_source` column + `withTelemetry` promotion).
- Resolver + orchestrator wiring + step plumbing.
- Subscriber budget gate + spend writer.
- HTTP route + UI + i18n.
- Tests (repo, pipeline, subscriber, HTTP) + docs.

## Tests

- `apps/server/tests/layer-chat-settings-repo.test.ts` — repo
  round-trip + CHECK violation.
- `apps/server/tests/chat-pipeline/per-layer-model.test.ts` —
  resolver returns layer vs system; `llm_calls.model_source` stamped.
- `apps/server/tests/chat-embeddings-subscriber-budget.test.ts` —
  encode runs without caps; daily-cap hit defers + records no spend.
- `apps/server/tests/http-layer-chat-settings.test.ts` — GET / PUT
  round-trip + authz + validation.

## Observability

- New telemetry dimension `llm_calls.model_source` (`'system'`,
  `'layer'`, or `NULL` for callers that don't stamp it). Documented
  in `docs/dev/observability/telemetry.md` §2.
- New counter `chat.embeddings.deferred` — increments on cap-hit.
- New counter / log line `embedding.tokens.spent` — per-encode token
  delta with `{ layerId, day, tokensSpent }`. Documented in
  `docs/dev/observability/telemetry.md` §3.
- Structured log `chat.embeddings.deferred` with the cap kind
  (`cap_daily` / `cap_monthly`), estimated tokens, and cap values.
- Pipeline log `pipeline.model.resolved` with `{ layerId, source }`
  per message — no model string in counters (bounded cardinality
  rule).

## Risks

- The `chars/4` estimate diverges from real embedder token counts;
  caps therefore approximate. Acceptable for v1; revisit when the
  embedder interface grows a token-count return.
- Increasing the model-override surface means more state-shaped
  settings to migrate to Postgres later (see ADR 0002). The two
  new tables follow the same TEXT-PK / ISO-timestamp conventions.
