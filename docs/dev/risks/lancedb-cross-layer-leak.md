# Risk — LanceDB leaks content across layers

- Status: mitigated, monitored
- Owner / area: chat retrieval (`apps/server/src/chat/embeddings/`,
  `apps/server/src/entities/store.ts`)
- Related: `docs/dev/plans/overall.md` §5 invariant 8,
  `docs/dev/plans/overall.md` §9 (risk row 1);
  ADR [`0021`](../decisions/0021-embedding-and-lance-auth-tag.md);
  Phase 7.1 in
  [`done/phase-07-self-learning.md`](../plans/done/phase-07-self-learning.md);
  `docs/dev/architecture/retrieval.md`.

---

## Description

LanceDB is the vector store for chat retrieval. Every entity write
upserts one row tagged with the entity's `layer_id`. A user who
should only see layers A and B must never receive a neighbour from
layer C — even via the answerer's prompt. Two classes of bug can
break this:

1. **Read-path forgets the auth filter.** A future refactor of
   `searchSummaries` (chat → retrieval step) drops the
   `layer_id IN (<effectiveLayerIds>)` pre-filter, and an
   ANN search returns rows from layers the caller cannot see.
2. **Write-path forgets to maintain the row.** A soft-delete or
   restore subscriber drifts from the primary store, so a vector
   row outlives the entity and surfaces in a future query as if
   the content were still visible.

Either turns retrieval into a covert channel that bypasses
`LayerResolver` (ADR 0010) — the system's only authoritative
"who-can-see-what" component.

## Impact

High. Cross-layer leak = silent data disclosure. Personal-layer
notes, group-layer drafts, or another customer's content can land
in another caller's answerer prompt. The answerer cites it; the
user sees it. No HTTP 401 / 403 fires; nothing alerts.

## Likelihood

Medium. The write path is contract-tested
(`entity.softDeleted` → row gone; ADR 0021 §2). The read path
runs through `searchSummaries` whose tests assert pre-filtering
behaviour. The risk lives in refactors and new entity kinds: a
new kind that writes to LanceDB but forgets the soft-delete
subscriber, or a new retrieval call-site that bypasses
`searchSummaries`.

## Mitigation

1. **Single auth column.** ADR 0021 fixes `layer_id` as the only
   auth tag on every LanceDB row. No per-user column, no per-tenant
   column to drift against the primary store.
2. **Pre-filter, not post-filter.** The query in
   `apps/server/src/chat/embeddings/vector-search.ts` passes
   `layer_id IN (<effectiveLayerIds>)` to LanceDB's predicate before
   the vector neighbours are computed. Post-filtering on the
   caller side is forbidden — a `topK` could exhaust to zero on
   filtered-out rows.
3. **Phase 7.1 auth-boundary regression test.** A test in
   `apps/server/tests/retrieval-auth-boundary.test.ts` plants two
   near-identical rows in two distinct layers, with the
   cross-layer row deliberately closer in vector space, queries
   from a user who only sees one layer, and asserts the
   cross-layer row never appears. The pure-JS test writer enforces
   the same pre-filter order LanceDB uses so the assertion is
   meaningful offline.
4. **Soft-delete contract test.** A 6.2 contract test (now
   long-lived) asserts that `entity.softDeleted` → vector row
   gone. Phase 8 audit ALTERs added more event kinds; the
   contract still holds.
5. **No fallback widens the boundary.** When the corpus is empty
   or the embedder is offline, retrieval falls back to LIKE on
   `searchable_text` — and the LIKE path goes through the same
   `EntityStore.searchSummaries(layerIds, term)` signature, which
   only ever queries the primary store rows whose `layer_id` is
   in the provided set. The fallback cannot leak by design.
6. **Single-tenant assumption (overall §3).** A future federation
   needs a `tenant_id` tag here as well (ADR 0021 §Non-decisions).
   Recorded; not deferred indefinitely — the risk becomes higher
   once multi-tenant lands.

## What would invalidate the mitigation

- A retrieval caller that imports LanceDB directly instead of
  going through `vector-search.ts`. Code review should flag any
  `lancedb.connect(...)` outside `apps/server/src/chat/embeddings/`.
- A new entity kind whose write path skips the embedding
  subscriber. ADR 0021's contract test catches missing
  `entity.softDeleted` handling; missing `entity.created` is
  caught by `chat.embeddings.backfill` (rows surface late, not
  in the wrong layer).
- A per-user vector column added later without revisiting the
  pre-filter shape.
