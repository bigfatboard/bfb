-- ABOUTME: Creates the F04 workspace registry and schema migration bookkeeping tables.
-- ABOUTME: Tenant product tables are added by later packages using composite workspace keys.

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 26),
  slug TEXT NOT NULL,
  jurisdiction TEXT NOT NULL
    CHECK (jurisdiction IN ('eu', 'us', 'global')),
  created_at TEXT NOT NULL,
  resource_version INTEGER NOT NULL DEFAULT 1
    CHECK (resource_version >= 1),
  UNIQUE (slug)
);

-- Example tenant-owned fixture table used only to prove composite FK conventions in F04.
CREATE TABLE IF NOT EXISTS tenant_fixture_items (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  label TEXT NOT NULL,
  resource_version INTEGER NOT NULL DEFAULT 1
    CHECK (resource_version >= 1),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE IF NOT EXISTS tenant_fixture_children (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, parent_id)
    REFERENCES tenant_fixture_items (workspace_id, id)
);
