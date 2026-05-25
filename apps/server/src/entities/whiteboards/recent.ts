import type { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import { createRequireLayer } from '../../http/middleware/layer';
import type { HonoVariables } from '../../http/types';

/**
 * Phase 11.4 — recent-whiteboards endpoint for the dashboard widget.
 *
 * The generic §4.0 list endpoint (`GET /l/:slug/<kind>`) returns
 * `EntitySummary[]`, which lacks two whiteboard-specific fields the
 * widget needs:
 *  - `thumbnail_blob` — the PNG bytes the web build will render in
 *    11.5 via `exportToBlob` and POST alongside the scene. The widget
 *    renders this inline as `<img src="data:image/png;base64,…">`,
 *    falling back to a placeholder glyph when the column is NULL
 *    (which is the dominant case in 11.4 — no whiteboards have been
 *    edited yet, so every row's blob will be NULL).
 *  - `updated_by` — surfaced for the "edited by …" line on each row.
 *
 * `EntitySummary` cannot carry the BLOB (it lives on the per-kind
 * row, not the payload) and `EntityModule.summaryColumns` projections
 * only see the payload + audit fields — not the kind-specific columns.
 * So we expose a tiny dedicated endpoint that does ONE indexed read
 * against `(layer_id, updated_at DESC)`, base64-encodes the blob, and
 * returns the minimal shape the widget needs.
 *
 * The route lives at `/l/:slug/whiteboard/_recent?limit=N` — singular
 * `whiteboard` segment matches the §4.0 router naming convention; the
 * web client surfaces the friendlier plural `/l/:slug/whiteboards`
 * for the "view all" CTA (the actual page lands in 11.5).
 *
 * Auth: same `requireLayer` middleware chain as `/l/:slug/<kind>/_stats`
 * — visibility is enforced by `withEffectiveLayers` upstream, so a
 * non-member sees `404 errors.layer.notVisible` and never the bytes.
 *
 * Cap: `limit` is clamped to `[1, 20]` so the dashboard widget cannot
 * be used as a base64-blob exfiltration vector (each PNG is bounded
 * by the per-file cap from §11.5 but the row count must stay small).
 */

const NOT_VISIBLE = { error: 'errors.layer.notVisible' } as const;
const BAD_REQUEST = { error: 'errors.layer.badRequest' } as const;

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

export interface MountWhiteboardRecentRouteDeps {
  readonly db: Database;
}

export interface RecentWhiteboardItem {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
  /** Base64-encoded PNG bytes, or `null` when no thumbnail has been
   * rendered yet (i.e. the whiteboard has never been edited from the
   * 11.5 web UI). */
  readonly thumbnailBlobBase64: string | null;
}

interface RecentWhiteboardRow {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly updated_at: string;
  readonly updated_by: string;
  readonly thumbnail_blob: Uint8Array | null;
}

/**
 * Mounts `GET /l/:slug/whiteboard/_recent?limit=N`.
 *
 * Returns `{ items: RecentWhiteboardItem[] }`. Soft-deleted rows are
 * excluded. Rows ordered newest-first by `updated_at`.
 */
export function mountWhiteboardRecentRoute(
  app: Hono<{ Variables: HonoVariables }>,
  deps: MountWhiteboardRecentRouteDeps,
): void {
  const requireLayer = createRequireLayer();
  app.get('/l/:slug/whiteboard/_recent', requireLayer, (c) => {
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);

    const rawLimit = c.req.query('limit');
    let limit = DEFAULT_LIMIT;
    if (rawLimit !== undefined && rawLimit !== '') {
      const parsed = Number.parseInt(rawLimit, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return c.json(BAD_REQUEST, 400);
      }
      limit = Math.min(parsed, MAX_LIMIT);
    }

    const rows = deps.db
      .query<RecentWhiteboardRow, [string, number]>(
        `SELECT id, slug, title, updated_at, updated_by, thumbnail_blob
         FROM whiteboards
         WHERE layer_id = ? AND deleted_at IS NULL
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(layer.id, limit);

    const items: RecentWhiteboardItem[] = rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      thumbnailBlobBase64:
        row.thumbnail_blob === null ? null : Buffer.from(row.thumbnail_blob).toString('base64'),
    }));

    return c.json({ items });
  });
}
