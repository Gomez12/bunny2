import type { Database } from 'bun:sqlite';

/**
 * Membership rows for project layers (personal / group / everyone layers
 * derive membership from existing tables — see plan §2).
 */
export interface LayerUserMember {
  readonly layerId: string;
  readonly userId: string;
  readonly role: string;
  readonly createdAt: string;
}

export interface LayerGroupMember {
  readonly layerId: string;
  readonly groupId: string;
  readonly role: string;
  readonly createdAt: string;
}

interface UserMemberRow {
  layer_id: string;
  user_id: string;
  role: string;
  created_at: string;
}

interface GroupMemberRow {
  layer_id: string;
  group_id: string;
  role: string;
  created_at: string;
}

export interface AddUserMemberInput {
  readonly layerId: string;
  readonly userId: string;
  readonly role?: string;
  readonly now: string;
}

export interface AddGroupMemberInput {
  readonly layerId: string;
  readonly groupId: string;
  readonly role?: string;
  readonly now: string;
}

export interface LayerMembersRepo {
  /** Idempotent: re-adding the same (layer, user) pair is a no-op. */
  addUserMember(input: AddUserMemberInput): void;
  /** Idempotent: removing a missing member is a no-op. */
  removeUserMember(layerId: string, userId: string): void;
  listUserMembers(layerId: string): LayerUserMember[];
  /** Idempotent: re-adding the same (layer, group) pair is a no-op. */
  addGroupMember(input: AddGroupMemberInput): void;
  /** Idempotent: removing a missing member is a no-op. */
  removeGroupMember(layerId: string, groupId: string): void;
  listGroupMembers(layerId: string): LayerGroupMember[];
  /** Project layers where `userId` is a direct user member. */
  listLayersForUser(userId: string): LayerUserMember[];
  /** Project layers where `groupId` is a direct group member. */
  listLayersForGroup(groupId: string): LayerGroupMember[];
}

function rowToUserMember(row: UserMemberRow): LayerUserMember {
  return {
    layerId: row.layer_id,
    userId: row.user_id,
    role: row.role,
    createdAt: row.created_at,
  };
}

function rowToGroupMember(row: GroupMemberRow): LayerGroupMember {
  return {
    layerId: row.layer_id,
    groupId: row.group_id,
    role: row.role,
    createdAt: row.created_at,
  };
}

export function createLayerMembersRepo(db: Database): LayerMembersRepo {
  const addUser = db.query<unknown, [string, string, string, string]>(
    `INSERT OR IGNORE INTO layer_user_members (layer_id, user_id, role, created_at)
     VALUES (?, ?, ?, ?)`,
  );

  const removeUser = db.query<unknown, [string, string]>(
    `DELETE FROM layer_user_members WHERE layer_id = ? AND user_id = ?`,
  );

  const listUsers = db.query<UserMemberRow, [string]>(
    `SELECT layer_id, user_id, role, created_at
       FROM layer_user_members
      WHERE layer_id = ?
      ORDER BY created_at`,
  );

  const addGroup = db.query<unknown, [string, string, string, string]>(
    `INSERT OR IGNORE INTO layer_group_members (layer_id, group_id, role, created_at)
     VALUES (?, ?, ?, ?)`,
  );

  const removeGroup = db.query<unknown, [string, string]>(
    `DELETE FROM layer_group_members WHERE layer_id = ? AND group_id = ?`,
  );

  const listGroups = db.query<GroupMemberRow, [string]>(
    `SELECT layer_id, group_id, role, created_at
       FROM layer_group_members
      WHERE layer_id = ?
      ORDER BY created_at`,
  );

  const layersForUser = db.query<UserMemberRow, [string]>(
    `SELECT layer_id, user_id, role, created_at
       FROM layer_user_members
      WHERE user_id = ?`,
  );

  const layersForGroup = db.query<GroupMemberRow, [string]>(
    `SELECT layer_id, group_id, role, created_at
       FROM layer_group_members
      WHERE group_id = ?`,
  );

  return {
    addUserMember(input) {
      addUser.run(input.layerId, input.userId, input.role ?? 'member', input.now);
    },
    removeUserMember(layerId, userId) {
      removeUser.run(layerId, userId);
    },
    listUserMembers(layerId) {
      return listUsers.all(layerId).map(rowToUserMember);
    },
    addGroupMember(input) {
      addGroup.run(input.layerId, input.groupId, input.role ?? 'member', input.now);
    },
    removeGroupMember(layerId, groupId) {
      removeGroup.run(layerId, groupId);
    },
    listGroupMembers(layerId) {
      return listGroups.all(layerId).map(rowToGroupMember);
    },
    listLayersForUser(userId) {
      return layersForUser.all(userId).map(rowToUserMember);
    },
    listLayersForGroup(groupId) {
      return layersForGroup.all(groupId).map(rowToGroupMember);
    },
  };
}
