import type { WhiteboardPayload } from '@bunny2/shared';
import type { EntityConnector } from '../../connectors/base';
import { WHITEBOARD_KIND } from '../module';

/**
 * Phase 11.2 — whiteboard connector placeholder.
 *
 * v1 ships NO real whiteboard connector. Future imports (Miro export
 * JSON, tldraw `.tldr`, raw `.excalidraw` file upload) will land
 * additively in their own sub-phases. This placeholder exists so the
 * `connectors` registry slot is exercised end-to-end (factory →
 * registry → `listConnectorsForKind`) without committing to a real
 * implementation.
 *
 * Shape rules (mirrors the kvk / vCard / Google-Calendar precedent):
 *  - `id` is stable and namespaced so the future "Miro" / "tldraw" /
 *    "excalidraw-file" connectors can coexist without colliding on
 *    `entity_external_links.connector` values.
 *  - `kind` is the whiteboard module's `WHITEBOARD_KIND` literal so
 *    the registry's `rebuildConnectorIndex` files the placeholder
 *    under the right bucket.
 *  - `verify(config)` returns the canonical i18n error key the
 *    dispatcher already uses when an attachment is missing
 *    (`errors.connectors.notConfigured`). The placeholder ALWAYS
 *    refuses configuration in v1 — there is no real config schema to
 *    validate against yet. Returning the same key the dispatcher
 *    would emit on a missing attachment keeps the user-facing surface
 *    consistent across "no attachment yet" and "attachment refused".
 *  - No `pull` / `push` / `ingest` is implemented. The dispatcher's
 *    existing fallbacks handle both cases:
 *      - missing `pull` → `errors.connectors.pullNotSupported`.
 *      - missing `ingest` → the HTTP ingest route returns its
 *        standard 4xx error.
 *    Per plan §11.2 this is intentional: "registry slot only; future
 *    Miro/tldraw/.excalidraw import lands additively".
 *
 * Production wiring (`buildProductionWhiteboardModule` in
 * `../index.ts`) does NOT pass this placeholder into the production
 * module — the production `connectors` field stays `undefined` so the
 * registry's `rebuildConnectorIndex` leaves the `whiteboard` bucket
 * absent. Tests that want to assert the slot is correctly threaded
 * inject the placeholder explicitly via
 * `createWhiteboardModule({ connectors: [whiteboardPlaceholderConnector] })`.
 */
export const WHITEBOARD_PLACEHOLDER_CONNECTOR_ID = 'whiteboard.placeholder';

/**
 * The canonical i18n key used by both the dispatcher (when no
 * attachment exists for a connector) and this placeholder's
 * `verify(...)`. Kept as a named export so the test can assert
 * against the same constant rather than a stringly-typed literal —
 * regression-proofs the wiring if the key ever moves.
 */
export const WHITEBOARD_PLACEHOLDER_NOT_CONFIGURED_KEY = 'errors.connectors.notConfigured';

export const whiteboardPlaceholderConnector: EntityConnector<WhiteboardPayload> = {
  id: WHITEBOARD_PLACEHOLDER_CONNECTOR_ID,
  kind: WHITEBOARD_KIND,
  async verify(_config) {
    // v1 has no real config schema and no upstream system. Every
    // attachment attempt is refused with the same i18n key the
    // dispatcher uses for a missing attachment, so the user-facing
    // surface stays consistent.
    return WHITEBOARD_PLACEHOLDER_NOT_CONFIGURED_KEY;
  },
};
