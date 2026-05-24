# ADR 0021 — Embedding pipeline + LanceDB `layer_id` auth_tag

- Status: accepted
- Accepted on: 2026-05-24
- Date: 2026-05-24
- Phase: 6 (sub-phase 6.2; landed across 6.2–6.6)
- Related: `docs/dev/plans/phase-06-super-chat.md` §2, §4.3, §6,
  §10; `docs/dev/architecture/retrieval.md` (lands in 6.7);
  ADR [`0003`](./0003-lancedb.md) (LanceDB choice; this ADR is the
  first concrete use of it);
  ADR [`0011`](./0011-entity-contract.md) (the `searchable_text`
  column this scaffold encodes from);
  ADR [`0010`](./0010-layer-resolver-and-invalidation.md) (the
  authoritative answer to "may this user see this layer right now"
  — phase 7's read path consumes the same resolver);
  ADR [`0020`](./0020-chat-pipeline.md) (the pipeline that will
  read from LanceDB in phase 7);
  Source code (lands in 6.2):
  `apps/server/src/chat/embeddings/`.

---

## Context

`overall.md` §5 invariant 8 is non-negotiable: "Vector / semantic
search must filter on the caller's effective layer/group access
**before** retrieval, never after." ADR 0003 picked LanceDB but
deferred embedding generation and the actual query path. ADR 0011
fixed `searchable_text TEXT NOT NULL` on every per-kind entity
table as the LanceDB index source.

Phase 6 picks up the **write side** only: every entity create /
update encodes its `searchable_text` and upserts a LanceDB row
tagged with `layer_id`. Phase 6 does **not** read from LanceDB
(plan §2 explicitly excludes it; retrieval continues through
`searchSummaries`'s LIKE filter). Phase 7 flips reads over once
the corpus has been there long enough to validate the schema and
the soft-delete contract under real load.

The two open questions this ADR records:

1. **What is the auth tag on a LanceDB row?** It must be something
   the phase-7 read path can filter on **before** the vector
   query, with no LLM in the loop.
2. **What is the contract for keeping the LanceDB corpus in sync
   with the primary store, especially under soft-delete?**

---

## Decisions

### 1. The auth tag is the entity's `layer_id`. Nothing else.

Each LanceDB row carries `{ id, layer_id, kind, slug, text, vector }`.
`layer_id` is the **only** authorization column. Phase 7's read
path will resolve the caller's effective layer set via the existing
`LayerResolver` (ADR 0010) and filter
`layer_id IN (<effectiveLayerIds>)` **before** asking LanceDB for
the vector neighbours. The filter goes through LanceDB's
pre-search predicate, not a post-filter, so the answerer can never
even see a row from a non-visible layer.

Rejected: **a per-layer collection / table.** LanceDB does support
multiple tables, but materializing one per layer would explode the
table count (a user with personal + project + group + everyone is
already four), complicate the resolver-cache invalidation, and
make backfill of "what layers can this user see" into a join the
LanceDB API does not natively model. A single table per entity
kind with a `layer_id` column matches how the primary store
organizes the data.

Rejected: **a user-id tag.** Phase 6 conversations are
`(layer_id, user_id)` scoped (plan §10), but the **entities** they
read over are layer-scoped. A `user_id` tag would force a join
between conversation and entity that the primary store does not
need. Per-user privacy lives in layer membership, not in the
vector store.

The `layer_id` choice is the same column name the primary store
uses on every per-kind entity table. That alignment is deliberate:
a single migration change to the layer model (none planned) would
need one update in this ADR's write path, not two.

### 2. The corpus mirrors the primary store, including soft-delete

The embedding subscriber listens to every relevant entity bus event
and propagates:

| Bus event            | LanceDB action                 |
| -------------------- | ------------------------------ |
| `entity.created`     | `upsert` row by id             |
| `entity.updated`     | `upsert` row by id             |
| `entity.softDeleted` | **delete row by id**           |
| `entity.deleted`     | **delete row by id**           |
| `entity.restored`    | `upsert` row by id (re-encode) |

Soft-delete deletes the LanceDB row. This is the **non-obvious
choice** worth recording: a soft-deleted entity is invisible to
users and agents in the primary store (per `overall.md` §5
invariant 5). The vector store must match — surfacing a soft-deleted
row to the answerer would violate the invariant via a different
code path. A restore re-encodes and re-upserts.

The corpus is **eventually consistent** with the primary store.
The subscriber runs **off the bus**, not inside the entity write
transaction (plan §11 risk: "LanceDB write subscriber slows entity
writes"). A delayed embedding is acceptable; a stalled CRUD write
is not. The subscriber declares `{ idempotent: true }` so the
durable bus's boot-recovery can replay safely (ADR 0019 §4).

If the bus crashes between the primary write and the LanceDB
write, the entity is briefly missing from the corpus. The
`chat.embeddings.backfill` scheduled task (registered in 6.2,
inventory row in 6.6) catches up by iterating
`store.listSummaries(allLayerIds)` for each kind and encoding
anything missing.

### 3. Embedder is pluggable; default is `MockEmbedder`

`apps/server/src/chat/embeddings/embedder.ts` defines the
interface `{ encode(text: string): Promise<readonly number[]> }`.
Two implementations land in 6.2:

- `MockEmbedder` — deterministic hash → 32-dim float vector. The
  default when no embeddings endpoint is configured. Keeps CI,
  smoke, and offline dev runs deterministic.
- `OpenAiEmbedder` — uses the existing `LlmConfig` plus an
  `embeddings.model` field (e.g. `text-embedding-3-small`). Same
  secret-handling rules as the chat LLM (env or config file,
  never logged).

Vector dimensionality is fixed **per embedder** (32 for Mock; the
embedding model's native dim for OpenAI). Switching embedder kinds
in production requires a re-encode of the full corpus — recorded
as a phase-7 follow-up (`embedding-model-migration.md`) the day
the user picks a real model.

Rejected: **build our own embedding model.** Out of scope by
several orders of magnitude.

Rejected: **encode in the entity write transaction.** Even with a
local model, encoding adds latency to every CRUD write; with a
remote model it makes CRUD depend on an external service. The
async-off-bus pattern was the right call for enrichment (ADR 0013)
and is the right call here.

### 4. Write-only in phase 6; read swap is phase 7

This is the **deliberate asymmetry** worth recording in this ADR
rather than discovering it later. Phase 6's retrieval step calls
`searchSummaries(layerIds, term)`'s LIKE search — not LanceDB.
LanceDB receives writes only.

Why split the work:

- Phase 6 can ship the headline chat feature without picking an
  embedding model. The MockEmbedder is enough to validate the
  subscriber, the soft-delete contract, and the backfill job.
- The cost of producing the corpus is paid in phase 6 (every
  write writes). By the time phase 7 lands, the corpus already
  exists. The read swap is a code change, not a backfill.
- LIKE retrieval is fine for the entity volumes phase 6 will
  produce; quality limits will surface organically and inform
  the embedding-model choice.

Phase 7's first sub-phase will (a) pick an embedding model,
(b) backfill the corpus through `chat.embeddings.backfill` with
the real embedder, (c) flip retrieval from LIKE to vector search
behind the same `searchSummaries` interface, (d) keep LIKE as a
fallback when LanceDB is offline. None of that work is in scope
here.

---

## Consequences

- One new module `apps/server/src/chat/embeddings/` owns
  embedder + tables + subscriber + backfill handler. Nothing else
  in `apps/server/src/` writes to LanceDB.
- The bus's `entity.softDeleted` (and `entity.deleted`,
  `entity.restored`) event family is now part of a contract — a
  future refactor that drops one of those events breaks the
  soft-delete invariant. The contract test in 6.2 (assert
  `softDeleted` → vector row gone) pins this.
- Phase 7's read path can rely on a populated corpus on day one;
  no `bun run backfill-embeddings` step in the phase-7 close-out.
- The job inventory (`architecture/job-inventory.md`) gains
  `chat.embeddings.backfill` as a new `kind` (6.2 registration,
  6.6 close-out adds the row).
- `tests/docs/job-inventory.test.ts` enforces the inventory row.
- `bun run docs:check` already covers ADR linkage; this file
  appears in the index when phase 6 closes.

---

## Non-decisions (intentional)

- **No tenant column.** bunny2 is single-tenant per server
  (`overall.md` §3). A future federation (UUIDs already in place)
  would need a `tenant_id` tag here as well — recorded but
  deferred.
- **No chunking.** Each entity's `searchable_text` is encoded as
  one vector. Long-form fields (journal entries, documents) will
  need chunking when the "Later" entity catalogue lands; phase 6
  has none of those.
- **No similarity threshold in the write path.** Quality
  thresholds belong to the read path, which is phase 7.
- **No vector index tuning here.** LanceDB defaults are fine at
  the volumes phase 6 will produce. Phase 7 picks IVF / HNSW
  parameters once the corpus + the read latency are real.
- **No multi-vector-per-entity.** One vector per entity row,
  encoded from `searchable_text`. Adding e.g. a separate
  description-vector is a future-proofable change because the
  table schema carries `id` — phase 7 can add a `field` column
  if it needs to.
