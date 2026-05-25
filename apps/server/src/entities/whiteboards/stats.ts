import type { EntityStatsContext, EntityStatsProvider } from '../module';

/**
 * Phase 11.1 — pure-SQL aggregate provider stub for the whiteboards
 * dashboard widget (lands in 11.4). Fifth consumer of the §4a.4
 * `EntityModule.statsProvider` slot; mirrors the cadence of the
 * companies / contacts / calendar / todos precedents so the
 * foundation absorbs the new widget with ZERO contract changes.
 *
 * Returns three counts. Every counter excludes soft-deleted rows
 * (`deleted_at IS NULL`) and reads the indexed `last_checkpoint_at`
 * column the 0021 migration added — single-table scans against
 * indexed columns.
 *
 *  - `total`              — non-deleted whiteboards in the layer.
 *  - `checkpointed`       — non-deleted whiteboards that have at
 *                           least one explicit "Save version"
 *                           checkpoint (`last_checkpoint_at IS NOT
 *                           NULL`). The 11.5 PATCH flow stamps this
 *                           column; until then every row has it
 *                           `NULL`, so `checkpointed` is 0 in 11.1.
 *  - `totalSceneByteSize` — sum of `scene_byte_size` across non-deleted
 *                           rows. Useful for the §7 "large files blow
 *                           row size" mitigation: surface the total
 *                           bytes per layer so the widget can warn
 *                           before the per-file cap triggers a save
 *                           failure.
 *
 * No event-bus subscription, no live state — every call is a fresh
 * read. `ctx.now` is unused in 11.1 (no time-window stats) but is
 * carried through the signature to match the companies / contacts /
 * calendar / todos precedent.
 */
export interface WhiteboardStats {
  readonly total: number;
  readonly checkpointed: number;
  readonly totalSceneByteSize: number;
}

export const whiteboardStatsProvider: EntityStatsProvider = {
  compute(ctx: EntityStatsContext): Record<string, unknown> {
    const totalRow = ctx.db
      .query<
        { n: number },
        [string]
      >(`SELECT COUNT(*) AS n FROM whiteboards WHERE layer_id = ? AND deleted_at IS NULL`)
      .get(ctx.layerId);
    const total = totalRow?.n ?? 0;

    const checkpointedRow = ctx.db
      .query<
        { n: number },
        [string]
      >(`SELECT COUNT(*) AS n FROM whiteboards WHERE layer_id = ? AND deleted_at IS NULL AND last_checkpoint_at IS NOT NULL`)
      .get(ctx.layerId);
    const checkpointed = checkpointedRow?.n ?? 0;

    // `COALESCE(SUM(...), 0)` because SQLite returns NULL for SUM
    // over zero rows, and the wire shape is `number`, not `number |
    // null`. The shared `WhiteboardStats` type encodes the invariant.
    const byteSizeRow = ctx.db
      .query<
        { total: number },
        [string]
      >(`SELECT COALESCE(SUM(scene_byte_size), 0) AS total FROM whiteboards WHERE layer_id = ? AND deleted_at IS NULL`)
      .get(ctx.layerId);
    const totalSceneByteSize = byteSizeRow?.total ?? 0;

    const result: WhiteboardStats = { total, checkpointed, totalSceneByteSize };
    return result as unknown as Record<string, unknown>;
  },
};
