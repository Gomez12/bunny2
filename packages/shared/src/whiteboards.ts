import { z } from 'zod';

/**
 * Cross-package zod schemas for the whiteboard entity (phase 11.1).
 *
 * Fifth concrete kind on top of the §4.0 entity-contract foundation
 * (after companies, contacts, calendar_events, todos). Mirrors the
 * per-kind shared-zod precedent: schemas live here for the HTTP
 * boundary + the web client; server-internal repo types live in the
 * per-kind table (`0021_whiteboards.sql`) + module
 * (`apps/server/src/entities/whiteboards/module.ts`).
 *
 * Per ADR 0028, the whiteboard scene is stored as opaque validated
 * JSON inside `payload_json`. We deliberately validate ONLY the
 * load-bearing fields of each Excalidraw element (`version`, `type`,
 * `id`) and accept the rest as opaque `unknown`. This keeps the
 * schema decoupled from Excalidraw upstream churn (plan §8 Risks
 * "Excalidraw upstream schema drift breaks zod validation") and ADR
 * 0029's "no fork, no extensions" stance.
 *
 * Per ADR 0030, binary scene assets live in the `files` map keyed by
 * the same `fileId` referenced from inside the scene's image
 * elements. Per-file size cap is enforced server-side at the PATCH
 * boundary (lands in 11.5); 11.1 only validates structural shape.
 */

// ---------- element + file sub-schemas ---------------------------------

/**
 * Minimal element validation. `version` / `type` / `id` are required;
 * everything else is opaque `unknown`. The schema uses `.passthrough()`
 * so unknown keys round-trip untouched — the canonical scene stored
 * server-side mirrors what Excalidraw produced on the client.
 *
 * NOTE: zod's default `.object(...)` is "strip unknown keys". We need
 * passthrough so client-side keys (`x`, `y`, `width`, `height`,
 * `points`, `text`, `fontSize`, ...) survive the round-trip. The cost
 * is that a malformed element (wrong key shape) reaches the canvas as
 * data Excalidraw might choke on — but `payloadSchema.parse` only
 * runs on the way IN, so any element that came back out of Excalidraw
 * is by definition something Excalidraw will accept again.
 */
export const ExcalidrawElementSchema = z
  .object({
    version: z.number(),
    type: z.string().min(1),
    id: z.string().min(1),
  })
  .passthrough();
export type ExcalidrawElement = z.infer<typeof ExcalidrawElementSchema>;

/**
 * Excalidraw's `BinaryFileData` shape (the entries of `scene.files`).
 * Keep validation tight on the structural keys; the `dataURL` blob
 * itself is opaque-but-bounded — per-file size enforcement lives
 * server-side at the PATCH boundary (lands in 11.5).
 */
export const ExcalidrawFileEntrySchema = z
  .object({
    id: z.string().min(1),
    mimeType: z.string().min(1),
    dataURL: z.string().min(1),
    created: z.number(),
    lastRetrieved: z.number().optional(),
  })
  .strict();
export type ExcalidrawFileEntry = z.infer<typeof ExcalidrawFileEntrySchema>;

/**
 * Scene wrapper. `elements` is the ordered list of Excalidraw
 * elements; `appState` carries view-level state (zoom, viewport
 * background colour, current item style). `appState` is opaque
 * `unknown` for the same reason elements are: Excalidraw owns its
 * shape, we mirror it untouched.
 */
export const ExcalidrawSceneSchema = z
  .object({
    elements: z.array(ExcalidrawElementSchema),
    appState: z.unknown().optional(),
  })
  .strict();
export type ExcalidrawScene = z.infer<typeof ExcalidrawSceneSchema>;

// ---------- payload schema -----------------------------------------------

/**
 * Whiteboard payload — the canonical pair Excalidraw needs to restore
 * a scene: `scene` (elements + app state) and `files` (binary asset
 * map). Both are required at the schema layer so a freshly-created
 * empty whiteboard still parses (`scene.elements: []`, `files: {}`).
 *
 * A v1 whiteboard creates with both keys present — the §4.0 PATCH
 * merge contract preserves top-level keys not present in the request
 * body, so a save that touches `scene` without `files` (or vice versa)
 * preserves the stored counterpart.
 */
export const WhiteboardPayloadSchema = z
  .object({
    scene: ExcalidrawSceneSchema,
    files: z.record(ExcalidrawFileEntrySchema),
  })
  .strict();
export type WhiteboardPayload = z.infer<typeof WhiteboardPayloadSchema>;
