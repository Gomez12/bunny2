# Follow-up — Tool-calling answerer

- Status: open
- Created: 2026-05-24 (phase 6 close-out, ADR 0020 §1)
- Phases referencing it: 6.3, 7+

## What remains

Phase 6 ships a **hard-coded** four-step pipeline (router →
resolver → retrieval → answerer; ADR 0020 §1). Each step is a
plain function call; the answerer does not have function / tool
access to anything beyond the retrieval JSON.

The follow-up is: when phase 7's self-learning loop has telemetry
on which questions the hard-coded shape **fails**, revisit the
choice. A tool-calling answerer could:

- Decide its own retrieval shape (calling `searchSummaries(...)`
  as a tool).
- Resolve follow-ups in one turn ("which AMI? the trader or the
  charity?").
- Handle `command.*` intents directly (create todo, schedule
  meeting) without phase-6's polite "not yet supported"
  fallback.

## Why not done now

ADR 0020 §1 rejects tool calling for phase 6 for two reasons:

1. The current `apps/server/src/llm/client.ts` has no tool API;
   adding one in the same phase that introduces the pipeline
   doubles risk.
2. The hard-coded shape is easier to visualize on the Kanban
   (one card moves through known columns) and easier to audit
   from `chat_pipeline_steps`.

Phase 7's review-job is the place to mine the gaps before
committing to the redesign.

## Next step

1. Pick a provider with a stable tool API as the first target
   (OpenAI-compatible tool calls; the local stack will follow).
2. Extend `apps/server/src/llm/types.ts` with optional
   `tools: ToolSpec[]` and `tool_choice` request fields.
3. Land a parallel `tool-calling-answerer-step.ts` behind a
   feature flag; keep the hard-coded answerer as the default.
4. Compare thumbs ratio between the two answerers via the
   review-job.

## Related files / docs

- `docs/dev/decisions/0020-chat-pipeline.md` §1 — records the
  rejection.
- `apps/server/src/chat/pipeline/answer-step.ts` — the natural
  spot for a feature-flag branch.
- `apps/server/src/llm/client.ts` — would grow the tool API.
