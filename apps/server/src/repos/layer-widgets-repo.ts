import type { Database } from 'bun:sqlite';

/**
 * Persisted dashboard widget, mirroring `layer_dashboard_widgets` in
 * 0003_layers.sql. Widget kinds and layout payloads are stubs in v1
 * (plan §2); this repo just persists what the caller hands in.
 */
export interface LayerDashboardWidget {
  readonly id: string;
  readonly layerId: string;
  readonly widgetKind: string;
  readonly position: number;
  readonly layout: Record<string, unknown>;
  readonly createdAt: string;
}

interface WidgetRow {
  id: string;
  layer_id: string;
  widget_kind: string;
  position: number;
  layout_json: string;
  created_at: string;
}

export interface InsertWidgetInput {
  readonly id: string;
  readonly layerId: string;
  readonly widgetKind: string;
  readonly position: number;
  readonly layout?: Record<string, unknown>;
  readonly now: string;
}

export interface LayerWidgetsRepo {
  insertWidget(input: InsertWidgetInput): LayerDashboardWidget;
  /** Idempotent: removing a missing widget is a no-op. */
  removeWidget(id: string): void;
  listWidgets(layerId: string): LayerDashboardWidget[];
  moveWidget(id: string, position: number): void;
}

function rowToWidget(row: WidgetRow): LayerDashboardWidget {
  let layout: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.layout_json) as unknown;
    layout =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    layout = {};
  }
  return {
    id: row.id,
    layerId: row.layer_id,
    widgetKind: row.widget_kind,
    position: row.position,
    layout,
    createdAt: row.created_at,
  };
}

const SELECT_COLS = 'id, layer_id, widget_kind, position, layout_json, created_at';

export function createLayerWidgetsRepo(db: Database): LayerWidgetsRepo {
  const insert = db.query<unknown, [string, string, string, number, string, string]>(
    `INSERT INTO layer_dashboard_widgets
       (id, layer_id, widget_kind, position, layout_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const findById = db.query<WidgetRow, [string]>(
    `SELECT ${SELECT_COLS} FROM layer_dashboard_widgets WHERE id = ?`,
  );

  const remove = db.query<unknown, [string]>(`DELETE FROM layer_dashboard_widgets WHERE id = ?`);

  const list = db.query<WidgetRow, [string]>(
    `SELECT ${SELECT_COLS} FROM layer_dashboard_widgets
      WHERE layer_id = ?
      ORDER BY position, created_at`,
  );

  const move = db.query<unknown, [number, string]>(
    `UPDATE layer_dashboard_widgets SET position = ? WHERE id = ?`,
  );

  return {
    insertWidget(input) {
      const layoutJson = JSON.stringify(input.layout ?? {});
      insert.run(input.id, input.layerId, input.widgetKind, input.position, layoutJson, input.now);
      const row = findById.get(input.id);
      if (row === null) {
        throw new Error(`layer-widgets-repo: failed to read back widget ${input.id} after insert`);
      }
      return rowToWidget(row);
    },
    removeWidget(id) {
      remove.run(id);
    },
    listWidgets(layerId) {
      return list.all(layerId).map(rowToWidget);
    },
    moveWidget(id, position) {
      move.run(position, id);
    },
  };
}
