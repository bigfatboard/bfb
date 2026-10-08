-- ABOUTME: Adds one-time artifact view grants owned by V02.
-- ABOUTME: View secrets persist only as hashes; redemption rechecks epoch and version.

-- One-time view grants. Only the secret hash persists; the plaintext secret
-- is returned once at creation and never stored. A grant binds the viewing
-- human, authorization epoch, exact artifact version/content hash, a per-view
-- channel nonce, and expiry. Reloading a preview always mints a new grant.
CREATE TABLE artifact_view_grants (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  grant_hash TEXT NOT NULL CHECK (length(grant_hash) = 64),
  view_nonce_hash TEXT NOT NULL CHECK (length(view_nonce_hash) = 64),
  human_id TEXT REFERENCES humans (id) ON DELETE RESTRICT,
  session_hash TEXT NOT NULL CHECK (length(session_hash) = 64),
  authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch >= 1),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (id),
  UNIQUE (grant_hash),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (workspace_id, version_id) REFERENCES artifact_versions (workspace_id, id)
);

CREATE INDEX artifact_view_grants_version_idx
  ON artifact_view_grants (workspace_id, version_id);

-- A grant is consumed at most once and no other field may change afterwards.
CREATE TRIGGER artifact_view_grants_consume_once
BEFORE UPDATE ON artifact_view_grants
WHEN NOT (
  OLD.consumed_at IS NULL
  AND NEW.consumed_at IS NOT NULL
  AND NEW.workspace_id IS OLD.workspace_id
  AND NEW.id IS OLD.id
  AND NEW.version_id IS OLD.version_id
  AND NEW.grant_hash IS OLD.grant_hash
  AND NEW.view_nonce_hash IS OLD.view_nonce_hash
  AND NEW.human_id IS OLD.human_id
  AND NEW.session_hash IS OLD.session_hash
  AND NEW.authorization_epoch IS OLD.authorization_epoch
  AND NEW.content_hash IS OLD.content_hash
  AND NEW.expires_at IS OLD.expires_at
  AND NEW.created_at IS OLD.created_at
) BEGIN
  SELECT RAISE(ABORT, 'artifact view grants are single-use');
END;
CREATE TRIGGER artifact_view_grants_immutable_delete
BEFORE DELETE ON artifact_view_grants BEGIN
  SELECT RAISE(ABORT, 'artifact view grants are immutable history');
END;
