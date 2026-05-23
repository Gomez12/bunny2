import type { Database } from 'bun:sqlite';

/**
 * Persisted group row, mirroring `groups` in 0002_users_groups.sql.
 */
export interface Group {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly version: number;
}

interface GroupRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
}

export interface CreateGroupInput {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly now: string;
}

export interface UpdateGroupPatch {
  readonly slug?: string;
  readonly name?: string;
  readonly description?: string | null;
}

export interface ListGroupsOptions {
  readonly includeDeleted?: boolean;
}

export interface DirectUserMembership {
  readonly groupId: string;
  readonly createdAt: string;
}

export interface DirectGroupChild {
  readonly childGroupId: string;
  readonly createdAt: string;
}

export interface GroupsRepo {
  createGroup(input: CreateGroupInput): Group;
  findGroupById(id: string): Group | null;
  findGroupBySlug(slug: string): Group | null;
  listGroups(opts?: ListGroupsOptions): Group[];
  updateGroup(id: string, patch: UpdateGroupPatch, now: string): Group;
  softDeleteGroup(id: string, now: string): void;
  /** Idempotent: re-adding an existing user-group edge is a no-op. */
  addUserToGroup(userId: string, groupId: string, now: string): void;
  removeUserFromGroup(userId: string, groupId: string): void;
  /**
   * Pure insert. Throws if `parentId === childId`. Cycle prevention beyond
   * direct self-reference is handled by a service module introduced in 2.4,
   * which will resolve the transitive expansion via a recursive CTE before
   * accepting an edge.
   */
  addGroupToGroup(parentId: string, childId: string, now: string): void;
  removeGroupFromGroup(parentId: string, childId: string): void;
  listDirectUserMemberships(userId: string): DirectUserMembership[];
  listDirectGroupChildren(parentId: string): DirectGroupChild[];
  /** Count of groups that are not soft-deleted. Used by `/status.auth`. */
  countActive(): number;
}

function rowToGroup(row: GroupRow): Group {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    version: row.version,
  };
}

export function createGroupsRepo(db: Database): GroupsRepo {
  const insert = db.query<unknown, [string, string, string, string | null, string, string]>(
    `INSERT INTO groups (id, slug, name, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const findById = db.query<GroupRow, [string]>(
    `SELECT id, slug, name, description, created_at, updated_at, deleted_at, version
       FROM groups WHERE id = ?`,
  );

  const findBySlug = db.query<GroupRow, [string]>(
    `SELECT id, slug, name, description, created_at, updated_at, deleted_at, version
       FROM groups WHERE slug = ?`,
  );

  const listAll = db.query<GroupRow, []>(
    `SELECT id, slug, name, description, created_at, updated_at, deleted_at, version
       FROM groups ORDER BY slug`,
  );

  const listActive = db.query<GroupRow, []>(
    `SELECT id, slug, name, description, created_at, updated_at, deleted_at, version
       FROM groups WHERE deleted_at IS NULL ORDER BY slug`,
  );

  const softDelete = db.query<unknown, [string, string, string]>(
    `UPDATE groups
        SET deleted_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND deleted_at IS NULL`,
  );

  const addUser = db.query<unknown, [string, string, string]>(
    `INSERT OR IGNORE INTO user_group_memberships (user_id, group_id, created_at)
     VALUES (?, ?, ?)`,
  );

  const removeUser = db.query<unknown, [string, string]>(
    `DELETE FROM user_group_memberships WHERE user_id = ? AND group_id = ?`,
  );

  const addChildGroup = db.query<unknown, [string, string, string]>(
    `INSERT INTO group_group_memberships (parent_group_id, child_group_id, created_at)
     VALUES (?, ?, ?)`,
  );

  const removeChildGroup = db.query<unknown, [string, string]>(
    `DELETE FROM group_group_memberships WHERE parent_group_id = ? AND child_group_id = ?`,
  );

  const listUserMemberships = db.query<{ group_id: string; created_at: string }, [string]>(
    `SELECT group_id, created_at FROM user_group_memberships WHERE user_id = ?`,
  );

  const listGroupChildren = db.query<{ child_group_id: string; created_at: string }, [string]>(
    `SELECT child_group_id, created_at FROM group_group_memberships WHERE parent_group_id = ?`,
  );

  const countActiveStmt = db.query<{ n: number }, []>(
    'SELECT COUNT(*) AS n FROM groups WHERE deleted_at IS NULL',
  );

  return {
    createGroup(input) {
      insert.run(input.id, input.slug, input.name, input.description ?? null, input.now, input.now);
      const row = findById.get(input.id);
      if (row === null) {
        throw new Error(`groups-repo: failed to read back group ${input.id} after insert`);
      }
      return rowToGroup(row);
    },
    findGroupById(id) {
      const row = findById.get(id);
      return row === null ? null : rowToGroup(row);
    },
    findGroupBySlug(slug) {
      const row = findBySlug.get(slug);
      return row === null ? null : rowToGroup(row);
    },
    listGroups(opts = {}) {
      const stmt = opts.includeDeleted === true ? listAll : listActive;
      return stmt.all().map(rowToGroup);
    },
    updateGroup(id, patch, now) {
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      if (patch.slug !== undefined) {
        sets.push('slug = ?');
        params.push(patch.slug);
      }
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
          throw new Error(`groups-repo: group ${id} not found`);
        }
        return rowToGroup(existing);
      }
      sets.push('updated_at = ?');
      params.push(now);
      sets.push('version = version + 1');
      const sql = `UPDATE groups SET ${sets.join(', ')} WHERE id = ?`;
      params.push(id);
      db.query<unknown, typeof params>(sql).run(...params);
      const row = findById.get(id);
      if (row === null) {
        throw new Error(`groups-repo: group ${id} not found after update`);
      }
      return rowToGroup(row);
    },
    softDeleteGroup(id, now) {
      softDelete.run(now, now, id);
    },
    addUserToGroup(userId, groupId, now) {
      addUser.run(userId, groupId, now);
    },
    removeUserFromGroup(userId, groupId) {
      removeUser.run(userId, groupId);
    },
    addGroupToGroup(parentId, childId, now) {
      if (parentId === childId) {
        throw new Error(`groups-repo: refusing to add group ${parentId} as a member of itself`);
      }
      addChildGroup.run(parentId, childId, now);
    },
    removeGroupFromGroup(parentId, childId) {
      removeChildGroup.run(parentId, childId);
    },
    listDirectUserMemberships(userId) {
      return listUserMemberships
        .all(userId)
        .map((r) => ({ groupId: r.group_id, createdAt: r.created_at }));
    },
    listDirectGroupChildren(parentId) {
      return listGroupChildren
        .all(parentId)
        .map((r) => ({ childGroupId: r.child_group_id, createdAt: r.created_at }));
    },
    countActive() {
      return countActiveStmt.get()?.n ?? 0;
    },
  };
}
