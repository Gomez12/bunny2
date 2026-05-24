# Retrieval

> Status: living document.
> Owners: phase 6 introduced this; phase 7 swaps the read path from
> LIKE to vector search behind the same `searchSummaries` interface.
> Source code: `apps/server/src/entities/entity-store.ts`
> (`searchSummaries`), `apps/server/src/chat/pipeline/retrieval-step.ts`
> (consumer), `apps/server/src/chat/embeddings/` (LanceDB write path),
> `apps/server/src/layers/resolver.ts` (effective-layer set).

This is the single-page tour of how bunny2 finds the entity rows
that ground a chat answer. Companion to
[`chat-pipeline.md`](./chat-pipeline.md),
[`entities.md`](./entities.md),
[`layers-and-auth.md`](./layers-and-auth.md), and ADR
[`0021`](../decisions/0021-embedding-and-lance-auth-tag.md).

---

## 1. What ships in phase 6

A layer-scoped, code-only retrieval step inside the chat pipeline.
For each `(kind, term)` pair the entities step produced, the
retrieval step calls:

```ts
entityStore.searchSummaries(ctx.effectiveLayerIds, term, { limit: 5 });
```

That call goes through the per-kind module's primary store
(SQLite, the `searchable_text` column on each entity table) using
a LIKE filter on the search term and a hard `layer_id IN (?)`
filter on the caller's effective layers.

There is **no LanceDB read in phase 6**. The vector store
receives writes only. Reads stay on LIKE until phase 7's read swap
flips them behind the same interface.

ADR [`0021`](../decisions/0021-embedding-and-lance-auth-tag.md)
records the read/write asymmetry as a deliberate phasing decision.

---

## 2. Authorization contract

`overall.md` §5 invariant 8: "Vector / semantic search must filter
on the caller's effective layer/group access **before** retrieval,
never after." The same rule applies to the LIKE path today.

The flow:

```
HTTP request                                effectiveLayerIds[]
  │                                               │
  │  (cookie)                                     │
  ▼                                               ▼
withEffectiveLayers ──► c.var.effectiveLayers ──► searchSummaries(
  middleware              (LayerResolver)          layerIds, term
                                                  )
                                                   │
                                                   ▼
                                       SELECT … FROM entity_<kind>
                                        WHERE layer_id IN (?)
                                          AND deleted_at IS NULL
                                          AND searchable_text LIKE ?
```

`createRequireLayer` ensures the request's URL slug resolves to a
layer the caller can see; `withEffectiveLayers` populates
`c.var.effectiveLayers` from the `LayerResolver` (ADR
[`0010`](../decisions/0010-layer-resolver-and-invalidation.md));
the retrieval step passes that set to `searchSummaries`. The LIKE
filter is appended **after** the `layer_id IN (?)` filter — SQLite
applies them as `AND`, so a row in a layer the caller cannot see
is never considered.

The orchestrator never hands the answerer raw entity rows from
anywhere else. Retrieval's `output_json` (the deduped hit list,
capped at 20) is the **only** entity data the answerer sees. ADR
[`0020`](../decisions/0020-chat-pipeline.md) §2 records this as
the chat pipeline's auth boundary; the orchestrator integration
test (`apps/server/tests/chat-pipeline/orchestrator.test.ts`)
pins it.

---

## 3. The LIKE path (phase 6 today)

`EntityStore.searchSummaries(layerIds, term, opts)` lives in
`apps/server/src/entities/entity-store.ts`. Each entity kind's
per-table SQL store provides:

```sql
SELECT id, slug, title, snippet
  FROM entity_<kind>
 WHERE layer_id IN (?, ?, …)
   AND deleted_at IS NULL
   AND searchable_text LIKE '%' || ? || '%'
 ORDER BY updated_at DESC
 LIMIT ?
```

`searchable_text` is the canonical "everything searchable about
this row" column populated at write time by each entity module's
`searchableText(payload)`. ADR
[`0011`](../decisions/0011-entity-contract.md) records the
contract; phase 4 fills it with kind-specific text:

| Kind           | `searchable_text` covers                                     |
| -------------- | ------------------------------------------------------------ |
| company        | title + legal name + trade name + industry + description     |
| contact        | display name + emails + phone numbers + linked company title |
| calendar_event | title + summary + attendee names + meetingSummaryNote        |
| todo           | title + description + linked entity titles                   |

Per-kind retrieval limit (`opts.limit`) is set to 5 by the chat
pipeline's retrieval step; aggregate cap is 20 hits (deduped by
id). Hits are returned as a small JSON shape
(`{ kind, id, slug, title, snippet }`) so the answerer's prompt
stays compact.

### 3.1 Why LIKE is fine in phase 6

- Entity volumes are small in v1 (single-user / single-tenant per
  server; phase 4 shipped four kinds).
- The auth-tag filter goes **first**, so the LIKE scan only
  considers rows the caller can see anyway.
- Quality limits surface organically: a "what did I talk to AMI
  about last week" question that misses on LIKE will show up as
  a thumbs-down. Phase 7's review-job will mine those.
- Recall is the headline thing semantic search improves; phase 7
  is the right place to pay the operational cost (an embedding
  model, vector store tuning).

### 3.2 Known shortcomings

- LIKE is case-insensitive but not stem-aware: "meeting" matches
  "meeting" but not "meet". Risk row §11 of the phase-6 plan
  records this; users react by retrying with the actual noun.
- Long `searchable_text` rows are scanned linearly; an index could
  be added once volumes warrant. Phase 7's read swap obsoletes
  this concern.
- No phrase boosting, no field weighting — that's also phase 7.

---

## 4. The LanceDB write path (phase 6)

The corpus that phase 7 will read is populated **today**, in
phase 6, by the embedding subscriber in
`apps/server/src/chat/embeddings/subscriber.ts`.

### 4.1 Table shape

`apps/server/src/chat/embeddings/lance-tables.ts` opens one table
per entity kind:

```
entity_company
entity_contact
entity_calendar_event
entity_todo

Schema (all four):
  { id        TEXT,
    layer_id  TEXT,      ← auth_tag
    kind      TEXT,
    slug      TEXT,
    text      TEXT,
    vector    FLOAT32[N] }
```

`layer_id` is the **only** authorization column. ADR
[`0021`](../decisions/0021-embedding-and-lance-auth-tag.md) §1
records why a single `layer_id` tag was picked over a per-layer
collection or a `user_id` tag.

Vector dimensionality (`N`) is fixed per embedder: 32 for
`MockEmbedder`, the model's native dim for `OpenAiEmbedder`.

### 4.2 Sync contract

The subscriber listens to entity bus events and applies:

| Bus event            | LanceDB action               |
| -------------------- | ---------------------------- |
| `entity.created`     | upsert row by id             |
| `entity.updated`     | upsert row by id             |
| `entity.softDeleted` | **delete row by id**         |
| `entity.deleted`     | **delete row by id**         |
| `entity.restored`    | upsert row by id (re-encode) |

Soft-delete deletes the LanceDB row. This is the **non-obvious
contract** worth knowing: a soft-deleted entity is invisible in
the primary store, and the vector store must match — surfacing a
soft-deleted row would violate `overall.md` §5 invariant 5 via a
different code path. The smoke test
(`apps/server/tests/smoke.test.ts`) and the subscriber unit test
(`apps/server/tests/chat-embeddings-subscriber.test.ts`) both pin
this — assert the LanceDB row lands after `entity.created`, then
assert it is gone after `entity.softDeleted`.

The subscriber declares `{ idempotent: true }` so the durable
bus's boot-recovery (ADR
[`0019`](../decisions/0019-durable-sqlite-message-bus.md)) can
replay safely.

### 4.3 Subscriber runs off-bus, not in the entity write tx

The embedding call is asynchronous off the bus, **not** inside the
entity write transaction. A delayed embedding is acceptable; a
stalled CRUD write is not (plan §11 risk row). If the bus crashes
between primary write and LanceDB write, the entity is briefly
missing from the corpus; the `chat.embeddings.backfill` scheduled
task catches up.

### 4.4 The backfill handler

`apps/server/src/chat/embeddings/backfill-handler.ts` is the
scheduled-task handler registered as
`kind: 'chat.embeddings.backfill'`. It iterates
`store.listSummaries(allLayerIds, ...)` per kind, encodes anything
missing in LanceDB, and writes one row at a time. Rate-limited
(default 50 entities/min, configurable); idempotent by entity id.

Inventory row at
[`job-inventory.md`](./job-inventory.md#chatembeddingsbackfill).

### 4.5 Embedder plug-in

`apps/server/src/chat/embeddings/embedder.ts` defines
`{ encode(text: string): Promise<readonly number[]> }`:

- `MockEmbedder` — deterministic hash → 32-dim float vector.
  Default when `config.embeddings.endpoint` is absent (the CI and
  the offline-dev path).
- `OpenAiEmbedder` — uses `config.embeddings.{endpoint, apiKey,
model, dimensions}`. Same secret-handling rules as the chat LLM
  (env or config file, never logged).

Switching embedder kinds in production requires a full corpus
re-encode (vector dims differ). Recorded as a phase-7 follow-up
(`docs/dev/follow-ups/chat-embedding-model-migration.md` — not
yet created; planned when a real model is picked).

---

## 5. The forward contract: phase 7 read swap

Phase 7's first sub-phase will replace the LIKE path with a vector
read **behind the same `searchSummaries(layerIds, term)`
interface**:

```ts
// Phase-7 sketch (this file documents the contract; the code
// lands in phase 7).
async function searchSummariesVector(
  layerIds: readonly string[],
  term: string,
  opts: { limit: number },
): Promise<readonly EntitySummary[]> {
  const queryVec = await embedder.encode(term);
  const hits = await lanceTable
    .search(queryVec)
    .where(`layer_id IN (${layerIds.map(quote).join(',')})`) // PRE-filter
    .limit(opts.limit)
    .toArray();
  return hits.map(toSummary);
}
```

The `where` clause is a **pre-search predicate**, not a
post-filter. LanceDB applies it before the vector neighbour scan,
so the answerer never even sees a row from a non-visible layer.

LIKE stays as a fallback when LanceDB is offline (e.g. degraded
mode); the dispatcher chooses based on `lancedb.ready`. Callers do
not change — the chat pipeline's retrieval step still calls
`searchSummaries(layerIds, term, { limit: 5 })`.

ADR [`0021`](../decisions/0021-embedding-and-lance-auth-tag.md) §4
records the deliberate deferral; the corpus exists in phase 6
exactly so phase 7 needs no backfill step.

---

## 6. Authorization invariants (summary)

For phase 6's LIKE path and phase 7's vector path alike:

1. The caller's effective layer set is computed once, server-side,
   per request, by `LayerResolver` (ADR
   [`0010`](../decisions/0010-layer-resolver-and-invalidation.md)).
2. Retrieval filters on `layer_id IN (effectiveLayerIds)` **before**
   any search (LIKE or vector); never after.
3. Soft-deleted rows are excluded from the primary store and
   removed from the vector store (`entity.softDeleted` →
   LanceDB row deleted).
4. The answerer's prompt only sees retrieval `output_json`. There
   is no other entity-data path into the LLM call.
5. Cross-layer chat is impossible: a conversation is scoped to one
   layer, retrieval reads that layer's effective set, and the
   layer membership table is the authoritative source.

Tests pinning these invariants:

- `apps/server/tests/chat-pipeline/orchestrator.test.ts` —
  auth-boundary across layers.
- `apps/server/tests/chat-embeddings-subscriber.test.ts` —
  soft-delete removes the vector row.
- `apps/server/tests/smoke.test.ts` — end-to-end calendar event:
  vector row lands, soft-delete makes it disappear.

---

## 7. Future extensions

- **Phase 7 read swap** — see §5 above. The corpus is ready; the
  swap is a code change behind the same interface.
- **Hybrid search** — combining LIKE recall with vector ranking
  for the long tail. Phase 7+ once both paths exist behind one
  facade.
- **Per-layer embedding budget** — the OpenAI embedder costs real
  tokens. Phase 7 will need a per-layer budget knob;
  `docs/dev/follow-ups/chat-per-layer-embedding-budget.md`.
- **Chunking long-form text** — phase 6 has no long-form entity
  kinds. When the "Later" catalogue lands (journals, documents) a
  `field` column on the LanceDB schema becomes the chunking key;
  the schema already carries `id` so this is forward-compatible.
- **IVF / HNSW tuning** — LanceDB defaults are fine at phase-6
  volumes. Phase 7 picks parameters once corpus + read-latency are
  real.
