import type { Database } from 'bun:sqlite';
import type { ArtifactKind } from '@bunny2/shared';

/**
 * Phase 7.2 — repository over `layer_capabilities`.
 *
 * Per-layer registry of activated tools / skills / agents (the phase-3
 * §invariant-4 attachment point, finally filled — ADR 0023 §1).
 *
 * - `(layer_id, kind, name)` is UNIQUE; the SQL constraint guards
 *   against double-registration. The repo surfaces the constraint
 *   error verbatim so call sites can handle "already registered"
 *   gracefully.
 * - Deactivation flips `deactivated_at` instead of deleting the row,
 *   so the activation history is preserved for audit (ADR 0023 §5).
 * - `spec_json` is opaque to the repo; phase 7.5 owns the per-kind
 *   spec shape via the shared `ProposalSpecSchema`.
 */

export interface LayerCapabilityRow {
  readonly id: string;
  readonly layerId: string;
  readonly kind: ArtifactKind;
  readonly name: string;
  readonly specJson: string;
  readonly origin: string;
  readonly activatedAt: string;
  readonly deactivatedAt: string | null;
}

interface SqlRow {
  id: string;
  layer_id: string;
  kind: ArtifactKind;
  name: string;
  spec_json: string;
  origin: string;
  activated_at: string;
  deactivated_at: string | null;
}

export interface InsertLayerCapabilityInput {
  readonly id: string;
  readonly layerId: string;
  readonly kind: ArtifactKind;
  readonly name: string;
  readonly specJson: string;
  readonly origin: string;
  readonly activatedAt: string;
}

export interface LayerCapabilitiesRepo {
  insertCapability(input: InsertLayerCapabilityInput): LayerCapabilityRow;
  /** Active rows only (`deactivated_at IS NULL`), in activation order. */
  listActiveByLayer(layerId: string): LayerCapabilityRow[];
  /** All rows for a layer, including deactivated ones. */
  listAllByLayer(layerId: string): LayerCapabilityRow[];
  /**
   * Phase 7.5 — active rows of a specific kind across every layer,
   * ordered by `(layer_id, name)` for boot re-attach determinism.
   * Used by `apps/server/src/index.ts` to re-subscribe every active
   * `agent` capability after restart.
   */
  listAllActiveByKind(kind: ArtifactKind): LayerCapabilityRow[];
  getByName(layerId: string, kind: ArtifactKind, name: string): LayerCapabilityRow | null;
  /**
   * Phase 7.6 — single-row fetch by id (used by the
   * `POST /l/:slug/capabilities/:id/deactivate` route to look up
   * `(kind, name)` for `capabilityRegistry.deactivate(...)`). The
   * route enforces `row.layerId === layer.id` for the cross-layer
   * 404 contract.
   */
  getById(id: string): LayerCapabilityRow | null;
  deactivate(id: string, now: string): void;
}

const COLS = 'id, layer_id, kind, name, spec_json, origin, activated_at, deactivated_at';

function rowToCapability(row: SqlRow): LayerCapabilityRow {
  return {
    id: row.id,
    layerId: row.layer_id,
    kind: row.kind,
    name: row.name,
    specJson: row.spec_json,
    origin: row.origin,
    activatedAt: row.activated_at,
    deactivatedAt: row.deactivated_at,
  };
}

export function createLayerCapabilitiesRepo(db: Database): LayerCapabilitiesRepo {
  const insert = db.query<unknown, [string, string, ArtifactKind, string, string, string, string]>(
    `INSERT INTO layer_capabilities
       (id, layer_id, kind, name, spec_json, origin, activated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const findById = db.query<SqlRow, [string]>(
    `SELECT ${COLS} FROM layer_capabilities WHERE id = ?`,
  );

  const listActive = db.query<SqlRow, [string]>(
    `SELECT ${COLS} FROM layer_capabilities
       WHERE layer_id = ? AND deactivated_at IS NULL
       ORDER BY activated_at ASC`,
  );

  const listAll = db.query<SqlRow, [string]>(
    `SELECT ${COLS} FROM layer_capabilities
       WHERE layer_id = ?
       ORDER BY activated_at ASC`,
  );

  const findByName = db.query<SqlRow, [string, ArtifactKind, string]>(
    `SELECT ${COLS} FROM layer_capabilities
       WHERE layer_id = ? AND kind = ? AND name = ?`,
  );

  const listActiveByKindStmt = db.query<SqlRow, [ArtifactKind]>(
    `SELECT ${COLS} FROM layer_capabilities
       WHERE kind = ? AND deactivated_at IS NULL
       ORDER BY layer_id ASC, name ASC`,
  );

  const deactivateStmt = db.query<unknown, [string, string]>(
    `UPDATE layer_capabilities
        SET deactivated_at = ?
      WHERE id = ? AND deactivated_at IS NULL`,
  );

  return {
    insertCapability(input) {
      insert.run(
        input.id,
        input.layerId,
        input.kind,
        input.name,
        input.specJson,
        input.origin,
        input.activatedAt,
      );
      const row = findById.get(input.id);
      if (row === null) {
        throw new Error(
          `layer-capabilities-repo: failed to read back capability ${input.id} after insert`,
        );
      }
      return rowToCapability(row);
    },

    listActiveByLayer(layerId) {
      return listActive.all(layerId).map(rowToCapability);
    },

    listAllByLayer(layerId) {
      return listAll.all(layerId).map(rowToCapability);
    },

    listAllActiveByKind(kind) {
      return listActiveByKindStmt.all(kind).map(rowToCapability);
    },

    getByName(layerId, kind, name) {
      const row = findByName.get(layerId, kind, name);
      return row === null ? null : rowToCapability(row);
    },

    getById(id) {
      const row = findById.get(id);
      return row === null ? null : rowToCapability(row);
    },

    deactivate(id, now) {
      deactivateStmt.run(now, id);
    },
  };
}
