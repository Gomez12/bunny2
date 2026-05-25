# ADR 0028 — Whiteboard contract (snapshot-on-checkpoint versioning)

- Status: proposed
- Date: 2026-05-25
- Phase: 11 (sub-phases 11.0, 11.1, 11.7)
- Related: [`docs/dev/plans/phase-11-whiteboards-excalidraw.md`](../plans/phase-11-whiteboards-excalidraw.md)
  §1, §4.1 (11.1), §4.3 (open question 1), §7, §8 (risk row 1);
  ADR [`0011`](./0011-entity-contract.md) (entity contract — the
  substrate this whiteboard module plugs into);
  ADR [`0029`](./0029-excalidraw-embedding-policy.md) (the
  embedding policy that determines what shape the payload takes);
  ADR [`0030`](./0030-whiteboard-asset-storage.md) (the asset
  storage policy that splits scene elements from binary `files`);
  Source code (lands in 11.1):
  `apps/server/src/storage/migrations/0021_whiteboards.sql`,
  `apps/server/src/entities/whiteboards/`,
  `packages/shared/src/whiteboards.ts`.

---

## Context

Phase 11 (Whiteboards) adds the next §6 entity kind on top of the
universal entity contract from
[`ADR 0011`](./0011-entity-contract.md). The other phase-4
entities — companies, contacts, calendar events, todos — have
small structured payloads (a handful of fields each). A whiteboard
is structurally different:

- The payload is an **Excalidraw scene** — an array of element
  objects (rectangles, arrows, text nodes, freedraw paths,
  embedded images) keyed by element id. A non-trivial whiteboard
  holds hundreds to thousands of elements.
- Scene changes happen in **bursts**: a single drag of a shape
  emits dozens of `onChange` callbacks; a five-minute editing
  session can produce tens of thousands of state mutations.
- Storage cost compounds across the version chain: per-keystroke
  `entity_versions` rows would inflate the table by orders of
  magnitude versus other entity kinds.

Three decisions need to be recorded before 11.1 (schema + module)
can ship deterministically:

1. **What is the unit of "a version" for a whiteboard?**
2. **What goes into `searchable_text` for LanceDB indexing when
   the payload is largely non-textual geometry?**
3. **Does the per-kind table validate the full Excalidraw schema
   or treat element bodies as opaque?**

This ADR records the answers. Status remains `proposed` until
phase 11.1 ships the migration + module + contract-test pass; it
moves to `accepted` in the §11.7 close-out.

---

## Decisions

### 1. Versioning = snapshot-on-checkpoint, not per-keystroke

Phase 11 bumps `version` in the per-kind `whiteboards` table and
writes an `entity_versions` row only on a **checkpoint**, defined
as either:

- An explicit user action ("Save version" button in the §11.5 UI).
- A 2-minute idle-then-edit window (the wrapper has a debounced
  edit buffer; if the buffer is non-empty and 2 minutes elapse
  since the last mutation, the next PATCH is treated as a
  checkpoint).

Between checkpoints, the working copy is persisted by overwriting
`whiteboards.payload_json` (`updated_at` / `updated_by` move,
`version` does not). The phase-4 entity contract's
`updated_at`/`updated_by` semantics are preserved; only the
version chain is coarser-grained than for other entity kinds.

**Why not per-keystroke**: a single edit session for a busy
whiteboard easily emits 10⁴+ `onChange` callbacks. Writing an
`entity_versions` snapshot per callback would inflate the table
by ~10³× versus other entity kinds and bloat backups for no
recoverable signal — a user who wants to "go back to what this
looked like 30 seconds ago" cannot meaningfully pick from ten
thousand near-identical snapshots.

**Why not "no version chain"**: drops the contract-test promise
that every entity kind has a uniform version chain
(`entity_contract/version-bump.test.ts`). Breaking the contract
per-kind is more expensive than coarsening it.

**Why explicit + 2-minute auto-checkpoint**: a pure manual model
loses work if a user closes the tab without clicking "Save
version"; a pure auto-checkpoint model produces version churn the
user did not ask for. The combination matches user intent
("I'm done with this thought") with safety net (idle-window
auto-snapshot).

### 2. `searchable_text` is derived from text elements only

`whiteboards.searchable_text` (used to populate the LanceDB index
per §11.1) is built server-side at PATCH time by walking the
scene's element array and concatenating the `text` field of every
`text` element (and the `label.text` of any container that has
one) in z-order, joined by newlines.

Non-text elements (geometry, freedraw, arrows, images) contribute
nothing to `searchable_text`. The thumbnail (see ADR `0030`) is
the spatial summary; text extraction is the textual summary.

**Why text-only**: LanceDB embeddings on geometry coordinates are
not meaningful retrieval signals. Embedding the raw JSON would
flood the vector with structural tokens (`type`, `id`, `x`, `y`,
`fillStyle`, …) and dilute the user's text content. Extracting
text only keeps the index payload bounded regardless of scene
complexity (the LanceDB index size risk in §8 row 6 of the plan).

**Why server-side, not in the wrapper**: keeps the rule canonical
— a future native client (mobile, automation) that writes the
same payload gets the same index. Wrapper-side extraction would
duplicate the rule and risk drift.

### 3. zod validates only load-bearing fields; element bodies pass through

`packages/shared/src/whiteboards.ts` validates the scene envelope
strictly:

- `version` (Excalidraw scene format version — a number).
- `type === 'excalidraw'`.
- `elements` is an array; every entry has `id`, `type`, `version`,
  and `isDeleted` validated.
- `appState` is an object (not validated field-by-field).
- `files` is an object map from file-id → entry; entry has
  `mimeType`, `dataURL`, `id`, `created` validated. See ADR
  `0030` for the cap on entry size.

The rest of every element passes through as opaque `unknown` —
zod's `z.passthrough()` on each element object. The server stores
what it received; it does not normalize or rewrite element
bodies.

**Why opaque element bodies**: Excalidraw upstream evolves the
element schema regularly (new properties, new element kinds).
A strict per-field schema would break on every upstream minor
bump and create unsightly migrations. ADR `0029` commits to
upstream-only with no fork; the validation policy here matches —
the wrapper trusts upstream's own self-consistency and only
guards the fields the server actually consumes.

**Why validate the envelope at all**: the server **does** consume
the envelope. `version`, `type`, `elements` (for text extraction
+ size cap + element-count badge), and `files` (for the size cap
in ADR `0030`) all drive server behaviour. Letting those fields
in unchecked would mean a malformed PATCH could panic the text
extractor or skip the size cap.

---

## Consequences

- The `entity_versions` table stays modest in size even for
  heavily-edited whiteboards. A per-layer retention sweep (keep
  last N + monthly snapshots) is filed as a follow-up to land
  the first time it bites — not at 11.1.
- The contract test `version-bump.test.ts` is satisfied: a
  checkpoint bumps the version. A test added in 11.1 asserts that
  a non-checkpoint write does **not** bump the version, locking
  the coarse-grained semantic.
- LanceDB writes for whiteboards have a predictable payload
  shape regardless of scene complexity; the LanceDB-cross-layer
  test from phase 7.1 covers them automatically (the test is
  generic over entity kinds).
- The server cannot answer "what changed between version N and
  N+1" at the element level — only the snapshot diff. This is
  acceptable for v1; richer per-element diffs are a follow-up
  scoped to whichever phase introduces collaborative editing.
- Adding a new Excalidraw element kind upstream requires no code
  change here; the opaque-passthrough policy absorbs it.

---

## Alternatives considered

1. **Per-keystroke versioning.** Rejected: 10³× version-row
   inflation versus other entity kinds for negligible recovery
   value (decision 1).
2. **No version chain for whiteboards.** Rejected: breaks the
   uniform entity-contract promise (decision 1). The contract
   tests are generic over kinds; opting out would force a
   per-kind exception in the contract harness.
3. **Server-side per-element CRDT** (every element gets its own
   version chain). Rejected: out of scope for v1 (the plan §3
   non-goals exclude per-element version chains). Would require
   either a CRDT runtime on the server or a serialization
   scheme that lets the server diff scenes; both are larger than
   the rest of the phase combined.
4. **Embed the whole scene JSON in LanceDB.** Rejected: dilutes
   the user's text content with structural tokens (decision 2)
   and inflates the per-row vector budget the phase-7.1
   `chat-lancedb-read-swap` doc-check expects to stay modest.
5. **Strict per-field zod schema for every element.** Rejected:
   breaks on every Excalidraw upstream minor bump (decision 3);
   forces a migration plus a coordinated upstream-pin cadence
   that the rest of the project does not need.
