-- ABOUTME: Adds database-enforced delegation, attribution, and OAuth-code relationships.
-- ABOUTME: Rebuilds the complete task/delegation dependency closure with deferred checks.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE tasks_new (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('proposed', 'ready', 'in_progress', 'blocked', 'done', 'cancelled')),
  priority TEXT NOT NULL CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  due_at TEXT,
  next_owner_type TEXT CHECK (next_owner_type IN ('human', 'agent_profile', 'unassigned')),
  next_owner_id TEXT,
  next_action_reason TEXT,
  punchline TEXT NOT NULL,
  resource_version INTEGER NOT NULL DEFAULT 1,
  created_by_human_id TEXT,
  created_by_delegation_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, project_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id),
  FOREIGN KEY (created_by_human_id) REFERENCES humans (id),
  FOREIGN KEY (workspace_id, created_by_delegation_id)
    REFERENCES oauth_delegations_new (workspace_id, id)
);

CREATE TABLE oauth_delegations_new (
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
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (human_id) REFERENCES humans (id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id, task_id)
    REFERENCES tasks_new (workspace_id, project_id, id)
);

CREATE TABLE comments_new (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  author_human_id TEXT,
  author_delegation_id TEXT,
  body TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('discussion', 'progress')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks_new (workspace_id, id),
  FOREIGN KEY (author_human_id) REFERENCES humans (id),
  FOREIGN KEY (workspace_id, author_delegation_id)
    REFERENCES oauth_delegations_new (workspace_id, id)
);

CREATE TABLE task_context_items_new (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('human', 'agent', 'both')),
  body TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks_new (workspace_id, id)
);

CREATE TABLE oauth_access_tokens_new (
  token_hash TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  delegation_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (workspace_id, delegation_id)
    REFERENCES oauth_delegations_new (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
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
  consumed_at TEXT
);

CREATE TABLE oauth_authorization_codes_new (
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

INSERT INTO tasks_new (
  workspace_id, id, project_id, title, state, priority, due_at,
  next_owner_type, next_owner_id, next_action_reason, punchline,
  resource_version, created_by_human_id, created_by_delegation_id, created_at
)
SELECT
  workspace_id, id, project_id, title, state, priority, due_at,
  next_owner_type, next_owner_id, next_action_reason, punchline,
  resource_version, created_by_human_id, created_by_delegation_id, created_at
FROM tasks;

INSERT INTO oauth_delegations_new (
  workspace_id, id, human_id, client_id, resource, project_id, task_id,
  scopes_json, authorization_epoch, expires_at, revoked_at, created_at
)
SELECT
  workspace_id, id, human_id, client_id, resource, project_id, task_id,
  scopes_json, authorization_epoch, expires_at, revoked_at, created_at
FROM oauth_delegations;

INSERT INTO comments_new (
  workspace_id, id, task_id, author_human_id, author_delegation_id,
  body, kind, created_at
)
SELECT
  workspace_id, id, task_id, author_human_id, author_delegation_id,
  body, kind, created_at
FROM comments;

INSERT INTO task_context_items_new (
  workspace_id, id, task_id, audience, body, version, content_hash, created_at
)
SELECT
  workspace_id, id, task_id, audience, body, version, content_hash, created_at
FROM task_context_items;

INSERT INTO oauth_access_tokens_new (
  token_hash, workspace_id, delegation_id, expires_at, revoked_at
)
SELECT token_hash, workspace_id, delegation_id, expires_at, revoked_at
FROM oauth_access_tokens;

INSERT INTO oauth_authorization_codes_new (
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

ALTER TABLE tasks_new RENAME TO tasks;
ALTER TABLE oauth_delegations_new RENAME TO oauth_delegations;
ALTER TABLE comments_new RENAME TO comments;
ALTER TABLE task_context_items_new RENAME TO task_context_items;
ALTER TABLE oauth_access_tokens_new RENAME TO oauth_access_tokens;
ALTER TABLE oauth_authorization_codes_new RENAME TO oauth_authorization_codes;
