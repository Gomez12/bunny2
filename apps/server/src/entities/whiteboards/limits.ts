/**
 * Phase 11.5 — whiteboard size limits.
 *
 * Codifies the per-whiteboard scene byte cap and the per-file binary
 * cap referenced by ADR 0030. Enforced at the route boundary on POST
 * and on the checkpoint PATCH (see `routes.ts`). Kept in a tiny
 * standalone module so the constants can be imported from tests
 * without dragging the route surface.
 *
 *  - `SCENE_BYTE_CAP`  — `JSON.stringify(payload).length` upper bound
 *                        (UTF-16 code units, matching the module's
 *                        `scene_byte_size` indexed column). 2 MiB.
 *  - `PER_FILE_BYTE_CAP` — upper bound on a single `files[fileId]`
 *                        entry's `dataURL` length. Same 2 MiB cap as
 *                        the scene cap; the cap is per-asset, not
 *                        aggregate (the scene cap covers aggregate).
 *
 * The 2 MiB number is the conservative default the plan §8 risks row
 * cites. Bumping it requires an ADR amendment (0030).
 */

export const SCENE_BYTE_CAP = 2 * 1024 * 1024;
export const PER_FILE_BYTE_CAP = 2 * 1024 * 1024;
