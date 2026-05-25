# Follow-up — Per-layer chat LLM model override

- Status: open
- Created: 2026-05-24 (phase 6 close-out, ADR 0020 / 0022 §Non-decisions)
- Phases referencing it: 6.4 (SSE route accepts no client `model`), 6.7

## What remains

Phase 6 uses the system-default LLM model for every chat call
(router, resolver, answerer) on every layer. The plan and ADR
0020 §"Non-decisions" both record that **per-layer model
override** was deliberately deferred to keep the config surface
small in v1.

The follow-up is: let a layer pick its own chat model — e.g.
"this project layer answers with `gpt-4o-mini`, that group layer
uses the local llama". Should respect the same secret-handling
rules as the system default (env or layer-attachment, never
logged).

## Why not done now

Three concerns added complexity without a paying customer in
phase 6:

1. **Config surface.** Per-layer model means a per-layer
   `LlmConfig` shape, which makes settings and admin views more
   complicated. Wait until at least one user asks.
2. **Telemetry.** `llm_calls` rows already log the model; a new
   per-layer dimension would split aggregates and need a UI
   change.
3. **Cost control.** Per-layer model picks invite per-layer
   budget enforcement, which is a separate follow-up
   (`chat-per-layer-embedding-budget.md`).

## Next step

1. Decide whether per-layer model lives in `layer_attachments`
   (`kind = 'chat-model'`) or in a new
   `layer_chat_settings` table.
2. Update the chat pipeline deps so each step resolves model via
   `chatModelForLayer(layerId)` before calling `llmClient.chat`.
3. Add an admin-only UI under `/l/:slug/settings` to pick the
   model from the configured providers.
4. Add a telemetry dimension `model_source = system | layer` on
   `llm_calls`.

## Related files / docs

- `apps/server/src/chat/pipeline/orchestrator.ts` — three call
  sites would need the new resolver.
- `apps/server/src/llm/client.ts` — already accepts a per-call
  `model`; no change.
- `docs/dev/decisions/0020-chat-pipeline.md` §"Non-decisions" —
  records the deferral.
