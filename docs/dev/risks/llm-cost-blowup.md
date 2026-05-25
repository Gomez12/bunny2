# Risk — Token cost blowup from per-component LLMs

- Status: partially mitigated
- Owner / area: LLM client + telemetry
  (`apps/server/src/llm/`); enrichment + embeddings + chat
  pipeline + review agent (every component that can call out).
- Related: `docs/dev/plans/overall.md` §9 (risk row 3);
  `docs/dev/architecture/llm-and-telemetry.md`;
  ADR [`0013`](../decisions/0013-entity-enrichment.md);
  ADR [`0020`](../decisions/0020-chat-pipeline.md);
  ADR [`0021`](../decisions/0021-embedding-and-lance-auth-tag.md);
  open follow-up
  [`chat-per-layer-embedding-budget.md`](../follow-ups/chat-per-layer-embedding-budget.md).

---

## Description

bunny2 places LLM calls in many components: chat answerer + router
+ resolver + retrieval, entity enrichment, translator, embedding
encoder, and the phase-7 review agent. Each component has its own
cadence and its own provider config. Three failure modes can
blow the bill:

1. **Runaway loop.** An enrichment handler that loops back into
   itself, or a connector ingest that re-publishes the same
   entity in a tight retry loop, multiplies calls by the bus
   fanout (see also `bus-storms.md`).
2. **Wrong model in the default slot.** The system default model
   is set once in `config.json`. A user who points it at a
   premium model (`gpt-4o` rather than a mini variant) immediately
   pays the higher rate everywhere — chat, enrichment,
   review-agent, embedding-cost-checks.
3. **Real embedder, no budget.** Phase 6 ships `MockEmbedder` by
   default. Switching to `OpenAiEmbedder` makes every entity
   write a paid call. The current write subscriber has **no
   per-layer cap**. A connector that imports 50k rows pays for
   50k embedding calls.

## Impact

Medium. No data loss; no security exposure. Direct $ cost on the
operator's LLM bill plus rate-limit cascades that degrade
interactive routes.

## Likelihood

Medium. The default config is deliberately cheap
(`mock://` provider, `MockEmbedder`); the risk binds when the
operator wires a real provider. Phase 7 increases the surface
(review agent runs on a cadence and calls the LLM); phase 8's
auto-activation closes the loop further.

## Mitigation

### Already in place

1. **100% telemetry.** Every LLM call writes one row to
   `llm_calls` with `model`, `tokens_in`, `tokens_out`,
   `cost_usd`, `correlation_id`, `flow_id`, `layer_id`,
   `user_id`. The wrapper writes the row even on error.
   (`apps/server/src/llm/telemetry.ts`,
   `llm-and-telemetry.md` §4.)
2. **Cost estimation honest about gaps.** `estimateCostUsd`
   returns `null` when a model is not in the pricing map; the
   column stores `NULL`, not a fake zero (§6). Operators see
   "I haven't configured pricing for this model" instead of
   "this model is free".
3. **Per-component override.** Chat / enrichment / embedding
   each carry their own `model` field; the cheap default does
   not have to be the expensive premium when the operator wants
   a high-end answerer with a mid-tier enrichment.
4. **Per-layer rate limit on enrichment.**
   `config.enrichment.maxRunsPerLayerPerMinute` caps LLM calls
   per layer per minute and defers excess. (See `bus-storms.md`
   §Mitigation 2.)
5. **System-wide embedding backfill rate limit.**
   `chat.embeddings.backfill` defaults to 50 entities/min
   (configurable). Catches up after an outage without
   immediately exhausting an embedding-API quota.
6. **Telemetry retention prune.** `llm.calls.prune` (default
   180-day retention) bounds the `llm_calls` table so cost
   reports stay queryable; storage cost stays predictable
   (`llm-and-telemetry.md` §7).
7. **Redaction at the write side.** Per-call request/response
   payloads are redacted before they hit `llm_calls`. Even if
   the bill explodes, the diagnostic log doesn't leak the
   prompts.

### Deferred / follow-ups

1. **Per-layer embedding budget.** Open follow-up
   [`chat-per-layer-embedding-budget.md`](../follow-ups/chat-per-layer-embedding-budget.md).
   Adds per-layer daily / monthly caps and a
   `embedding.tokens.spent` metric per layer per day.
   Phase 7+ work, binds once a real embedder is configured.
2. **Per-layer chat token budget.** No layer-scoped chat-call
   budget exists. ADR 0020 §Non-decisions left it open; should
   land alongside the embedding budget.
3. **Per-call cost ceiling middleware.** `llm-and-telemetry.md`
   §10 sketches a middleware between client and telemetry
   wrapper that rejects calls whose estimated cost exceeds a
   per-flow budget. Not implemented.
4. **Auto-rollback on cost spike.** Tied to
   [`proposals-auto-rollback-watcher.md`](../follow-ups/proposals-auto-rollback-watcher.md)
   — a self-learning capability that 10× the per-message
   token count should be a rollback trigger. Out of scope of
   the watcher's initial design (thumbs-ratio only) but worth
   adding once telemetry signals are wired.

## What would invalidate the mitigation

- Switching the system default to a premium model without
  per-component overrides on the cheap call sites.
- Wiring `OpenAiEmbedder` in production before
  `chat-per-layer-embedding-budget.md` lands.
- A new entity kind that triggers enrichment on every write
  without respecting `maxRunsPerLayerPerMinute` (the runner
  enforces this — bypassing it requires a custom subscriber).
- Disabling `llm.calls.prune` (the bill is still visible in
  the provider's dashboard, but bunny2's internal cost
  attribution goes blind past the retention window).
