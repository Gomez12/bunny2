-- Phase 3.1 schema: layers, visibility edges, members, locales,
-- attachments, dashboard widgets.
-- See `docs/dev/plans/done/phase-03-layers.md` §4.2.

CREATE TABLE layers (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('personal','project','group','everyone')),
  slug TEXT UNIQUE NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  description TEXT,
  owner_user_id TEXT REFERENCES users(id),
  owner_group_id TEXT REFERENCES groups(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  CHECK (
    (type = 'personal' AND owner_user_id IS NOT NULL AND owner_group_id IS NULL) OR
    (type = 'group'    AND owner_group_id IS NOT NULL AND owner_user_id IS NULL) OR
    (type IN ('project','everyone') AND owner_user_id IS NULL AND owner_group_id IS NULL)
  )
);
CREATE INDEX idx_layers_type ON layers(type);
CREATE INDEX idx_layers_deleted_at ON layers(deleted_at);

CREATE TABLE layer_visibility_edges (
  parent_layer_id TEXT NOT NULL REFERENCES layers(id),
  child_layer_id  TEXT NOT NULL REFERENCES layers(id),
  direction       TEXT NOT NULL CHECK (direction IN ('top_down','bottom_up','both')),
  created_at      TEXT NOT NULL,
  PRIMARY KEY (parent_layer_id, child_layer_id),
  CHECK (parent_layer_id != child_layer_id)
);
CREATE INDEX idx_layer_visibility_child ON layer_visibility_edges(child_layer_id);

CREATE TABLE layer_user_members (
  layer_id TEXT NOT NULL REFERENCES layers(id),
  user_id  TEXT NOT NULL REFERENCES users(id),
  role     TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL,
  PRIMARY KEY (layer_id, user_id)
);

CREATE TABLE layer_group_members (
  layer_id TEXT NOT NULL REFERENCES layers(id),
  group_id TEXT NOT NULL REFERENCES groups(id),
  role     TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL,
  PRIMARY KEY (layer_id, group_id)
);

CREATE TABLE layer_locales (
  layer_id TEXT NOT NULL REFERENCES layers(id),
  locale   TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (layer_id, locale)
);

CREATE TABLE layer_attachments (
  id          TEXT PRIMARY KEY,
  layer_id    TEXT NOT NULL REFERENCES layers(id),
  kind        TEXT NOT NULL CHECK (kind IN ('agent','skill','mcp_server')),
  ref_id      TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  UNIQUE (layer_id, kind, ref_id)
);

CREATE TABLE layer_dashboard_widgets (
  id          TEXT PRIMARY KEY,
  layer_id    TEXT NOT NULL REFERENCES layers(id),
  widget_kind TEXT NOT NULL,
  position    INTEGER NOT NULL,
  layout_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
