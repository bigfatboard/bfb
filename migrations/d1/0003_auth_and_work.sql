-- ABOUTME: Adds human membership, project policy, work records, and OAuth delegation tables.
-- ABOUTME: Covers C02/C04/C07/C08/X03A persistence without Better Auth protocol table generation.

CREATE TABLE IF NOT EXISTS humans (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS human_sessions (
  session_id TEXT PRIMARY KEY NOT NULL,
  human_id TEXT NOT NULL,
  workspace_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (human_id) REFERENCES humans (id)
);

CREATE TABLE IF NOT EXISTS passkey_step_up_proofs (
  proof_id TEXT PRIMARY KEY NOT NULL,
  human_id TEXT NOT NULL,
  action TEXT NOT NULL,
  client_id TEXT,
  resource TEXT,
  boundary_json TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  authorization_epoch INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (human_id) REFERENCES humans (id)
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL,
  human_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'restricted_member')),
  authorization_epoch INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, human_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (human_id) REFERENCES humans (id)
);

CREATE TABLE IF NOT EXISTS projects (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  tint TEXT NOT NULL,
  resource_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, slug),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE IF NOT EXISTS project_access (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  human_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, project_id, human_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id),
  FOREIGN KEY (workspace_id, human_id) REFERENCES workspace_members (workspace_id, human_id)
);

CREATE TABLE IF NOT EXISTS agent_profiles (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'grok')),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE IF NOT EXISTS project_policies (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  allow_agent_root_propose INTEGER NOT NULL DEFAULT 1,
  allow_pass_to_agent INTEGER NOT NULL DEFAULT 1,
  resource_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, project_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS tasks (
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
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS task_context_items (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('human', 'agent', 'both')),
  body TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS comments (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  author_human_id TEXT,
  author_delegation_id TEXT,
  body TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('discussion', 'progress')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS oauth_delegations (
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
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (human_id) REFERENCES humans (id)
);

CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  delegation_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (workspace_id, delegation_id) REFERENCES oauth_delegations (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS preregistered_oauth_clients (
  client_id TEXT PRIMARY KEY NOT NULL,
  redirect_uri TEXT NOT NULL,
  name TEXT NOT NULL,
  public_client INTEGER NOT NULL DEFAULT 1
);
