import type { Database } from 'bun:sqlite';
import type { Hono } from 'hono';
import type { HonoVariables } from '../../http/types';
import { createRequireLayer } from '../../http/middleware/layer';
import { listTodoProjectionsForLayer, type TodoCalendarProjectionRow } from './calendar-projection';

/**
 * Phase 4d.6 — list endpoint for the todo → calendar projection bridge.
 *
 * Mounted at `GET /l/:slug/calendar/_projections/todos` — sits under
 * the `/calendar/` URL prefix even though the data is materialized
 * from `todos`, because the consumer is the calendar UI and the brief
 * picks "separate endpoint" over "extend the existing
 * /calendar_event list with a discriminator". See ADR 0017.
 *
 *   - Layer-scoped via `createRequireLayer` (the projection is
 *     layer-scoped just like its source todos).
 *   - Returns `{ items: TodoCalendarProjectionRow[] }` ordered by
 *     `due_at ASC, priority ASC, todo_slug ASC` for deterministic
 *     merging on the client.
 *   - Read-only — the projection cannot be edited via HTTP; the
 *     source todo is the canonical row. The web UI's click handler
 *     short-circuits to the todo detail page; the calendar event
 *     detail page is NEVER reached for projections.
 */
export interface MountTodoCalendarProjectionRoutesDeps {
  readonly db: Database;
}

const NOT_VISIBLE = { error: 'errors.layer.notVisible' } as const;

export function mountTodoCalendarProjectionRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: MountTodoCalendarProjectionRoutesDeps,
): void {
  const requireLayer = createRequireLayer();
  app.get('/l/:slug/calendar/_projections/todos', requireLayer, (c) => {
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const items: readonly TodoCalendarProjectionRow[] = listTodoProjectionsForLayer(
      deps.db,
      layer.id,
    );
    return c.json({ items });
  });
}
