-- ABOUTME: Scopes the artifact object registry per workspace and stored key.
-- ABOUTME: Identical bytes in another workspace or log version store a separate object.

PRAGMA defer_foreign_keys = ON;

-- The registry was keyed globally by content hash while R2 keys are per
-- workspace (review) and per version (log), so identical bytes could not be
-- published a second time. The stored object identity is the server-derived
-- R2 key inside its workspace: review re-uploads of identical bytes in one
-- workspace converge on one row, while another workspace or another log
-- version stores a separate row under its own key.
CREATE TABLE artifact_objects_new (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  r2_key TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  size INTEGER NOT NULL CHECK (size >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, r2_key)
);

CREATE INDEX artifact_objects_hash_idx
  ON artifact_objects_new (workspace_id, content_hash);

INSERT INTO artifact_objects_new (workspace_id, r2_key, content_hash, size, created_at)
  SELECT
    substr(substr(r2_key, 12), 1, instr(substr(r2_key, 12), '/') - 1),
    r2_key, content_hash, size, created_at
  FROM artifact_objects;

DROP TABLE artifact_objects;

ALTER TABLE artifact_objects_new RENAME TO artifact_objects;

CREATE TRIGGER artifact_objects_immutable_update
BEFORE UPDATE ON artifact_objects BEGIN
  SELECT RAISE(ABORT, 'artifact objects are immutable');
END;
CREATE TRIGGER artifact_objects_immutable_delete
BEFORE DELETE ON artifact_objects BEGIN
  SELECT RAISE(ABORT, 'artifact objects have no v0.1 delete path');
END;
