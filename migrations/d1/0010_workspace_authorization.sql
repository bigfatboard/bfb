-- ABOUTME: Adds first-owner bootstrap, invitations, retained authorization epochs, and owner guards.
-- ABOUTME: Workspace membership and passkey invariants remain enforced when application checks are bypassed.

CREATE TABLE workspace_authorization_epochs (
  workspace_id TEXT NOT NULL,
  human_id TEXT NOT NULL,
  authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch >= 1),
  revoked_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, human_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (human_id) REFERENCES humans (id) ON DELETE RESTRICT
);

INSERT INTO workspace_authorization_epochs (
  workspace_id, human_id, authorization_epoch, revoked_at, updated_at
)
SELECT workspace_id, human_id, authorization_epoch, NULL, created_at
FROM workspace_members;

CREATE TABLE bootstrap_state (
  id TEXT NOT NULL PRIMARY KEY CHECK (id = 'first_owner'),
  secret_hash TEXT NOT NULL CHECK (length(secret_hash) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumption_stamp TEXT UNIQUE,
  consumed_by_human_id TEXT REFERENCES humans (id) ON DELETE RESTRICT,
  workspace_id TEXT REFERENCES workspaces (id)
);

CREATE TABLE workspace_bootstrap_flows (
  id TEXT NOT NULL PRIMARY KEY,
  human_id TEXT NOT NULL REFERENCES humans (id) ON DELETE RESTRICT,
  auth_user_id TEXT NOT NULL REFERENCES better_auth_users (id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES better_auth_sessions (id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('reauth_pending', 'ready', 'consumed')),
  completion_hash TEXT CHECK (completion_hash IS NULL OR length(completion_hash) = 64),
  created_at TEXT NOT NULL,
  reauthenticated_at TEXT,
  expires_at TEXT NOT NULL,
  consumption_stamp TEXT UNIQUE
);

CREATE INDEX workspace_bootstrap_flows_human_state_idx
  ON workspace_bootstrap_flows (human_id, state, expires_at);

CREATE TABLE workspace_bootstrap_claims (
  state_id TEXT NOT NULL PRIMARY KEY REFERENCES bootstrap_state (id),
  workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces (id),
  claimed_at TEXT NOT NULL
);

CREATE TABLE workspace_invitations (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  normalized_email TEXT NOT NULL CHECK (
    normalized_email = lower(trim(normalized_email))
    AND length(normalized_email) BETWEEN 3 AND 254
  ),
  role TEXT NOT NULL CHECK (role IN ('member', 'reviewer')),
  secret_hash TEXT NOT NULL CHECK (length(secret_hash) = 64),
  created_by_human_id TEXT NOT NULL REFERENCES humans (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by_human_id TEXT REFERENCES humans (id) ON DELETE RESTRICT,
  revoked_at TEXT,
  consumption_stamp TEXT UNIQUE,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE INDEX workspace_invitations_email_idx
  ON workspace_invitations (normalized_email, expires_at);

CREATE TRIGGER better_auth_passkeys_identity_immutable
BEFORE UPDATE OF id, user_id, credential_id ON better_auth_passkeys
FOR EACH ROW
WHEN NEW.id IS NOT OLD.id
  OR NEW.user_id IS NOT OLD.user_id
  OR NEW.credential_id IS NOT OLD.credential_id
BEGIN
  SELECT RAISE(ABORT, 'passkey identity is immutable');
END;

CREATE TRIGGER workspace_members_identity_immutable
BEFORE UPDATE OF workspace_id, human_id ON workspace_members
FOR EACH ROW
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.human_id IS NOT OLD.human_id
BEGIN
  SELECT RAISE(ABORT, 'workspace membership identity is immutable');
END;

CREATE TRIGGER workspace_members_insert_collision
BEFORE INSERT ON workspace_members
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM workspace_members
  WHERE workspace_id = NEW.workspace_id AND human_id = NEW.human_id
)
BEGIN
  SELECT RAISE(ABORT, 'workspace membership rows cannot be replaced');
END;

CREATE TRIGGER workspace_members_final_owner_delete
BEFORE DELETE ON workspace_members
FOR EACH ROW
WHEN OLD.role = 'owner'
  AND NOT EXISTS (
    SELECT 1 FROM workspace_members
    WHERE workspace_id = OLD.workspace_id
      AND human_id != OLD.human_id
      AND role = 'owner'
  )
BEGIN
  SELECT RAISE(ABORT, 'final workspace owner cannot be removed');
END;

CREATE TRIGGER workspace_members_final_owner_demote
BEFORE UPDATE OF role ON workspace_members
FOR EACH ROW
WHEN OLD.role = 'owner'
  AND NEW.role != 'owner'
  AND NOT EXISTS (
    SELECT 1 FROM workspace_members
    WHERE workspace_id = OLD.workspace_id
      AND human_id != OLD.human_id
      AND role = 'owner'
  )
BEGIN
  SELECT RAISE(ABORT, 'final workspace owner cannot be demoted');
END;

CREATE TRIGGER better_auth_passkeys_workspace_owner_final_delete
BEFORE DELETE ON better_auth_passkeys
FOR EACH ROW
WHEN EXISTS (
    SELECT 1
    FROM humans
    JOIN workspace_members ON workspace_members.human_id = humans.id
    WHERE humans.better_auth_user_id = OLD.user_id
      AND workspace_members.role = 'owner'
  )
  AND (
    SELECT COUNT(*) FROM better_auth_passkeys WHERE user_id = OLD.user_id
  ) <= 1
BEGIN
  SELECT RAISE(ABORT, 'workspace owner cannot remove final passkey');
END;

CREATE TRIGGER better_auth_passkeys_workspace_owner_final_replace
BEFORE INSERT ON better_auth_passkeys
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM better_auth_passkeys AS existing
  JOIN humans ON humans.better_auth_user_id = existing.user_id
  JOIN workspace_members ON workspace_members.human_id = humans.id
  WHERE (existing.id = NEW.id OR existing.credential_id = NEW.credential_id)
    AND workspace_members.role = 'owner'
    AND (
      SELECT COUNT(*) FROM better_auth_passkeys
      WHERE user_id = existing.user_id
    ) <= 1
)
BEGIN
  SELECT RAISE(ABORT, 'workspace owner final passkey cannot be replaced');
END;
