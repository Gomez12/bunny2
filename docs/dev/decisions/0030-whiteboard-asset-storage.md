# ADR 0030 — Whiteboard asset storage (`files` map inline, capped)

- Status: proposed
- Date: 2026-05-25
- Phase: 11 (sub-phases 11.0, 11.1, 11.7)
- Related: [`docs/dev/plans/phase-11-whiteboards-excalidraw.md`](../plans/phase-11-whiteboards-excalidraw.md)
  §1, §3 non-goals, §4.1 (11.1), §4.3 (open question 3),
  §8 risk rows 4 + 7;
  ADR [`0028`](./0028-whiteboard-contract.md) (the payload
  envelope this ADR carves a hole in);
  ADR [`0029`](./0029-excalidraw-embedding-policy.md) (the
  trust boundary that disables URL-sourced images);
  Future ADR for phase 15 (`docs/dev/plans/phase-15-file-storage.md`)
  — this ADR commits to a migration handoff to that phase
  rather than building file storage early;
  Source code (lands in 11.1):
  `apps/server/src/storage/migrations/0021_whiteboards.sql`,
  `apps/server/src/entities/whiteboards/module.ts`,
  `packages/shared/src/whiteboards.ts`.

---

## Context

An Excalidraw scene with images carries the image bytes inside
the scene's `files` map — each entry is `{ id, mimeType, dataURL,
created }` where `dataURL` is a base64 `data:` URI. Images can be
megabytes each. The scene element references the file by `fileId`.

Three options exist for where to put those bytes:

1. **Inline in `payload_json`** — keep the `files` map next to
   the elements. Simple; row size grows with image count.
2. **Side table** (`whiteboard_files`) keyed by `(entity_id,
   file_id)` — splits binary from JSON, requires extra
   read/write to assemble the scene.
3. **Real file storage** (filesystem / S3-equivalent via the
   future phase-15 `file_storage` entity) — out of scope today
   (phase 15 has not landed; `phase-15-file-storage.md` is `open`).

Three decisions need recording before 11.1 (schema + module)
ships:

1. **Where do binary scene assets live in v1?**
2. **What is the per-file size cap and what happens at-cap?**
3. **How does the handoff to phase 15 work without breaking
   existing whiteboards?**

---

## Decisions

### 1. v1 stores `files` inline in `payload_json`; no side table

The scene's `files` map is persisted as part of the validated
`payload_json` in the per-kind `whiteboards` row, exactly as
Excalidraw emits it. No `whiteboard_files` side table is created
in 11.1.

**Why inline over a side table**:

- Reads stay simple: one row in, full scene out. No second query,
  no JOIN, no assembly step before passing `initialData` to the
  canvas.
- The per-version snapshot policy from ADR 0028 §1 stays correct
  by construction: a snapshot is one row in `entity_versions`,
  not "one row plus N file-rows" with their own lifecycle.
- A side table needs its own soft-delete + version + access-control
  story — duplicating concerns the entity contract already
  provides at the row level. Strictly more code for no v1
  capability.

**Why inline over phase-15 file storage**: phase 15 has not
shipped; phase 11 cannot depend on it. Inline storage with a
size cap (decision 2) is the pragmatic v1; the phase-15
migration path is decision 3.

The new column `scene_byte_size INTEGER NOT NULL DEFAULT 0` on
the `whiteboards` table records the total payload byte size
(elements + `files` map) at write time. It is the cheap signal
that drives the cap check, retention sweeps, and any future
"largest whiteboards" report.

### 2. Per-file cap = 2 MiB; over-cap PATCH returns a stable error

Each `files` entry has a server-enforced cap of **2 MiB**
(2 × 1024 × 1024 bytes) measured on the raw bytes of the
`dataURL`'s base64 payload (the bytes actually stored, not the
encoded length).

A PATCH containing an over-cap file returns HTTP 413 with the
stable error code `entity.whiteboards.errors.tooLarge`. The
wrapper in 11.5 catches this and renders the localised message
`entity.whiteboards.errors.tooLarge` (the i18n key list is in
plan §11.6) plus the offending file name when known.

A scene-level cap is **not** added in v1; the per-file cap plus
the natural ceiling of payload sizes that LanceDB / SQLite handle
gracefully is enough. If scene-level pressure surfaces during
dogfood, a follow-up adds a configurable `whiteboards.maxSceneBytes`
setting per layer.

**Why 2 MiB**: matches the rough order of magnitude of a
high-quality screenshot. Smaller caps frustrate the obvious
use case (paste a screenshot of a diagram into a whiteboard);
larger caps invite users to embed PDFs or video poster frames
and notice the resulting save latency.

**Why a hard reject rather than auto-downscale**: auto-downscale
is a separate UX promise (lossy transform without user consent)
and a separate dependency surface (image decoder + encoder).
Out of scope for v1; the wrapper may surface "your image is
too large, please resize" as a UX affordance, but the server
rejects.

**Why measure raw bytes, not encoded length**: base64 inflates
by ~33%; capping the encoded length punishes scenes for the
encoding choice rather than the actual asset weight.

### 3. Phase-15 handoff: one-off migration moves over-threshold files out

When phase 15 (`docs/dev/plans/phase-15-file-storage.md`) lands,
a one-off migration sweeps existing whiteboards:

- For each `files` entry above a phase-15-defined threshold
  (likely lower than the 2 MiB v1 cap), the migration:
  1. Writes the bytes into the phase-15 `file_storage` entity
     (one file per `files` entry, layer-scoped).
  2. Rewrites the scene's `files[id].dataURL` to a stable
     reference shape (e.g. `file_storage:<file-id>`) that the
     wrapper resolves at load time.
  3. Bumps the whiteboard's `version` and writes an
     `entity_versions` snapshot tagged with the migration
     identifier in `meta_json`.
- The 2 MiB cap from decision 2 is lifted at the same time;
  the new cap is whatever phase 15 settles on for file storage.

The migration is **forward-only** (per the entity-contract DoD
in phase 4.2) and runs once at the phase-15 deploy. Whiteboards
created after phase 15 use the new path directly; the migration
exists to bring v1 data forward, not as a runtime fallback.

**Why commit to this in 11.0**: locking the handoff shape now
keeps phase 11's `files` storage choice from accidentally
becoming permanent. Phase 15 inherits a known migration target;
the v1 inline policy is explicitly transitional.

**Why not delay this commitment until phase 15**: future-phase
ambiguity would tempt phase 11 to grow side tables or other
provisional infrastructure ("just in case"). Naming the migration
shape now keeps 11.1 minimal.

---

## Consequences

- The `whiteboards` row is the single canonical document for one
  whiteboard's scene, files, and version chain. No JOINs needed
  for reads.
- Scenes with many large images get heavy quickly. The per-file
  cap plus the `scene_byte_size` column make the pressure visible
  before it becomes a problem; the phase-15 migration is the
  release valve.
- `entity_versions` snapshots include the `files` map. The
  retention sweep mentioned in ADR 0028 §Consequences applies
  doubly to whiteboards with images; the size cap keeps the
  worst case bounded.
- The wrapper's lazy-load path (per ADR 0029 §Consequences) is
  unaffected by image weight — images are part of the
  per-detail-page payload, not the bundle.
- LanceDB index writes (`searchable_text` from ADR 0028 §2) are
  text-only and unaffected by image size.
- Backups grow with whiteboard image weight. SQLite backup
  cadence already covers this; no separate concern.

---

## Alternatives considered

1. **Side table `whiteboard_files`.** Rejected: duplicates the
   entity contract's lifecycle handling and adds a JOIN to every
   detail read for no v1 capability (decision 1).
2. **Real file storage in phase 11.** Rejected: phase 15 owns
   file storage. Reaching ahead would either build a throwaway
   filesystem sink or anticipate phase 15 design decisions that
   are not yet made (decision 3).
3. **No cap; rely on SQLite's max-row-size handling.** Rejected:
   SQLite tolerates large rows but the resulting save latency,
   backup weight, and `entity_versions` blow-up surface as
   user-visible badness with no graceful failure mode
   (decision 2).
4. **Cap = 512 KiB.** Rejected as too aggressive for the
   pasted-screenshot use case (decision 2).
5. **Cap = 10 MiB.** Rejected as too permissive; encourages
   embedding artefacts (PDFs, video frames) that belong in real
   file storage (decision 2).
6. **Auto-downscale over-cap images server-side.** Rejected for
   v1: separates the asset from what the user pasted (lossy
   transform without explicit consent) and adds an image-codec
   dependency surface (decision 2).
7. **Store `dataURL` as-is including `http(s):` URLs.** Rejected
   per ADR 0029 §3 — URL-sourced images would emit network
   signals to arbitrary hosts inside the user's session.
   Server-side validation rejects non-`data:` URIs.
