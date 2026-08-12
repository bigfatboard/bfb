-- ABOUTME: Adds Better Auth OAuth Provider storage and binds its opaque tokens to BFB delegations.
-- ABOUTME: Keeps public clients preregistered while refresh rotation and replay state remain durable.

CREATE TABLE better_auth_oauth_clients (
  id TEXT NOT NULL PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  client_secret TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  skip_consent INTEGER,
  enable_end_session INTEGER,
  subject_type TEXT,
  scopes TEXT,
  user_id TEXT REFERENCES better_auth_users (id) ON DELETE CASCADE,
  created_at DATE,
  updated_at DATE,
  name TEXT,
  uri TEXT,
  icon TEXT,
  contacts TEXT,
  tos TEXT,
  policy TEXT,
  software_id TEXT,
  software_version TEXT,
  software_statement TEXT,
  redirect_uris TEXT NOT NULL,
  post_logout_redirect_uris TEXT,
  token_endpoint_auth_method TEXT,
  grant_types TEXT,
  response_types TEXT,
  public INTEGER,
  type TEXT,
  require_pkce INTEGER,
  reference_id TEXT,
  metadata TEXT
);

CREATE TABLE better_auth_oauth_refresh_tokens (
  id TEXT NOT NULL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES better_auth_oauth_clients (client_id),
  session_id TEXT REFERENCES better_auth_sessions (id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES better_auth_users (id) ON DELETE CASCADE,
  reference_id TEXT,
  expires_at DATE NOT NULL,
  created_at DATE NOT NULL,
  revoked DATE,
  auth_time DATE,
  scopes TEXT NOT NULL
);

CREATE TABLE better_auth_oauth_access_tokens (
  id TEXT NOT NULL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES better_auth_oauth_clients (client_id),
  session_id TEXT REFERENCES better_auth_sessions (id) ON DELETE SET NULL,
  user_id TEXT REFERENCES better_auth_users (id) ON DELETE CASCADE,
  reference_id TEXT,
  refresh_id TEXT REFERENCES better_auth_oauth_refresh_tokens (id),
  expires_at DATE NOT NULL,
  created_at DATE NOT NULL,
  scopes TEXT NOT NULL
);

CREATE TABLE better_auth_oauth_consents (
  id TEXT NOT NULL PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES better_auth_oauth_clients (client_id),
  user_id TEXT REFERENCES better_auth_users (id) ON DELETE CASCADE,
  reference_id TEXT,
  scopes TEXT NOT NULL,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL
);

CREATE INDEX better_auth_oauth_refresh_tokens_client_idx
  ON better_auth_oauth_refresh_tokens (client_id);
CREATE INDEX better_auth_oauth_refresh_tokens_session_idx
  ON better_auth_oauth_refresh_tokens (session_id);
CREATE INDEX better_auth_oauth_refresh_tokens_user_idx
  ON better_auth_oauth_refresh_tokens (user_id);
CREATE INDEX better_auth_oauth_access_tokens_client_idx
  ON better_auth_oauth_access_tokens (client_id);
CREATE INDEX better_auth_oauth_access_tokens_session_idx
  ON better_auth_oauth_access_tokens (session_id);
CREATE INDEX better_auth_oauth_access_tokens_user_idx
  ON better_auth_oauth_access_tokens (user_id);
CREATE INDEX better_auth_oauth_access_tokens_refresh_idx
  ON better_auth_oauth_access_tokens (refresh_id);
CREATE INDEX better_auth_oauth_consents_client_idx
  ON better_auth_oauth_consents (client_id);
CREATE INDEX better_auth_oauth_consents_user_idx
  ON better_auth_oauth_consents (user_id);

CREATE TABLE oauth_delegation_grants (
  id TEXT NOT NULL,
  human_id TEXT NOT NULL REFERENCES humans (id),
  auth_user_id TEXT NOT NULL REFERENCES better_auth_users (id),
  session_id TEXT NOT NULL REFERENCES better_auth_sessions (id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES better_auth_oauth_clients (client_id),
  state TEXT NOT NULL UNIQUE,
  resource TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT,
  task_id TEXT,
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  authorization_epoch INTEGER NOT NULL,
  step_up_proof_id TEXT NOT NULL UNIQUE REFERENCES passkey_step_up_proofs (proof_id),
  provider_label TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consent_decision TEXT CHECK (consent_decision IN ('accepted', 'denied')),
  consent_stamp TEXT UNIQUE,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (id),
  CHECK (task_id IS NULL OR project_id IS NOT NULL),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id, task_id)
    REFERENCES tasks (workspace_id, project_id, id)
);

ALTER TABLE oauth_delegations ADD COLUMN provider_label TEXT;

CREATE TABLE oauth_delegation_tokens (
  token_hash TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  delegation_id TEXT NOT NULL,
  provider_token_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, token_hash),
  UNIQUE (token_hash),
  FOREIGN KEY (workspace_id, delegation_id)
    REFERENCES oauth_delegations (workspace_id, id),
  FOREIGN KEY (provider_token_id)
    REFERENCES better_auth_oauth_access_tokens (id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO preregistered_oauth_clients
  (client_id, redirect_uri, name, public_client)
VALUES
  ('bfb-claude-code', 'http://localhost:9999/callback', 'Claude Code', 1);

INSERT INTO better_auth_oauth_clients (
  id, client_id, client_secret, disabled, skip_consent, enable_end_session,
  subject_type, scopes, user_id, created_at, updated_at, name, uri, icon,
  contacts, tos, policy, software_id, software_version, software_statement,
  redirect_uris, post_logout_redirect_uris, token_endpoint_auth_method,
  grant_types, response_types, public, type, require_pkce, reference_id, metadata
)
SELECT
  client_id, client_id, NULL, 0, 0, 0, 'public',
  '["bfb:read","bfb:task:write","offline_access"]', NULL,
  '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z', name,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  json_array(redirect_uri), NULL, 'none',
  '["authorization_code","refresh_token"]', '["code"]', 1,
  'native', 1, NULL, NULL
FROM preregistered_oauth_clients;
