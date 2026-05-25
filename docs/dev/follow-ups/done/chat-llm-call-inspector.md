# Follow-up — Per-message LLM call inspector

- Status: done
- Created: 2026-05-25
- Phases referencing it: 6.4 (route surface), 6.5 (chat UI), 6.7

## Problem

The phase-6 chat UI surfaces failed answers as `"I couldn't process
that. Try again in a moment, or rephrase your question."` (i18n key
`chat.errors.upstream`). The user could not see WHY a turn failed
without opening SQLite — the intent step might have classified the
prompt as `unsupported`, the answer step might have been aborted by
an upstream cancellation, or the LLM endpoint might have returned a
4xx. Each path leaves different rows in `chat_pipeline_steps` and
`llm_calls`, and the renderer had no surface to expose them.

## Resolution

### Server

- Added `LlmCallLog.getById(id)` so the route can resolve the joined
  `llm_calls` row for any step (`apps/server/src/llm/call-log.ts`).
- Added `GET /l/:slug/chat/conversations/:convId/messages/:msgId/trace`
  in `apps/server/src/http/routes/layer-chat.ts`. The route
  assembles every `chat_pipeline_run` for the message, then every
  `chat_pipeline_step` per run, then joins each step's `llm_call_id`
  back to the `llm_calls` row. Owner-only — gated by the same
  `isOwnedAndVisible` predicate that closes the rest of
  `/l/:slug/chat/*`.
- Shared zod schema `ChatMessageTrace*` in
  `packages/shared/src/chat.ts` describes the wire shape; the route
  hand-shapes the response to match it.

### Web

- `getLayerChatMessageTrace(layerSlug, convId, msgId)` in
  `apps/web/src/lib/api.ts` — lazy-fetched on `<details>` open
  because request/response strings carry full prompts + retrieved
  context and are too big to ship on every message-list refresh.
- Under each assistant message bubble, a collapsed `<details>` panel
  ("Internal calls" / "Interne calls") expands into the run + step
  list. Each step is itself a `<details>` with kind / status /
  attempt / error code on the summary line and the LLM
  request/response (pretty-printed) plus step input/output JSON
  inside.
- Analytics: `chat_message_trace_inspected` fires on first open per
  bubble.

### Tests

- `apps/server/tests/chat-routes/trace.test.ts` — owner happy path,
  cross-user 404, unknown-message-id 404, unauthenticated 401.

### i18n

- `chat.trace.*` keys added to `en.json` + `nl.json`.

## Out of scope

- Server-side truncation / pagination of large payloads. Each request
  is fetched in full on first open; this is a developer-debug
  surface for a single message, not a list view. Revisit if a single
  turn exceeds ~1 MB of request body.
- Sharing or linking to a specific trace. The route is owner-scoped;
  cross-user sharing would need a separate signed-link mechanism.
