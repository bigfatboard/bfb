-- ABOUTME: Adds artifact storage state machine rows owned by V01.
-- ABOUTME: Upload secrets persist only as hashes; version availability requires a verified receipt.

-- A logical review object. Format and semantic role are separate fields and
-- never change after creation.
CREATE TABLE artifacts (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  run_id TEXT,
  format TEXT NOT NULL CHECK (format IN ('markdown', 'mermaid', 'diff', 'svg', 'png', 'jpeg', 'html', 'log', 'json')),
  role TEXT NOT NULL CHECK (role IN ('review', 'log')),
  created_by_human_id TEXT REFERENCES humans (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TRIGGER artifacts_immutable_update
BEFORE UPDATE ON artifacts BEGIN
  SELECT RAISE(ABORT, 'artifacts are immutable');
END;
CREATE TRIGGER artifacts_immutable_delete
BEFORE DELETE ON artifacts BEGIN
  SELECT RAISE(ABORT, 'artifacts are immutable');
END;

-- One immutable byte publication attempt. Only rows in `available` state may
-- be viewed or reviewed; `uploading` rows hold no trusted bytes and `failed`
-- rows are terminal. Distinct logical versions may share one content hash.
CREATE TABLE artifact_versions (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('uploading', 'available', 'failed')),
  format TEXT NOT NULL CHECK (format IN ('markdown', 'mermaid', 'diff', 'svg', 'png', 'jpeg', 'html', 'log', 'json')),
  declared_size INTEGER NOT NULL CHECK (declared_size >= 0),
  expected_digest TEXT NOT NULL CHECK (length(expected_digest) = 64),
  content_hash TEXT CHECK (content_hash IS NULL OR length(content_hash) = 64),
  r2_key TEXT,
  created_at TEXT NOT NULL,
  available_at TEXT,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (id),
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES artifacts (workspace_id, id),
  CHECK (state != 'available' OR (content_hash IS NOT NULL AND r2_key IS NOT NULL))
);

CREATE INDEX artifact_versions_artifact_idx
  ON artifact_versions (workspace_id, artifact_id);

-- Exactly one state exit from `uploading`. Finalization must carry the
-- verified content hash and server-derived R2 key; abandonment carries neither.
CREATE TRIGGER artifact_versions_state_guarded
BEFORE UPDATE ON artifact_versions
WHEN NOT (
  OLD.state IS 'uploading'
  AND (NEW.state IS 'available' OR NEW.state IS 'failed')
  AND NEW.workspace_id IS OLD.workspace_id
  AND NEW.id IS OLD.id
  AND NEW.artifact_id IS OLD.artifact_id
  AND NEW.format IS OLD.format
  AND NEW.declared_size IS OLD.declared_size
  AND NEW.expected_digest IS OLD.expected_digest
  AND NEW.created_at IS OLD.created_at
  AND (NEW.state IS 'failed' OR (NEW.content_hash IS NOT NULL AND NEW.r2_key IS NOT NULL))
) BEGIN
  SELECT RAISE(ABORT, 'artifact version state transition is not allowed');
END;
CREATE TRIGGER artifact_versions_immutable_delete
BEFORE DELETE ON artifact_versions BEGIN
  SELECT RAISE(ABORT, 'artifact versions are immutable history');
END;

-- One-time upload grants. Only the secret hash persists; the plaintext secret
-- is returned once at creation and never stored. A grant binds principal,
-- authorization epoch, workspace, run, version, format, size, digest, and expiry.
CREATE TABLE artifact_upload_grants (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  grant_hash TEXT NOT NULL CHECK (length(grant_hash) = 64),
  human_id TEXT REFERENCES humans (id) ON DELETE RESTRICT,
  authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch >= 1),
  run_id TEXT,
  format TEXT NOT NULL,
  declared_size INTEGER NOT NULL CHECK (declared_size >= 0),
  expected_digest TEXT NOT NULL CHECK (length(expected_digest) = 64),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (id),
  UNIQUE (grant_hash),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE INDEX artifact_upload_grants_version_idx
  ON artifact_upload_grants (workspace_id, version_id);

-- A grant is consumed at most once and no other field may change afterwards.
CREATE TRIGGER artifact_upload_grants_consume_once
BEFORE UPDATE ON artifact_upload_grants
WHEN NOT (
  OLD.consumed_at IS NULL
  AND NEW.consumed_at IS NOT NULL
  AND NEW.workspace_id IS OLD.workspace_id
  AND NEW.id IS OLD.id
  AND NEW.version_id IS OLD.version_id
  AND NEW.grant_hash IS OLD.grant_hash
  AND NEW.human_id IS OLD.human_id
  AND NEW.authorization_epoch IS OLD.authorization_epoch
  AND NEW.run_id IS OLD.run_id
  AND NEW.format IS OLD.format
  AND NEW.declared_size IS OLD.declared_size
  AND NEW.expected_digest IS OLD.expected_digest
  AND NEW.expires_at IS OLD.expires_at
  AND NEW.created_at IS OLD.created_at
) BEGIN
  SELECT RAISE(ABORT, 'artifact upload grants are single-use');
END;
CREATE TRIGGER artifact_upload_grants_immutable_delete
BEFORE DELETE ON artifact_upload_grants BEGIN
  SELECT RAISE(ABORT, 'artifact upload grants are immutable history');
END;

-- Content-addressed object registry. The UNIQUE hash makes the same-hash
-- publication race atomic: one winner inserts, losers verify instead of
-- overwriting. v0.1 has no blob delete path by design.
CREATE TABLE artifact_objects (
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (content_hash)
);

CREATE TRIGGER artifact_objects_immutable_update
BEFORE UPDATE ON artifact_objects BEGIN
  SELECT RAISE(ABORT, 'artifact objects are immutable');
END;
CREATE TRIGGER artifact_objects_immutable_delete
BEFORE DELETE ON artifact_objects BEGIN
  SELECT RAISE(ABORT, 'artifact objects have no v0.1 delete path');
END;

-- Verified upload receipts written by the Artifact Worker only after the
-- bytes are validated and the R2 object is confirmed. Finalization requires
-- a receipt whose hash and size match the version.
CREATE TABLE artifact_upload_receipts (
  workspace_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  size INTEGER NOT NULL CHECK (size >= 0),
  verified_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, version_id),
  UNIQUE (version_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TRIGGER artifact_upload_receipts_immutable_update
BEFORE UPDATE ON artifact_upload_receipts BEGIN
  SELECT RAISE(ABORT, 'artifact upload receipts are immutable');
END;
CREATE TRIGGER artifact_upload_receipts_immutable_delete
BEFORE DELETE ON artifact_upload_receipts BEGIN
  SELECT RAISE(ABORT, 'artifact upload receipts are immutable history');
END;

-- Durable audit outbox for grant issuance, consumption, upload verification,
-- finalization, and abandonment. Payloads carry hashes and IDs only.
CREATE TABLE artifact_audit_outbox (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  version_id TEXT,
  grant_id TEXT,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE INDEX artifact_audit_outbox_dispatch_idx
  ON artifact_audit_outbox (dispatched_at) WHERE dispatched_at IS NULL;

-- Dispatch may stamp a row once; nothing else may change.
CREATE TRIGGER artifact_audit_outbox_dispatch_once
BEFORE UPDATE ON artifact_audit_outbox
WHEN NOT (
  OLD.dispatched_at IS NULL
  AND NEW.dispatched_at IS NOT NULL
  AND NEW.id IS OLD.id
  AND NEW.workspace_id IS OLD.workspace_id
  AND NEW.version_id IS OLD.version_id
  AND NEW.grant_id IS OLD.grant_id
  AND NEW.action IS OLD.action
  AND NEW.payload_json IS OLD.payload_json
  AND NEW.created_at IS OLD.created_at
) BEGIN
  SELECT RAISE(ABORT, 'artifact audit rows are append-only');
END;
CREATE TRIGGER artifact_audit_outbox_immutable_delete
BEFORE DELETE ON artifact_audit_outbox BEGIN
  SELECT RAISE(ABORT, 'artifact audit rows are append-only');
END;

-- An assertion row exists only inside a transaction. A failed SQL predicate aborts
-- the entire D1 batch, including the grant consumption or finalization it guards.
CREATE TABLE artifact_mutation_guards (
  id TEXT NOT NULL PRIMARY KEY,
  valid INTEGER NOT NULL CHECK (valid = 1)
);
