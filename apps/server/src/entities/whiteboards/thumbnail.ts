/**
 * Phase 11.1 — server-side thumbnail registration shell.
 *
 * DECISION (resolves plan §9 open question 1, taken in 11.1):
 *
 *   Thumbnail PNGs are rendered on the WEB BUILD via Excalidraw's
 *   `exportToBlob({ mimeType: 'image/png' })` and POSTed alongside
 *   the scene in the 11.5 PATCH flow. The server stores the bytes in
 *   the `whiteboards.thumbnail_blob` BLOB column and the stable
 *   `whiteboards.thumbnail_etag` column.
 *
 *   The alternative — a server-side renderer using `canvas` or
 *   `skia-canvas` — was rejected because:
 *     1. `overall.md` §Dependencies says no native-canvas dep without
 *        a documented reason; thumbnail rendering does not clear that
 *        bar.
 *     2. The web build ALREADY has Excalidraw loaded (the canvas is
 *        the page), so `exportToBlob` is free there; the server would
 *        re-render the same scene a second time.
 *     3. Headless canvas dependencies (`canvas`, `skia-canvas`) are
 *        heavy native modules that break our cross-platform build
 *        story (macOS / Linux / Windows per `AGENTS.md` §Platforms).
 *
 *   DO NOT import any canvas library from this file. 11.5 will:
 *     - render the PNG client-side via Excalidraw's `exportToBlob`,
 *     - compute a stable ETag (e.g. SHA-256 of the bytes),
 *     - POST `{ blob, etag }` as part of the checkpoint body,
 *     - the PATCH handler will accept the contract type below and
 *       write the BLOB / etag into the table.
 *
 *   This decision is captured in ADR 0029 and in plan §9 open
 *   question 1; 11.5 should not re-debate it. If a future phase
 *   needs a server-side renderer (e.g. SVG export for printing), that
 *   is a SEPARATE decision against `overall.md` §Dependencies and
 *   needs a new ADR — not a re-litigation of this one.
 */

/**
 * Type-only contract the 11.5 PATCH route accepts on a checkpoint
 * body. The shell exports the type so 11.5 can import it without a
 * runtime dependency cycle.
 *
 *  - `blob`  — the PNG bytes the web client rendered via Excalidraw's
 *              `exportToBlob`. Stored verbatim into
 *              `whiteboards.thumbnail_blob`.
 *  - `etag`  — a stable identifier the web client uses to skip a
 *              re-render when the scene hasn't changed (recommended:
 *              SHA-256 hex of the bytes, but the server treats it as
 *              opaque text).
 */
export interface WhiteboardThumbnail {
  readonly blob: Uint8Array;
  readonly etag: string;
}
