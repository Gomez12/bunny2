import type { Database } from 'bun:sqlite';

/**
 * Persisted user row, mirroring the columns in
 * `apps/server/src/storage/migrations/0002_users_groups.sql`.
 *
 * `passwordHash` and `mustChangePassword` live on the server-side type
 * only — never exposed across the package boundary. See
 * `packages/shared/src/auth.ts` for the safe shape.
 */
export interface User {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly mustChangePassword: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly version: number;
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  must_change_password: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
}

export interface CreateUserInput {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly mustChangePassword: boolean;
  readonly now: string;
}

export interface UpdateUserPatch {
  readonly displayName?: string;
  readonly passwordHash?: string;
  readonly mustChangePassword?: boolean;
}

export interface ListUsersOptions {
  readonly includeDeleted?: boolean;
}

export interface UsersRepo {
  createUser(input: CreateUserInput): User;
  findUserById(id: string): User | null;
  findUserByUsername(username: string): User | null;
  listUsers(opts?: ListUsersOptions): User[];
  updateUser(id: string, patch: UpdateUserPatch, now: string): User;
  softDeleteUser(id: string, now: string): void;
  /** Count of users that are not soft-deleted. Used by `/status.auth`. */
  countActive(): number;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    mustChangePassword: row.must_change_password !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    version: row.version,
  };
}

export function createUsersRepo(db: Database): UsersRepo {
  const insert = db.query<unknown, [string, string, string, string, number, string, string]>(
    `INSERT INTO users
       (id, username, display_name, password_hash, must_change_password,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const findById = db.query<UserRow, [string]>(
    `SELECT id, username, display_name, password_hash, must_change_password,
            created_at, updated_at, deleted_at, version
       FROM users WHERE id = ?`,
  );

  // COLLATE NOCASE on the column makes `=` case-insensitive automatically.
  const findByUsername = db.query<UserRow, [string]>(
    `SELECT id, username, display_name, password_hash, must_change_password,
            created_at, updated_at, deleted_at, version
       FROM users WHERE username = ?`,
  );

  const listAll = db.query<UserRow, []>(
    `SELECT id, username, display_name, password_hash, must_change_password,
            created_at, updated_at, deleted_at, version
       FROM users ORDER BY username`,
  );

  const listActive = db.query<UserRow, []>(
    `SELECT id, username, display_name, password_hash, must_change_password,
            created_at, updated_at, deleted_at, version
       FROM users WHERE deleted_at IS NULL ORDER BY username`,
  );

  const softDelete = db.query<unknown, [string, string, string]>(
    `UPDATE users
        SET deleted_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND deleted_at IS NULL`,
  );

  const countActiveStmt = db.query<{ n: number }, []>(
    'SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL',
  );

  return {
    createUser(input) {
      insert.run(
        input.id,
        input.username,
        input.displayName,
        input.passwordHash,
        input.mustChangePassword ? 1 : 0,
        input.now,
        input.now,
      );
      const row = findById.get(input.id);
      if (row === null) {
        throw new Error(`users-repo: failed to read back user ${input.id} after insert`);
      }
      return rowToUser(row);
    },
    findUserById(id) {
      const row = findById.get(id);
      return row === null ? null : rowToUser(row);
    },
    findUserByUsername(username) {
      const row = findByUsername.get(username);
      return row === null ? null : rowToUser(row);
    },
    listUsers(opts = {}) {
      const stmt = opts.includeDeleted === true ? listAll : listActive;
      return stmt.all().map(rowToUser);
    },
    updateUser(id, patch, now) {
      const sets: string[] = [];
      const params: (string | number)[] = [];
      if (patch.displayName !== undefined) {
        sets.push('display_name = ?');
        params.push(patch.displayName);
      }
      if (patch.passwordHash !== undefined) {
        sets.push('password_hash = ?');
        params.push(patch.passwordHash);
      }
      if (patch.mustChangePassword !== undefined) {
        sets.push('must_change_password = ?');
        params.push(patch.mustChangePassword ? 1 : 0);
      }
      if (sets.length === 0) {
        const existing = findById.get(id);
        if (existing === null) {
          throw new Error(`users-repo: user ${id} not found`);
        }
        return rowToUser(existing);
      }
      sets.push('updated_at = ?');
      params.push(now);
      sets.push('version = version + 1');
      const sql = `UPDATE users SET ${sets.join(', ')} WHERE id = ?`;
      params.push(id);
      db.query<unknown, typeof params>(sql).run(...params);
      const row = findById.get(id);
      if (row === null) {
        throw new Error(`users-repo: user ${id} not found after update`);
      }
      return rowToUser(row);
    },
    softDeleteUser(id, now) {
      softDelete.run(now, now, id);
    },
    countActive() {
      return countActiveStmt.get()?.n ?? 0;
    },
  };
}
