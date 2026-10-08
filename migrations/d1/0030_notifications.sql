-- ABOUTME: Persists notification preferences, push endpoints, and delivery bookkeeping.
-- ABOUTME: Delivery rows key on stable derived IDs so queue retries converge on one logical effect.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE notification_preferences (
  workspace_id TEXT NOT NULL,
  human_id TEXT NOT NULL REFERENCES humans (id),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 128),
  channel TEXT NOT NULL CHECK (channel IN ('browser_push', 'macos')),
  category TEXT NOT NULL CHECK (category IN (
    'attention', 'launch_blocked', 'run_failed', 'result_submitted',
    'result_accepted', 'result_changes_requested', 'run_cancelled'
  )),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, human_id, project_id, channel, category),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE notification_push_endpoints (
  workspace_id TEXT NOT NULL,
  human_id TEXT NOT NULL REFERENCES humans (id),
  endpoint_hash TEXT NOT NULL CHECK (length(endpoint_hash) = 64 AND endpoint_hash GLOB '[0-9a-f]*'),
  endpoint TEXT NOT NULL CHECK (length(endpoint) BETWEEN 9 AND 2048),
  p256dh TEXT NOT NULL CHECK (length(p256dh) BETWEEN 87 AND 88),
  auth TEXT NOT NULL CHECK (length(auth) BETWEEN 22 AND 24),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, human_id, endpoint_hash),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE notification_deliveries (
  workspace_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL CHECK (length(delivery_id) = 26),
  channel TEXT NOT NULL CHECK (channel IN ('browser_push', 'macos')),
  human_id TEXT NOT NULL REFERENCES humans (id),
  runner_id TEXT,
  event_cursor INTEGER NOT NULL CHECK (event_cursor >= 1),
  event_kind TEXT NOT NULL CHECK (length(event_kind) BETWEEN 1 AND 64),
  category TEXT NOT NULL CHECK (category IN (
    'attention', 'launch_blocked', 'run_failed', 'result_submitted',
    'result_accepted', 'result_changes_requested', 'run_cancelled'
  )),
  state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'suppressed', 'failed', 'dead_lettered')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 256),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT,
  PRIMARY KEY (workspace_id, delivery_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE INDEX notification_deliveries_pending
  ON notification_deliveries (workspace_id, state, event_cursor);

CREATE TABLE notification_macos_inbox (
  workspace_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL CHECK (length(delivery_id) = 26),
  created_at TEXT NOT NULL,
  acked_at TEXT,
  PRIMARY KEY (workspace_id, runner_id, delivery_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (workspace_id, delivery_id) REFERENCES notification_deliveries (workspace_id, delivery_id)
);

CREATE TABLE notification_dispatch_state (
  workspace_id TEXT NOT NULL PRIMARY KEY REFERENCES workspaces (id),
  last_cursor INTEGER NOT NULL DEFAULT 0 CHECK (last_cursor >= 0),
  updated_at TEXT NOT NULL
);
