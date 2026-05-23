import type { Database } from 'bun:sqlite';
import type { LayerType } from '@bunny2/shared';

/**
 * Persisted layer row, mirroring `layers` in 0003_layers.sql.
 */
export interface Layer {
  readonly id: string;
  readonly type: LayerType;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly ownerUserId: string | null;
  readonly ownerGroupId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly version: number;
}

interface LayerRow {
  id: string;
  type: LayerType;
  slug: string;
  name: string;
  description: string | null;
  owner_user_id: string | null;
  owner_group_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
}

export interface CreateLayerInput {
  readonly id: string;
  readonly type: LayerType;
  readonly slug: string;
  readonly name: string;
  readonly description?: string | null;
  readonly ownerUserId?: string | null;
  readonly ownerGroupId?: string | null;
  readonly now: string;
}

export interface UpdateLayerPatch {
  readonly name?: string;
  readonly description?: string | null;
}

export interface ListLayersOptions {
  readonly type?: LayerType;
  readonly includeDeleted?: boolean;
}

export interface LayersRepo {
  insertLayer(input: CreateLayerInput): Layer;
  getLayerById(id: string): Layer | null;
  getLayerBySlug(slug: string): Layer | null;
  listLayers(opts?: ListLayersOptions): Layer[];
  updateLayer(id: string, patch: UpdateLayerPatch, now: string): Layer;
  softDeleteLayer(id: string, now: string): void;
}

function rowToLayer(row: LayerRow): Layer {
  return {
    id: row.id,
    type: row.type,
    slug: row.slug,
    name: row.name,
    description: row.description,
    ownerUserId: row.owner_user_id,
    ownerGroupId: row.owner_group_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    version: row.version,
  };
}

const SELECT_COLS =
  'id, type, slug, name, description, owner_user_id, owner_group_id, ' +
  'created_at, updated_at, deleted_at, version';

export function createLayersRepo(db: Database): LayersRepo {
  const insert = db.query<
    unknown,
    [string, LayerType, string, string, string | null, string | null, string | null, string, string]
  >(
    `INSERT INTO layers
       (id, type, slug, name, description, owner_user_id, owner_group_id,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const findById = db.query<LayerRow, [string]>(`SELECT ${SELECT_COLS} FROM layers WHERE id = ?`);

  const findBySlug = db.query<LayerRow, [string]>(
    `SELECT ${SELECT_COLS} FROM layers WHERE slug = ?`,
  );

  const softDelete = db.query<unknown, [string, string, string]>(
    `UPDATE layers
        SET deleted_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND deleted_at IS NULL`,
  );

  return {
    insertLayer(input) {
      insert.run(
        input.id,
        input.type,
        input.slug,
        input.name,
        input.description ?? null,
        input.ownerUserId ?? null,
        input.ownerGroupId ?? null,
        input.now,
        input.now,
      );
      const row = findById.get(input.id);
      if (row === null) {
        throw new Error(`layers-repo: failed to read back layer ${input.id} after insert`);
      }
      return rowToLayer(row);
    },
    getLayerById(id) {
      const row = findById.get(id);
      return row === null ? null : rowToLayer(row);
    },
    getLayerBySlug(slug) {
      const row = findBySlug.get(slug);
      return row === null ? null : rowToLayer(row);
    },
    listLayers(opts = {}) {
      // Build SQL once per call — `db.query` caches by SQL string.
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (opts.includeDeleted !== true) {
        where.push('deleted_at IS NULL');
      }
      if (opts.type !== undefined) {
        where.push('type = ?');
        params.push(opts.type);
      }
      const whereSql = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;
      const sql = `SELECT ${SELECT_COLS} FROM layers${whereSql} ORDER BY slug`;
      const stmt = db.query<LayerRow, typeof params>(sql);
      return stmt.all(...params).map(rowToLayer);
    },
    updateLayer(id, patch, now) {
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      if (patch.name !== undefined) {
        sets.push('name = ?');
        params.push(patch.name);
      }
      if (patch.description !== undefined) {
        sets.push('description = ?');
        params.push(patch.description);
      }
      if (sets.length === 0) {
        const existing = findById.get(id);
        if (existing === null) {
          throw new Error(`layers-repo: layer ${id} not found`);
        }
        return rowToLayer(existing);
      }
      sets.push('updated_at = ?');
      params.push(now);
      sets.push('version = version + 1');
      const sql = `UPDATE layers SET ${sets.join(', ')} WHERE id = ?`;
      params.push(id);
      db.query<unknown, typeof params>(sql).run(...params);
      const row = findById.get(id);
      if (row === null) {
        throw new Error(`layers-repo: layer ${id} not found after update`);
      }
      return rowToLayer(row);
    },
    softDeleteLayer(id, now) {
      softDelete.run(now, now, id);
    },
  };
}
