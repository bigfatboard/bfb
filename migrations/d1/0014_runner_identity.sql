-- ABOUTME: Persists workspace-isolated runner keys, grants, hashed challenges, and token verifiers.
-- ABOUTME: Revocation signals and guarded single-use consumption commit with authority changes.

CREATE TABLE runners (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  owner_human_id TEXT NOT NULL REFERENCES humans (id),
  device_label TEXT NOT NULL CHECK (length(device_label) BETWEEN 1 AND 80),
  public_key_json TEXT NOT NULL,
  key_thumbprint TEXT NOT NULL UNIQUE,
  authorization_epoch INTEGER NOT NULL DEFAULT 1 CHECK (authorization_epoch >= 1),
  grant_epoch INTEGER NOT NULL DEFAULT 1 CHECK (grant_epoch >= 1),
  token_epoch INTEGER NOT NULL DEFAULT 0 CHECK (token_epoch >= 0),
  enrolled_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE runner_project_grants (
  workspace_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, runner_id, project_id),
  FOREIGN KEY (workspace_id, runner_id) REFERENCES runners (workspace_id, id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects (workspace_id, id)
);

CREATE TABLE runner_launch_grants (
  workspace_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  human_id TEXT NOT NULL REFERENCES humans (id),
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (workspace_id, runner_id, human_id),
  FOREIGN KEY (workspace_id, runner_id) REFERENCES runners (workspace_id, id),
  FOREIGN KEY (workspace_id, human_id) REFERENCES workspace_members (workspace_id, human_id)
    ON DELETE CASCADE
);

CREATE TABLE runner_challenges (
  workspace_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  nonce_hash TEXT NOT NULL CHECK (length(nonce_hash) = 64),
  purpose TEXT NOT NULL CHECK (purpose IN ('token', 'request')),
  audience TEXT NOT NULL CHECK (audience = 'bfb-runner'),
  origin TEXT NOT NULL,
  authorization_epoch INTEGER NOT NULL,
  owner_authorization_epoch INTEGER NOT NULL,
  grant_epoch INTEGER NOT NULL,
  token_epoch INTEGER NOT NULL,
  token_id TEXT,
  request_json TEXT,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, runner_id) REFERENCES runners (workspace_id, id),
  CHECK ((purpose = 'token' AND token_id IS NULL AND request_json IS NULL)
      OR (purpose = 'request' AND token_id IS NOT NULL AND request_json IS NOT NULL))
);

CREATE INDEX runner_challenges_runner_idx
  ON runner_challenges (workspace_id, runner_id, expires_at);

CREATE TABLE runner_tokens (
  workspace_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  claims_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, runner_id) REFERENCES runners (workspace_id, id)
);

CREATE TABLE runner_channel_signals (
  workspace_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  authorization_epoch INTEGER NOT NULL,
  grant_epoch INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('revoked', 'grants_changed', 'token_rotated')),
  token_epoch INTEGER NOT NULL,
  removed_human_id TEXT REFERENCES humans (id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, runner_id) REFERENCES runners (workspace_id, id)
);

-- An assertion row exists only inside a transaction. A failed SQL predicate aborts
-- the entire D1 batch, including its command audit, cursor, and idempotency result.
CREATE TABLE runner_mutation_guards (
  id TEXT NOT NULL PRIMARY KEY,
  valid INTEGER NOT NULL CHECK (valid = 1)
);
