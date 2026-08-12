-- ABOUTME: Adds WorkspaceHub command-kernel tables for idempotency, events, audit, and abuse control.
-- ABOUTME: Owned by C01; later packages append domain tables without replacing this foundation.

CREATE TABLE IF NOT EXISTS idempotency_records (
  workspace_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_name TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE IF NOT EXISTS semantic_events (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  workspace_cursor INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, event_id),
  UNIQUE (workspace_id, workspace_cursor),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE IF NOT EXISTS workspace_cursors (
  workspace_id TEXT PRIMARY KEY NOT NULL,
  cursor INTEGER NOT NULL CHECK (cursor >= 0),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  workspace_id TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, audit_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE IF NOT EXISTS outbox_records (
  workspace_id TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  PRIMARY KEY (workspace_id, outbox_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key TEXT PRIMARY KEY NOT NULL,
  window_started_at TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  updated_at TEXT NOT NULL
);
