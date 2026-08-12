-- ABOUTME: Adds the compact C08 task, run, execution, session, and context-delivery records.
-- ABOUTME: Rebuilds the task dependency closure so canonical workflow and tenant FKs are enforced.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE tasks_c08 (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  parent_task_id TEXT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 512),
  state TEXT NOT NULL CHECK (state IN ('proposed', 'ready', 'active', 'review', 'blocked', 'done', 'cancelled')),
  priority TEXT NOT NULL CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  due_at TEXT,
  next_owner_type TEXT NOT NULL CHECK (next_owner_type IN ('human', 'agent_profile', 'unassigned')),
  next_owner_id TEXT,
  next_action_reason TEXT CHECK (next_action_reason IS NULL OR length(next_action_reason) BETWEEN 1 AND 512),
  punchline TEXT NOT NULL CHECK (length(punchline) BETWEEN 1 AND 512),
  resource_version INTEGER NOT NULL DEFAULT 1 CHECK (resource_version >= 1),
  created_by_human_id TEXT,
  created_by_delegation_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, project_id, id),
  CHECK (
    (next_owner_type = 'unassigned' AND next_owner_id IS NULL)
    OR (next_owner_type != 'unassigned' AND next_owner_id IS NOT NULL)
  ),
  CHECK (parent_task_id IS NULL OR parent_task_id != id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id, parent_task_id)
    REFERENCES tasks_c08 (workspace_id, project_id, id),
  FOREIGN KEY (created_by_human_id) REFERENCES humans (id),
  FOREIGN KEY (workspace_id, created_by_delegation_id)
    REFERENCES oauth_delegations_c08 (workspace_id, id)
);

CREATE TABLE oauth_delegations_c08 (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  human_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  project_id TEXT,
  task_id TEXT,
  scopes_json TEXT NOT NULL,
  authorization_epoch INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CHECK (task_id IS NULL OR project_id IS NOT NULL),
  UNIQUE (workspace_id, id, client_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (human_id) REFERENCES humans (id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id, task_id)
    REFERENCES tasks_c08 (workspace_id, project_id, id)
);

CREATE TABLE comments_c08 (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  author_human_id TEXT,
  author_delegation_id TEXT,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2048),
  kind TEXT NOT NULL CHECK (kind IN ('discussion', 'progress')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks_c08 (workspace_id, id),
  FOREIGN KEY (author_human_id) REFERENCES humans (id),
  FOREIGN KEY (workspace_id, author_delegation_id)
    REFERENCES oauth_delegations_c08 (workspace_id, id)
);

CREATE TABLE task_context_items_c08 (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('brief', 'acceptance', 'constraint', 'plan', 'decision', 'link', 'note')),
  audience TEXT NOT NULL CHECK (audience IN ('human', 'agent', 'both')),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 16384),
  version INTEGER NOT NULL CHECK (version >= 1),
  content_hash TEXT NOT NULL CHECK (content_hash GLOB 'sha256:[0-9a-f]*' AND length(content_hash) = 71),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, task_id, version),
  UNIQUE (workspace_id, task_id, version, content_hash),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks_c08 (workspace_id, id)
);

CREATE TABLE oauth_access_tokens_c08 (
  token_hash TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  delegation_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (workspace_id, delegation_id)
    REFERENCES oauth_delegations_c08 (workspace_id, id)
);

CREATE TABLE oauth_authorization_codes_c08 (
  code TEXT PRIMARY KEY NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  human_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT,
  scopes_json TEXT NOT NULL,
  authorization_epoch INTEGER NOT NULL,
  step_up_proof_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  FOREIGN KEY (human_id) REFERENCES humans (id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id),
  FOREIGN KEY (step_up_proof_id) REFERENCES passkey_step_up_proofs (proof_id)
);

INSERT INTO tasks_c08 (
  workspace_id, id, project_id, parent_task_id, title, state, priority, due_at,
  next_owner_type, next_owner_id, next_action_reason, punchline,
  resource_version, created_by_human_id, created_by_delegation_id, created_at
)
SELECT
  workspace_id, id, project_id, NULL, title,
  CASE state WHEN 'in_progress' THEN 'active' ELSE state END,
  priority, due_at, COALESCE(next_owner_type, 'unassigned'), next_owner_id,
  next_action_reason, punchline, resource_version, created_by_human_id,
  created_by_delegation_id, created_at
FROM tasks;

INSERT INTO oauth_delegations_c08 (
  workspace_id, id, human_id, client_id, resource, project_id, task_id,
  scopes_json, authorization_epoch, expires_at, revoked_at, created_at
)
SELECT
  workspace_id, id, human_id, client_id, resource, project_id, task_id,
  scopes_json, authorization_epoch, expires_at, revoked_at, created_at
FROM oauth_delegations;

INSERT INTO comments_c08 (
  workspace_id, id, task_id, author_human_id, author_delegation_id,
  body, kind, created_at
)
SELECT
  workspace_id, id, task_id, author_human_id, author_delegation_id,
  body, kind, created_at
FROM comments;

INSERT INTO task_context_items_c08 (
  workspace_id, id, task_id, kind, audience, body, version, content_hash, created_at
)
SELECT workspace_id, id, task_id, 'note', audience, body, version, content_hash, created_at
FROM task_context_items;

INSERT INTO oauth_access_tokens_c08 (
  token_hash, workspace_id, delegation_id, expires_at, revoked_at
)
SELECT token_hash, workspace_id, delegation_id, expires_at, revoked_at
FROM oauth_access_tokens;

INSERT INTO oauth_authorization_codes_c08 (
  code, client_id, redirect_uri, code_challenge, human_id, workspace_id,
  project_id, scopes_json, authorization_epoch, step_up_proof_id, expires_at, consumed_at
)
SELECT
  code, client_id, redirect_uri, code_challenge, human_id, workspace_id,
  project_id, scopes_json, authorization_epoch, step_up_proof_id, expires_at, consumed_at
FROM oauth_authorization_codes;

DROP TABLE oauth_access_tokens;
DROP TABLE comments;
DROP TABLE task_context_items;
DROP TABLE oauth_authorization_codes;
DROP TABLE oauth_delegations;
DROP TABLE tasks;

ALTER TABLE tasks_c08 RENAME TO tasks;
ALTER TABLE oauth_delegations_c08 RENAME TO oauth_delegations;
ALTER TABLE comments_c08 RENAME TO comments;
ALTER TABLE task_context_items_c08 RENAME TO task_context_items;
ALTER TABLE oauth_access_tokens_c08 RENAME TO oauth_access_tokens;
ALTER TABLE oauth_authorization_codes_c08 RENAME TO oauth_authorization_codes;

CREATE TABLE task_dependencies (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'blocks'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, task_id, depends_on_task_id),
  CHECK (task_id != depends_on_task_id),
  FOREIGN KEY (workspace_id, project_id, task_id)
    REFERENCES tasks (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id, depends_on_task_id)
    REFERENCES tasks (workspace_id, project_id, id)
);

CREATE TABLE task_links (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('github', 'artifact', 'external')),
  url TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 2048),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id)
);

CREATE TABLE runs (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  requested_by_human_id TEXT NOT NULL,
  agent_profile_id TEXT NOT NULL,
  result_state TEXT NOT NULL CHECK (result_state IN ('open', 'submitted', 'changes_requested', 'accepted', 'failed', 'cancelled')),
  activity TEXT NOT NULL CHECK (activity IN ('working', 'needs_human', 'waiting_user_submit', 'waiting_external', 'idle', 'offline', 'unknown')),
  resource_version INTEGER NOT NULL DEFAULT 1 CHECK (resource_version >= 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, project_id, id),
  UNIQUE (workspace_id, id, task_id),
  FOREIGN KEY (workspace_id, project_id, task_id)
    REFERENCES tasks (workspace_id, project_id, id),
  FOREIGN KEY (requested_by_human_id) REFERENCES humans (id),
  FOREIGN KEY (workspace_id, agent_profile_id) REFERENCES agent_profiles (workspace_id, id)
);

CREATE TABLE run_configuration_snapshots (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  workspace_policy_version INTEGER NOT NULL,
  project_policy_version INTEGER NOT NULL,
  repository_config_version INTEGER NOT NULL,
  agent_profile_id TEXT NOT NULL,
  agent_profile_version INTEGER NOT NULL,
  canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json)),
  content_hash TEXT NOT NULL CHECK (content_hash GLOB 'sha256:[0-9a-f]*' AND length(content_hash) = 71),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, run_id),
  FOREIGN KEY (workspace_id, project_id, run_id)
    REFERENCES runs (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, workspace_policy_version)
    REFERENCES workspace_policy_versions (workspace_id, version),
  FOREIGN KEY (workspace_id, project_id, project_policy_version)
    REFERENCES project_policy_versions (workspace_id, project_id, version),
  FOREIGN KEY (workspace_id, project_id, repository_config_version)
    REFERENCES repository_config_versions (workspace_id, project_id, version),
  FOREIGN KEY (workspace_id, agent_profile_id, agent_profile_version)
    REFERENCES agent_profile_versions (workspace_id, profile_id, version)
);

CREATE TABLE run_executions (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'launching', 'attached', 'detached', 'ended')),
  end_reason TEXT CHECK (end_reason IN ('launch_blocked', 'launch_expired', 'process_exit', 'terminated', 'lost')),
  resource_version INTEGER NOT NULL DEFAULT 1 CHECK (resource_version >= 1),
  created_at TEXT NOT NULL,
  ended_at TEXT,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, run_id, id),
  CHECK ((state = 'ended' AND end_reason IS NOT NULL AND ended_at IS NOT NULL)
    OR (state != 'ended' AND end_reason IS NULL AND ended_at IS NULL)),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs (workspace_id, id)
);

CREATE TABLE provider_sessions (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'grok')),
  requested_session_id TEXT,
  observed_session_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('active', 'ended')),
  resource_version INTEGER NOT NULL DEFAULT 1 CHECK (resource_version >= 1),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  PRIMARY KEY (workspace_id, id),
  CHECK ((state = 'ended' AND ended_at IS NOT NULL) OR (state = 'active' AND ended_at IS NULL)),
  FOREIGN KEY (workspace_id, run_id, execution_id)
    REFERENCES run_executions (workspace_id, run_id, id)
);

CREATE UNIQUE INDEX run_executions_one_active_per_run
ON run_executions (workspace_id, run_id)
WHERE state != 'ended';

CREATE TABLE task_context_deliveries (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  context_version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  run_id TEXT,
  delegation_id TEXT,
  client_id TEXT,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CHECK (
    (run_id IS NOT NULL AND delegation_id IS NULL AND client_id IS NULL)
    OR (run_id IS NULL AND delegation_id IS NOT NULL AND client_id IS NOT NULL)
  ),
  FOREIGN KEY (workspace_id, task_id, context_version, content_hash)
    REFERENCES task_context_items (workspace_id, task_id, version, content_hash),
  FOREIGN KEY (workspace_id, run_id, task_id) REFERENCES runs (workspace_id, id, task_id),
  FOREIGN KEY (workspace_id, delegation_id, client_id)
    REFERENCES oauth_delegations (workspace_id, id, client_id)
);

CREATE TRIGGER task_context_items_immutable_update
BEFORE UPDATE ON task_context_items
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'task context versions are immutable');
END;

CREATE TRIGGER task_context_items_immutable_delete
BEFORE DELETE ON task_context_items
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'task context versions are immutable');
END;

CREATE TRIGGER run_configuration_snapshots_immutable_update
BEFORE UPDATE ON run_configuration_snapshots
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'run configuration snapshots are immutable');
END;

CREATE TRIGGER run_configuration_snapshots_immutable_delete
BEFORE DELETE ON run_configuration_snapshots
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'run configuration snapshots are immutable');
END;

CREATE TRIGGER task_context_deliveries_immutable_update
BEFORE UPDATE ON task_context_deliveries
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'task context deliveries are immutable');
END;

CREATE TRIGGER task_context_deliveries_immutable_delete
BEFORE DELETE ON task_context_deliveries
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'task context deliveries are immutable');
END;
