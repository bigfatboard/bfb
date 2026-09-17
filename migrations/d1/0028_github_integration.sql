-- ABOUTME: Persists GitHub App installations, repository links, webhook deliveries, and integration outbox.
-- ABOUTME: Exactly-one workspace/project mapping and latest-wins reconcile state are enforced by constraints.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE github_app_installations (
  installation_id TEXT NOT NULL PRIMARY KEY CHECK (length(installation_id) BETWEEN 1 AND 64),
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  app_id TEXT NOT NULL CHECK (length(app_id) BETWEEN 1 AND 64),
  app_slug TEXT NOT NULL CHECK (length(app_slug) BETWEEN 1 AND 128),
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 64),
  account_login TEXT NOT NULL CHECK (length(account_login) BETWEEN 1 AND 128),
  account_type TEXT NOT NULL CHECK (account_type IN ('User', 'Organization')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'suspended', 'revoked')),
  permissions_json TEXT NOT NULL CHECK (json_valid(permissions_json)),
  events_json TEXT NOT NULL CHECK (json_valid(events_json)),
  installed_by_human_id TEXT REFERENCES humans (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT CHECK (revoked_at IS NULL OR length(revoked_at) BETWEEN 1 AND 64),
  resource_version INTEGER NOT NULL CHECK (resource_version >= 1)
);

CREATE INDEX github_installations_by_workspace
  ON github_app_installations (workspace_id);

CREATE TABLE github_repository_links (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  id TEXT NOT NULL CHECK (length(id) BETWEEN 8 AND 128),
  repository_id TEXT NOT NULL CHECK (length(repository_id) BETWEEN 1 AND 64),
  installation_id TEXT NOT NULL REFERENCES github_app_installations (installation_id),
  project_id TEXT NOT NULL,
  full_name TEXT NOT NULL CHECK (length(full_name) BETWEEN 1 AND 256),
  default_branch TEXT NOT NULL CHECK (length(default_branch) BETWEEN 1 AND 256),
  link_state TEXT NOT NULL CHECK (link_state IN ('active', 'closed')),
  created_at TEXT NOT NULL,
  closed_at TEXT CHECK (closed_at IS NULL OR length(closed_at) BETWEEN 1 AND 64),
  resource_version INTEGER NOT NULL CHECK (resource_version >= 1),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id)
);

-- One installation/repository maps to exactly one authorized workspace/project.
CREATE UNIQUE INDEX github_repository_link_single_active
  ON github_repository_links (repository_id) WHERE link_state = 'active';
CREATE UNIQUE INDEX github_project_link_single_active
  ON github_repository_links (workspace_id, project_id) WHERE link_state = 'active';

CREATE TABLE github_webhook_deliveries (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  delivery_id TEXT NOT NULL CHECK (length(delivery_id) BETWEEN 8 AND 128),
  event TEXT NOT NULL CHECK (length(event) BETWEEN 1 AND 64),
  action TEXT CHECK (action IS NULL OR length(action) BETWEEN 1 AND 64),
  installation_id TEXT CHECK (installation_id IS NULL OR length(installation_id) BETWEEN 1 AND 64),
  repository_id TEXT CHECK (repository_id IS NULL OR length(repository_id) BETWEEN 1 AND 64),
  effect_json TEXT NOT NULL CHECK (json_valid(effect_json)),
  state TEXT NOT NULL CHECK (state IN ('received', 'queued', 'applied', 'superseded', 'ignored', 'failed')),
  received_at TEXT NOT NULL,
  processed_at TEXT CHECK (processed_at IS NULL OR length(processed_at) BETWEEN 1 AND 64),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 64),
  PRIMARY KEY (workspace_id, delivery_id)
);

CREATE TABLE github_integration_outbox (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  outbox_id TEXT NOT NULL CHECK (length(outbox_id) BETWEEN 8 AND 128),
  delivery_id TEXT NOT NULL CHECK (length(delivery_id) BETWEEN 8 AND 128),
  kind TEXT NOT NULL CHECK (kind = 'github.reconcile'),
  state TEXT NOT NULL CHECK (state IN ('pending', 'dispatched', 'done', 'dlq')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  next_attempt_at TEXT NOT NULL,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) BETWEEN 1 AND 512),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, outbox_id),
  FOREIGN KEY (workspace_id, delivery_id)
    REFERENCES github_webhook_deliveries (workspace_id, delivery_id)
);

CREATE INDEX github_outbox_recovery
  ON github_integration_outbox (state, next_attempt_at);

-- Visible dead-letter state for poison messages that exhaust retries.
CREATE TABLE github_dlq (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  outbox_id TEXT NOT NULL CHECK (length(outbox_id) BETWEEN 8 AND 128),
  delivery_id TEXT NOT NULL CHECK (length(delivery_id) BETWEEN 8 AND 128),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
  error TEXT NOT NULL CHECK (length(error) BETWEEN 1 AND 512),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, outbox_id)
);

-- Linked issue/branch/commit/PR/check/deployment evidence. BFB task rows stay
-- canonical: reconcile never writes task state. Runner-observed and
-- GitHub-verified observations are separate rows, never upgraded in place.
CREATE TABLE github_evidence (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  id TEXT NOT NULL CHECK (length(id) BETWEEN 8 AND 128),
  project_id TEXT NOT NULL,
  task_id TEXT,
  repository_id TEXT NOT NULL CHECK (length(repository_id) BETWEEN 1 AND 64),
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'branch', 'commit', 'pull_request', 'check', 'deployment')),
  ref TEXT NOT NULL CHECK (length(ref) BETWEEN 1 AND 512),
  version_token TEXT NOT NULL CHECK (length(version_token) BETWEEN 1 AND 128),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  observed_by TEXT NOT NULL CHECK (observed_by IN ('github', 'runner', 'human')),
  observed_at TEXT NOT NULL,
  resource_version INTEGER NOT NULL CHECK (resource_version >= 1),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, repository_id, kind, ref, observed_by),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id)
);

CREATE INDEX github_evidence_by_project
  ON github_evidence (workspace_id, project_id);
CREATE INDEX github_evidence_by_task
  ON github_evidence (workspace_id, task_id) WHERE task_id IS NOT NULL;

-- Latest-wins guard so duplicate and out-of-order deliveries converge.
CREATE TABLE github_reconcile_state (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  repository_id TEXT NOT NULL CHECK (length(repository_id) BETWEEN 1 AND 64),
  last_event_time TEXT NOT NULL,
  last_delivery_id TEXT NOT NULL CHECK (length(last_delivery_id) BETWEEN 8 AND 128),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, repository_id)
);
