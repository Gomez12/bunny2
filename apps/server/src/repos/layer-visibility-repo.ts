import type { Database } from 'bun:sqlite';
import type { LayerVisibilityDirection } from '@bunny2/shared';

/**
 * Persisted layer visibility edge, mirroring `layer_visibility_edges`
 * in 0003_layers.sql. Cycle detection lives in the route handler (3.4),
 * not here — this repo is pure data access.
 */
export interface LayerVisibilityEdge {
  readonly parentLayerId: string;
  readonly childLayerId: string;
  readonly direction: LayerVisibilityDirection;
  readonly createdAt: string;
}

interface EdgeRow {
  parent_layer_id: string;
  child_layer_id: string;
  direction: LayerVisibilityDirection;
  created_at: string;
}

export interface AddEdgeInput {
  readonly parentLayerId: string;
  readonly childLayerId: string;
  readonly direction: LayerVisibilityDirection;
  readonly now: string;
}

export interface LayerVisibilityRepo {
  addEdge(input: AddEdgeInput): void;
  removeEdge(parentLayerId: string, childLayerId: string): void;
  listEdgesForChild(childLayerId: string): LayerVisibilityEdge[];
  listEdgesForParent(parentLayerId: string): LayerVisibilityEdge[];
}

function rowToEdge(row: EdgeRow): LayerVisibilityEdge {
  return {
    parentLayerId: row.parent_layer_id,
    childLayerId: row.child_layer_id,
    direction: row.direction,
    createdAt: row.created_at,
  };
}

export function createLayerVisibilityRepo(db: Database): LayerVisibilityRepo {
  const insert = db.query<unknown, [string, string, LayerVisibilityDirection, string]>(
    `INSERT INTO layer_visibility_edges
       (parent_layer_id, child_layer_id, direction, created_at)
     VALUES (?, ?, ?, ?)`,
  );

  const remove = db.query<unknown, [string, string]>(
    `DELETE FROM layer_visibility_edges
      WHERE parent_layer_id = ? AND child_layer_id = ?`,
  );

  const listByChild = db.query<EdgeRow, [string]>(
    `SELECT parent_layer_id, child_layer_id, direction, created_at
       FROM layer_visibility_edges
      WHERE child_layer_id = ?`,
  );

  const listByParent = db.query<EdgeRow, [string]>(
    `SELECT parent_layer_id, child_layer_id, direction, created_at
       FROM layer_visibility_edges
      WHERE parent_layer_id = ?`,
  );

  return {
    addEdge(input) {
      if (input.parentLayerId === input.childLayerId) {
        // Match `groups-repo`'s message style for the equivalent guard.
        throw new Error(
          `layer-visibility-repo: refusing to add edge from layer ${input.parentLayerId} to itself`,
        );
      }
      insert.run(input.parentLayerId, input.childLayerId, input.direction, input.now);
    },
    removeEdge(parentLayerId, childLayerId) {
      remove.run(parentLayerId, childLayerId);
    },
    listEdgesForChild(childLayerId) {
      return listByChild.all(childLayerId).map(rowToEdge);
    },
    listEdgesForParent(parentLayerId) {
      return listByParent.all(parentLayerId).map(rowToEdge);
    },
  };
}
