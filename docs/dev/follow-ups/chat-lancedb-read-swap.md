# Follow-up — Phase-7 LanceDB read swap

- Status: open
- Created: 2026-05-24 (phase 6 close-out, ADR 0021 §4)
- Phases referencing it: 6.2 (write path), 7 (read path)

## What remains

Phase 6 populates a LanceDB corpus on every entity write (one row
per entity, `layer_id` is the auth_tag). Phase 6 does **not**
read from it — retrieval stays on the LIKE path in
`EntityStore.searchSummaries`. Phase 7's first sub-phase swaps
the read path over.

The swap must:

1. Pick a real embedding model (deferred from phase 6; the
   `MockEmbedder` shipped as the default is for tests / CI only).
2. Backfill the corpus with the real embedder via
   `chat.embeddings.backfill` (rows are already there with the
   mock vectors — the backfill re-encodes any row whose vector
   dim no longer matches).
3. Replace the LIKE call inside `searchSummaries` with a vector
   query that filters `layer_id IN (?)` **before** the neighbour
   scan (ADR 0021 §1 — pre-filter, not post-filter).
4. Keep LIKE as a fallback when `lancedb.ready === false` (e.g.
   degraded mode).
5. Hold the `searchSummaries(layerIds, term)` interface stable so
   the chat pipeline's retrieval step doesn't change.

## Why not done now

Phase 6 deliberately ships the headline chat feature without
picking an embedding model — that decision wants real-world chat
load to inform it. The asymmetry between write (phase 6) and
read (phase 7) is recorded in ADR 0021 §4.

## Next step

1. Open phase-7 detail plan; the read swap is the first
   sub-phase.
2. Pick the embedding model + vector dimensionality. Update
   `apps/server/src/chat/embeddings/embedder.ts` accordingly.
3. Add the vector-search code path inside the per-kind
   `EntityStore` implementations.
4. Pin the auth-boundary contract with a regression test that
   asserts the LanceDB read filters by `layer_id` before any
   vector query.

## Related files / docs

- `docs/dev/decisions/0021-embedding-and-lance-auth-tag.md` §4 —
  records the deferral.
- `docs/dev/architecture/retrieval.md` §5 — documents the
  forward contract.
- `apps/server/src/chat/embeddings/lance-tables.ts` — already
  carries the right schema.
