# Follow-up — Per-layer embedding budget

- Status: open
- Created: 2026-05-24 (phase 6 close-out, plan §11 risk row)
- Phases referencing it: 6.2 (write path), 7

## What remains

Phase 6 sets a system-wide rate limit on `chat.embeddings.backfill`
(default 50 entities/min, configurable). The write subscriber
itself has no per-layer budget — every entity write triggers one
embedding call.

When a real embedding model (OpenAI's `text-embedding-3-small` or
local equivalent) replaces the `MockEmbedder` in phase 7, the
token cost becomes visible. The follow-up is: per-layer budgets
that cap embedding calls so a runaway connector cannot exhaust a
shared quota.

## Why not done now

The `MockEmbedder` default in phase 6 costs nothing; the budget
is a phase-7 concern that doesn't bind until the real embedder is
configured. The plan's §11 risk row records the deferral.

## Next step

1. Add per-layer counters in `layer_chat_settings` (or a new
   `layer_embedding_budget` table) for daily / monthly caps.
2. Update the subscriber to consult the budget before encoding;
   on cap-hit, enqueue the row for the next-day backfill instead
   of dropping.
3. Surface budget usage in the layer settings UI.
4. Telemetry: `embedding.tokens.spent` per layer per day.

## Related files / docs

- `apps/server/src/chat/embeddings/subscriber.ts` — the natural
  enforcement point.
- `apps/server/src/chat/embeddings/backfill-handler.ts` — already
  has rate-limit plumbing; budget would extend it.
- `docs/dev/plans/done/phase-06-super-chat.md` §11 — risk row.
