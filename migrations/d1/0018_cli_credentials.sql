-- ABOUTME: Adds the reviewed Better Auth 1.6.26 device-code table for CLI bootstrap.
-- ABOUTME: Binds workspace-scoped API key credentials to humans before any key becomes active.

CREATE TABLE better_auth_device_codes (
  id TEXT NOT NULL PRIMARY KEY,
  device_code TEXT NOT NULL,
  user_code TEXT NOT NULL,
  user_id TEXT,
  expires_at DATE NOT NULL,
  status TEXT NOT NULL,
  last_polled_at DATE,
  polling_interval INTEGER,
  client_id TEXT,
  scope TEXT
);

CREATE INDEX better_auth_device_codes_device_code_idx
  ON better_auth_device_codes (device_code);
CREATE INDEX better_auth_device_codes_user_code_idx
  ON better_auth_device_codes (user_code);

-- The BFB binding is authoritative: a Better Auth device code can only become
-- a CLI credential while it references an active binding, and revocation
-- disables the binding before any device-row cleanup. Only key hashes persist.
CREATE TABLE api_key_bindings (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('human', 'integration')),
  human_id TEXT REFERENCES humans (id) ON DELETE RESTRICT,
  auth_user_id TEXT NOT NULL REFERENCES better_auth_users (id) ON DELETE RESTRICT,
  device_row_id TEXT,
  device_code_hash TEXT NOT NULL CHECK (length(device_code_hash) = 64),
  key_hash TEXT UNIQUE CHECK (key_hash IS NULL OR length(key_hash) = 64),
  key_prefix TEXT CHECK (key_prefix IS NULL OR length(key_prefix) = 12),
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
  project_ids_json TEXT CHECK (project_ids_json IS NULL OR json_valid(project_ids_json)),
  authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch >= 1),
  expires_at TEXT NOT NULL,
  exchanged_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  CHECK ((principal_type = 'human' AND human_id IS NOT NULL)
      OR (principal_type = 'integration' AND human_id IS NULL))
);

-- One active binding per bootstrap credential: a second approval of the same
-- device code fails instead of creating an ambiguous exchange target.
CREATE UNIQUE INDEX api_key_bindings_device_hash_uidx
  ON api_key_bindings (workspace_id, device_code_hash) WHERE revoked_at IS NULL;
CREATE INDEX api_key_bindings_human_idx
  ON api_key_bindings (workspace_id, human_id);
