import type { Database } from 'bun:sqlite';
import type { LayerAttachmentKind } from '@bunny2/shared';

/**
 * Persisted layer attachment, mirroring `layer_attachments` in
 * 0003_layers.sql. `config` is stored as JSON TEXT and parsed on read.
 * Consumers (phase 7) interpret `config` per `kind`; this repo treats
 * it as opaque structured data.
 */
export interface LayerAttachment {
  readonly id: string;
  readonly layerId: string;
  readonly kind: LayerAttachmentKind;
  readonly refId: string;
  readonly config: Record<string, unknown>;
  readonly createdAt: string;
}

interface AttachmentRow {
  id: string;
  layer_id: string;
  kind: LayerAttachmentKind;
  ref_id: string;
  config_json: string;
  created_at: string;
}

export interface InsertAttachmentInput {
  readonly id: string;
  readonly layerId: string;
  readonly kind: LayerAttachmentKind;
  readonly refId: string;
  readonly config?: Record<string, unknown>;
  readonly now: string;
}

export interface UpdateAttachmentConfigInput {
  readonly id: string;
  readonly config: Record<string, unknown>;
}

export interface LayerAttachmentsRepo {
  insertAttachment(input: InsertAttachmentInput): LayerAttachment;
  /** Idempotent: removing a missing attachment is a no-op. */
  removeAttachment(id: string): void;
  listAttachments(layerId: string, kind?: LayerAttachmentKind): LayerAttachment[];
  /**
   * Phase 4c.2 — Google Calendar's incremental sync requires persisting
   * a per-attachment `syncToken` between polls. The connector calls
   * `updateAttachmentConfig` after a successful `events.list` to record
   * the new token (and any other non-secret state). Existing fields are
   * preserved — callers pass the full config object, NOT a delta. The
   * caller is responsible for keeping encrypted-envelope fields
   * untouched (re-passing the same envelope is idempotent).
   * Returns the row id when present; null when no row exists with that id.
   */
  updateAttachmentConfig(input: UpdateAttachmentConfigInput): string | null;
}

function rowToAttachment(row: AttachmentRow): LayerAttachment {
  let config: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.config_json) as unknown;
    config =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    config = {};
  }
  return {
    id: row.id,
    layerId: row.layer_id,
    kind: row.kind,
    refId: row.ref_id,
    config,
    createdAt: row.created_at,
  };
}

const SELECT_COLS = 'id, layer_id, kind, ref_id, config_json, created_at';

export function createLayerAttachmentsRepo(db: Database): LayerAttachmentsRepo {
  const insert = db.query<unknown, [string, string, LayerAttachmentKind, string, string, string]>(
    `INSERT INTO layer_attachments
       (id, layer_id, kind, ref_id, config_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const findById = db.query<AttachmentRow, [string]>(
    `SELECT ${SELECT_COLS} FROM layer_attachments WHERE id = ?`,
  );

  const remove = db.query<unknown, [string]>(`DELETE FROM layer_attachments WHERE id = ?`);

  const listAll = db.query<AttachmentRow, [string]>(
    `SELECT ${SELECT_COLS} FROM layer_attachments
      WHERE layer_id = ?
      ORDER BY created_at`,
  );

  const listByKind = db.query<AttachmentRow, [string, LayerAttachmentKind]>(
    `SELECT ${SELECT_COLS} FROM layer_attachments
      WHERE layer_id = ? AND kind = ?
      ORDER BY created_at`,
  );

  return {
    insertAttachment(input) {
      const configJson = JSON.stringify(input.config ?? {});
      insert.run(input.id, input.layerId, input.kind, input.refId, configJson, input.now);
      const row = findById.get(input.id);
      if (row === null) {
        throw new Error(
          `layer-attachments-repo: failed to read back attachment ${input.id} after insert`,
        );
      }
      return rowToAttachment(row);
    },
    removeAttachment(id) {
      remove.run(id);
    },
    listAttachments(layerId, kind) {
      const rows = kind === undefined ? listAll.all(layerId) : listByKind.all(layerId, kind);
      return rows.map(rowToAttachment);
    },
    updateAttachmentConfig(input) {
      const existing = findById.get(input.id);
      if (existing === null) return null;
      const configJson = JSON.stringify(input.config);
      db.query<unknown, [string, string]>(
        `UPDATE layer_attachments SET config_json = ? WHERE id = ?`,
      ).run(configJson, input.id);
      return input.id;
    },
  };
}
