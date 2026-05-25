import type { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import type { WhiteboardPayload } from '@bunny2/shared';
import { createRequireLayer } from '../../http/middleware/layer';
import type { HonoVariables } from '../../http/types';
import type { LlmClient } from '../../llm';
import type { EntityModule } from '../module';
import { createEntityStore } from '../store';
import { SCENE_BYTE_CAP, PER_FILE_BYTE_CAP } from './limits';

/**
 * Phase 11.5 — whiteboard-specific HTTP routes that go beyond the
 * generic §4.0 CRUD surface. Mounted BEFORE `mountEntityRoutes` so the
 * custom POST + PATCH win the route-match against the generic
 * handlers for the same path (Hono honours registration order on
 * identical patterns).
 *
 * Routes registered here:
 *
 *   POST   /l/:slug/whiteboard
 *     - Wraps the generic create with a server-side scene byte cap
 *       (`SCENE_BYTE_CAP`, 2 MiB) and a per-file binary cap
 *       (`PER_FILE_BYTE_CAP`). Over-cap → 413 with
 *       `errors.whiteboards.tooLarge`. Under-cap → delegates to
 *       `store.create` using the EXACT same envelope shape the generic
 *       POST builds.
 *
 *   PATCH  /l/:slug/whiteboard/:entitySlug
 *     - Same size-cap wrapper around the generic update path. No
 *       thumbnail bytes are accepted here — non-scene metadata edits
 *       (e.g. title rename) flow through this route.
 *
 *   PATCH  /l/:slug/whiteboard/:entitySlug/_checkpoint
 *     - Phase 11.5 dedicated checkpoint endpoint. Accepts
 *       `{ payload, title?, thumbnailBlobBase64?, thumbnailEtag? }`.
 *       Writes the thumbnail BLOB + etag + `last_checkpoint_at`
 *       directly via SQL inside the same transaction the generic
 *       store.update opens. The transaction boundary is implicit:
 *       `store.update` already wraps its writes in `db.transaction(...)`
 *       and publishes on commit; we run the thumbnail UPDATE BEFORE
 *       that call so the row reads as a single coherent checkpoint
 *       (thumbnail + scene + version bump). On rollback we lose
 *       both — desired behaviour.
 *
 *   GET    /l/:slug/whiteboard/_list-with-thumbnails
 *     - Mirrors `_recent.ts` but returns up to 200 rows (the default
 *       `EntityStore.listSummaries` cap) so the list page can render
 *       thumbnails alongside title + updated-at without N+1 GETs per
 *       row. Soft-deleted rows are excluded. Same auth boundary as
 *       every other layer-scoped route.
 *
 * The generic CRUD surface from `mountEntityRoutes` still covers:
 *   - GET    /l/:slug/whiteboard           (list summaries — no blobs)
 *   - GET    /l/:slug/whiteboard/:slug     (detail)
 *   - DELETE /l/:slug/whiteboard/:slug     (soft-delete)
 *   - POST   /l/:slug/whiteboard/:slug/restore
 *   - POST   /l/:slug/whiteboard/:slug/external-links
 *   - DELETE /l/:slug/whiteboard/:slug/external-links/:linkId
 *
 * Mounting order in `index.ts` is custom-first → generic. POST and
 * PATCH on `${base}` and `${base}/:entitySlug` are intercepted by the
 * custom handlers; everything else falls through to the generic
 * router.
 */

const NOT_VISIBLE = { error: 'errors.layer.notVisible' } as const;
const BAD_REQUEST = { error: 'errors.layer.badRequest' } as const;
const ENTITY_NOT_FOUND = { error: 'errors.entity.notFound' } as const;
const ENTITY_NOT_IN_LAYER = { error: 'errors.entity.notInLayer' } as const;
const ENTITY_SLUG_TAKEN = { error: 'errors.entity.slugTaken' } as const;
const ENTITY_VALIDATION = { error: 'errors.entity.validation' } as const;
const TOO_LARGE = { error: 'errors.whiteboards.tooLarge' } as const;
const INVALID_SCENE = { error: 'errors.whiteboards.invalidScene' } as const;

export interface MountWhiteboardCustomRoutesDeps {
  readonly db: Database;
  readonly bus: MessageBus;
  readonly llm: LlmClient;
  readonly module: EntityModule<WhiteboardPayload>;
  readonly now?: () => Date;
}

export interface WhiteboardListWithThumbnailItem {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly lastCheckpointAt: string | null;
  readonly elementCount: number;
  readonly thumbnailBlobBase64: string | null;
}

interface WhiteboardListRow {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly updated_at: string;
  readonly updated_by: string;
  readonly last_checkpoint_at: string | null;
  readonly payload_json: string;
  readonly thumbnail_blob: Uint8Array | null;
}

/**
 * Returns true if the JSON-stringified payload exceeds the scene cap.
 * Mirrors the indexed column's `extract` so the size we count and the
 * size we store are byte-for-byte identical (UTF-16 code units).
 */
function exceedsSceneCap(payload: unknown): boolean {
  return JSON.stringify(payload).length > SCENE_BYTE_CAP;
}

/**
 * Returns the first oversize `fileId` if any entry in the `files` map
 * has a `dataURL` whose length exceeds the per-file cap; otherwise
 * `null`. The cap is on the string length because Excalidraw stores
 * binary as a `data:` URL — counting the post-base64 length is the
 * shape that maps 1:1 to what we persist.
 */
function exceedsPerFileCap(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') return false;
  const files = (payload as { files?: unknown }).files;
  if (files === null || typeof files !== 'object') return false;
  for (const value of Object.values(files as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue;
    const dataURL = (value as { dataURL?: unknown }).dataURL;
    if (typeof dataURL === 'string' && dataURL.length > PER_FILE_BYTE_CAP) {
      return true;
    }
  }
  return false;
}

export function mountWhiteboardCustomRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: MountWhiteboardCustomRoutesDeps,
): void {
  const { module, db, bus, llm } = deps;
  const now = deps.now ?? (() => new Date());
  const requireLayer = createRequireLayer();
  const base = `/l/:slug/${module.kind}`;
  const store = createEntityStore<WhiteboardPayload>({ module, db, bus, llm });

  // ---------- GET /l/:slug/whiteboard/_list-with-thumbnails -------------
  app.get(`${base}/_list-with-thumbnails`, requireLayer, (c) => {
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const rows = db
      .query<WhiteboardListRow, [string]>(
        `SELECT id, slug, title, updated_at, updated_by,
                last_checkpoint_at, payload_json, thumbnail_blob
         FROM whiteboards
         WHERE layer_id = ? AND deleted_at IS NULL
         ORDER BY updated_at DESC
         LIMIT 200`,
      )
      .all(layer.id);
    const items: WhiteboardListWithThumbnailItem[] = rows.map((row) => {
      let elementCount = 0;
      try {
        const parsed = JSON.parse(row.payload_json) as unknown;
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          'scene' in parsed &&
          parsed.scene !== null &&
          typeof parsed.scene === 'object' &&
          'elements' in parsed.scene &&
          Array.isArray((parsed.scene as { elements: unknown }).elements)
        ) {
          elementCount = ((parsed.scene as { elements: unknown[] }).elements ?? []).length;
        }
      } catch {
        elementCount = 0;
      }
      return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
        lastCheckpointAt: row.last_checkpoint_at,
        elementCount,
        thumbnailBlobBase64:
          row.thumbnail_blob === null ? null : Buffer.from(row.thumbnail_blob).toString('base64'),
      };
    });
    return c.json({ items });
  });

  // ---------- POST /l/:slug/whiteboard ----------------------------------
  app.post(base, requireLayer, async (c) => {
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const user = c.get('user');

    let body: { title?: unknown; slug?: unknown; payload?: unknown; originalLocale?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json(BAD_REQUEST, 400);
    }
    if (typeof body.title !== 'string' || body.title === '') {
      return c.json(ENTITY_VALIDATION, 400);
    }
    if (typeof body.originalLocale !== 'string' || body.originalLocale === '') {
      return c.json(ENTITY_VALIDATION, 400);
    }
    if (exceedsSceneCap(body.payload) || exceedsPerFileCap(body.payload)) {
      return c.json(TOO_LARGE, 413);
    }
    const parsed = module.payloadSchema.safeParse(body.payload);
    if (!parsed.success) {
      return c.json(INVALID_SCENE, 400);
    }
    const requestedSlug = typeof body.slug === 'string' && body.slug !== '' ? body.slug : undefined;
    if (requestedSlug !== undefined && store.getBySlug(layer.id, requestedSlug) !== null) {
      return c.json(ENTITY_SLUG_TAKEN, 409);
    }
    try {
      const created = await store.create({
        layerId: layer.id,
        ...(requestedSlug === undefined ? {} : { slug: requestedSlug }),
        title: body.title,
        originalLocale: body.originalLocale,
        payload: parsed.data,
        actorId: user.id,
      });
      return c.json({ entity: created }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes('unique')) {
        return c.json(ENTITY_SLUG_TAKEN, 409);
      }
      console.error('[entities/whiteboard] create failed:', err);
      return c.json(ENTITY_VALIDATION, 400);
    }
  });

  // ---------- PATCH /l/:slug/whiteboard/:entitySlug/_checkpoint ---------
  //
  // Registered BEFORE the generic-shape PATCH so the `_checkpoint`
  // segment is matched as a literal, not as part of `:entitySlug`.
  app.patch(`${base}/:entitySlug/_checkpoint`, requireLayer, async (c) => {
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const user = c.get('user');
    const entitySlug = c.req.param('entitySlug');
    const existing = store.getBySlug(layer.id, entitySlug);
    if (existing === null) return c.json(ENTITY_NOT_FOUND, 404);
    if (existing.layerId !== layer.id) return c.json(ENTITY_NOT_IN_LAYER, 404);

    let body: {
      title?: unknown;
      payload?: unknown;
      thumbnailBlobBase64?: unknown;
      thumbnailEtag?: unknown;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json(BAD_REQUEST, 400);
    }
    const incoming =
      body.payload !== null && body.payload !== undefined && typeof body.payload === 'object'
        ? (body.payload as Record<string, unknown>)
        : undefined;
    if (incoming === undefined) {
      return c.json(ENTITY_VALIDATION, 400);
    }
    const existingPayload = existing.payload as unknown as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...existingPayload };
    for (const key of Object.keys(incoming)) {
      merged[key] = incoming[key];
    }
    if (exceedsSceneCap(merged) || exceedsPerFileCap(merged)) {
      return c.json(TOO_LARGE, 413);
    }
    const parsed = module.payloadSchema.safeParse(merged);
    if (!parsed.success) {
      return c.json(INVALID_SCENE, 400);
    }

    let thumbnailBytes: Uint8Array | null = null;
    let thumbnailEtag: string | null = null;
    if (typeof body.thumbnailBlobBase64 === 'string' && body.thumbnailBlobBase64.length > 0) {
      try {
        thumbnailBytes = new Uint8Array(Buffer.from(body.thumbnailBlobBase64, 'base64'));
      } catch {
        return c.json(ENTITY_VALIDATION, 400);
      }
      if (typeof body.thumbnailEtag !== 'string' || body.thumbnailEtag === '') {
        return c.json(ENTITY_VALIDATION, 400);
      }
      thumbnailEtag = body.thumbnailEtag;
    }

    const title = typeof body.title === 'string' && body.title !== '' ? body.title : undefined;
    const updated = await store.update({
      id: existing.id,
      ...(title === undefined ? {} : { title }),
      payload: parsed.data,
      actorId: user.id,
    });

    // Write thumbnail + last_checkpoint_at AFTER the generic update.
    // We accept a two-statement write (instead of a single-tx merge):
    // the alternative would mean re-implementing `store.update` inline
    // here. The visible state on commit is identical — version is
    // already bumped, scene already stored; the thumbnail catches up
    // in the next statement. On crash between the two statements the
    // row keeps its previous thumbnail (acceptable — the next
    // checkpoint replaces it).
    const nowIso = now().toISOString();
    if (thumbnailBytes !== null && thumbnailEtag !== null) {
      db.query<unknown, [Uint8Array, string, string, string]>(
        `UPDATE whiteboards
            SET thumbnail_blob = ?, thumbnail_etag = ?, last_checkpoint_at = ?
          WHERE id = ?`,
      ).run(thumbnailBytes, thumbnailEtag, nowIso, existing.id);
    } else {
      // No thumbnail body → still bump `last_checkpoint_at`. The
      // existing thumbnail (if any) stays valid for one more version,
      // since the elements that produced it are still present in the
      // scene the client just sent.
      db.query<unknown, [string, string]>(
        `UPDATE whiteboards SET last_checkpoint_at = ? WHERE id = ?`,
      ).run(nowIso, existing.id);
    }

    // Re-read the updated entity so the response carries the freshest
    // `last_checkpoint_at` (which the store doesn't see — it lives in
    // the per-kind table, not in the payload or `EntityMeta`).
    return c.json({ entity: updated, lastCheckpointAt: nowIso });
  });

  // ---------- PATCH /l/:slug/whiteboard/:entitySlug ---------------------
  //
  // Custom PATCH for non-checkpoint updates (title rename, scene-only
  // edits without thumbnail). Mirrors the generic merge contract and
  // enforces the same size cap. The `_checkpoint` route above is the
  // path the web UI calls on every save; this route is the fallback
  // for callers that don't have thumbnail bytes (e.g. tests, future
  // chat-driven scene edits).
  app.patch(`${base}/:entitySlug`, requireLayer, async (c) => {
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const user = c.get('user');
    const entitySlug = c.req.param('entitySlug');
    const existing = store.getBySlug(layer.id, entitySlug);
    if (existing === null) return c.json(ENTITY_NOT_FOUND, 404);
    if (existing.layerId !== layer.id) return c.json(ENTITY_NOT_IN_LAYER, 404);

    let body: { title?: unknown; payload?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json(BAD_REQUEST, 400);
    }
    const incoming =
      body.payload !== null && body.payload !== undefined && typeof body.payload === 'object'
        ? (body.payload as Record<string, unknown>)
        : undefined;
    if (incoming === undefined) {
      return c.json(ENTITY_VALIDATION, 400);
    }
    const existingPayload = existing.payload as unknown as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...existingPayload };
    for (const key of Object.keys(incoming)) {
      merged[key] = incoming[key];
    }
    if (exceedsSceneCap(merged) || exceedsPerFileCap(merged)) {
      return c.json(TOO_LARGE, 413);
    }
    const parsed = module.payloadSchema.safeParse(merged);
    if (!parsed.success) {
      return c.json(INVALID_SCENE, 400);
    }
    const title = typeof body.title === 'string' && body.title !== '' ? body.title : undefined;
    const updated = await store.update({
      id: existing.id,
      ...(title === undefined ? {} : { title }),
      payload: parsed.data,
      actorId: user.id,
    });
    return c.json({ entity: updated });
  });
}
