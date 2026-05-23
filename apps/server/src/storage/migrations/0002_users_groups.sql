-- Phase 2.1 schema: users, groups, memberships, sessions.
-- See `docs/dev/plans/done/phase-02-users-and-groups.md` §4.1 (sub-phase 2.1).

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_users_deleted_at ON users(deleted_at);

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_groups_deleted_at ON groups(deleted_at);

CREATE TABLE user_group_memberships (
  user_id TEXT NOT NULL REFERENCES users(id),
  group_id TEXT NOT NULL REFERENCES groups(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, group_id)
);
CREATE INDEX idx_user_group_memberships_group ON user_group_memberships(group_id);

CREATE TABLE group_group_memberships (
  parent_group_id TEXT NOT NULL REFERENCES groups(id),
  child_group_id TEXT NOT NULL REFERENCES groups(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (parent_group_id, child_group_id),
  CHECK (parent_group_id != child_group_id)
);
CREATE INDEX idx_group_group_memberships_child ON group_group_memberships(child_group_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
