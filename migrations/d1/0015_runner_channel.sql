-- ABOUTME: Persists bounded runner observations and durable command references under workspace authority.
-- ABOUTME: Transport heartbeats and delivery references never authorize execution or acknowledge journal events.

CREATE TABLE runner_connections (
  workspace_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  token_epoch INTEGER NOT NULL,
  last_seen_at TEXT NOT NULL,
  auth_expires_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, runner_id),
  FOREIGN KEY (workspace_id, runner_id) REFERENCES runners (workspace_id, id)
);

CREATE TABLE runner_inventories (
  workspace_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  inventory_json TEXT NOT NULL CHECK (length(inventory_json) <= 49152),
  received_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, runner_id),
  FOREIGN KEY (workspace_id, runner_id) REFERENCES runners (workspace_id, id)
);

CREATE TABLE runner_command_references (
  workspace_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  command_kind TEXT NOT NULL CHECK (command_kind IN ('launch', 'run_control', 'discussion_turn')),
  project_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (workspace_id, runner_id, command_id),
  FOREIGN KEY (workspace_id, runner_id) REFERENCES runners (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id)
);

CREATE INDEX runner_command_references_pending_idx
  ON runner_command_references (workspace_id, runner_id, resolved_at, command_id);
