# ADR 0003 — LanceDB as the vector store

- Status: accepted
- Date: 2026-05-23
- Phase: 1.2 (recap, authored during 1.7 close-out)
- Related: `docs/dev/plans/overall.md` §3 (non-goals; vector retrieval
  is auth-aware), §4 (technical foundation), §5.8 (authorization-aware
  retrieval invariant), §9 (LanceDB risk row);
  `docs/dev/plans/phase-01-system-foundation.md` §4.2 row "1.2",
  §10 row 2 (LanceDB risk); `docs/dev/follow-ups/lancedb-windows.md`.

---

## Context

The overall plan (§4) names LanceDB as the vector DB and (§5.8)
mandates **authorization-aware retrieval**: the layer/group filter
applies _before_ the vector search, never after. Phase 1.2 only had to
prove the runtime bootstraps a LanceDB connection in the data-dir and
that the `/status` endpoint can report it; actual semantic search is a
phase-4+ deliverable.

The constraints LanceDB had to meet for phase 1.2:

1. **Embeds into a portable per-OS executable** alongside the Bun
   server and SQLite.
2. **File-based** in the data-dir, same shape as SQLite — one
   directory per user, easy to back up and to delete.
3. **Works on macOS, Linux, Windows** to whatever extent the
   electron-builder matrix supports.
4. **Future-proof for authorization-aware retrieval**: schema can
   carry a layer/group filter column so the filter applies pre-search.

---

## Decision

### 1. Use LanceDB as the vector store

We use `@lancedb/lancedb` (`apps/server/package.json` pins
`^0.10.0`). `apps/server/src/storage/lancedb.ts::openLanceDB(dataDir)`
calls `connect(<dataDir>/lancedb)`. The directory is created on first
run by the data-dir bootstrap in `apps/server/src/config/`.

Phase 1.2 ships an empty database — no tables, no embeddings, no
queries — and `/status` reports `lancedb.ready: true` plus an empty
`tables: []`. The smoke test (`apps/server/tests/smoke.test.ts`)
asserts the directory exists and the connection opens cleanly.

### 2. Deferred to phase 4+

The following are explicitly **not** in phase 1:

- Embedding generation (no model, no pipeline).
- Table creation with a real schema. The overall plan (§5.8) and the
  phase-1 detail plan note a reserved `auth_tag` column for layer
  scoping; the column lands when the first real table does.
- Any query path. There is no caller of LanceDB in phase 1; only the
  bootstrap.
- Cross-layer isolation tests. They land with the first real index
  (phase 4 or 6, whichever introduces semantic search first).

This is intentional: the overall plan invariant ("vector retrieval is
auth-aware") is best enforced when there is real retrieval to gate.
Phase 1 only proves the storage substrate.

### 3. LanceDB ships as a native module next to the server bundle

LanceDB's npm package contains a per-platform `.node` artifact
(`lancedb.<plat>-<arch>.node`). The packaging pipeline (ADR 0004 §2)
copies that file into `apps/desktop/resources/server/` so the bundled
Bun process can load it at runtime. This is why each portable artifact
carries an OS-specific LanceDB native — there is no universal binary.

---

## Consequences

**Positive**

- LanceDB is purpose-built for embedded vector search: file-based,
  no server process, columnar layout, fast cold reads, no separate
  ANN index lifecycle. Fits our portable shape.
- The Apache-2.0 license and the Rust core make supply-chain review
  tractable.
- Schema layout (a regular columnar table with vector + auth-tag
  columns) maps directly to the pre-filter retrieval pattern we
  require (§5.8 of the overall plan).

**Negative / accepted**

- ~60 MB native module per OS, bloating the portable artifact. We
  ship one binary per target; accepted via ADR 0004 §Consequences.
- Windows packaging may stall on the native module. Tracked in
  `docs/dev/follow-ups/lancedb-windows.md`; the proposed escape hatch
  is `BUNNY2_DISABLE_LANCEDB=1`, not yet implemented.
- LanceDB is younger than mature alternatives (FAISS, pgvector). We
  accept the maturity gap because the portable-product shape rules
  the alternatives out (FAISS = no persistence story; pgvector =
  requires Postgres, see ADR 0002).
- No semantic search in phase 1, so there is nothing to performance-
  tune or benchmark yet. Phase 4+ owns those measurements.

---

## Alternatives considered

1. **`pgvector` on a sidecar Postgres.** Rejected: contradicts the
   portable local-first shape (ADR 0002). Adds a second runtime
   process the user has to install.
2. **FAISS or HNSW-lib in-memory.** Rejected: no persistence layer
   without rolling our own. We would re-implement what LanceDB
   already gives us.
3. **Chroma.** Considered. Comparable in shape (file-based, embedded),
   but the Bun-side support story was less proven during phase-1
   planning. Revisit if LanceDB blocks Windows packaging in a way
   that the env-flag escape hatch doesn't cover.
4. **Defer the vector store entirely until phase 4.** Rejected: the
   overall plan §4 names it as part of the technical foundation,
   the data-dir layout reserves space for it, and `/status` reports
   on it — having no scaffolding in phase 1 would mean ripping the
   schema-versioning conventions during phase 4.

---

## Status

Accepted. No phase-1 deliverable was blocked by LanceDB on macOS or
Linux. Windows packaging is unverified locally (macOS host); a CI
matrix (phase 1.7 deliverable, see `release.yml`) is the path to a
verified Windows build. If Windows packaging is confirmed broken by
LanceDB, escalate the follow-up
`docs/dev/follow-ups/lancedb-windows.md` and consider Chroma as a
phase-1.x fallback.

## Follow-ups

- `docs/dev/follow-ups/lancedb-windows.md` — Windows packaging story
  and the `BUNNY2_DISABLE_LANCEDB=1` escape hatch.
- Phase 4 (or whichever phase first creates a real LanceDB table)
  owns the `auth_tag` column, the embedding pipeline, and the
  cross-layer isolation tests. Re-cite §5.8 of the overall plan and
  this ADR in that phase plan.
