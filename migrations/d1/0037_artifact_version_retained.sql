-- ABOUTME: Records retention purges as a terminal artifact version state.
-- ABOUTME: Available log versions whose R2 bytes were purged move to retained; hashes and keys stay.

PRAGMA defer_foreign_keys = ON;

-- Retention deleted per-run raw log R2 objects but left the version
-- `available`, so every sweep re-deleted the missing keys, re-counted their
-- bytes, and viewers could still redeem grants for purged bytes. The
-- `retained` state records the purge on the version row: eligibility and
-- grant redemption already require `available`, so a retained version is
-- never re-listed and never redeemable, while its hash, key, and metadata
-- stay intact as the purge record.
CREATE TABLE artifact_versions_new (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('uploading', 'available', 'failed', 'retained')),
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

INSERT INTO artifact_versions_new (workspace_id, id, artifact_id, state, format, declared_size, expected_digest, content_hash, r2_key, created_at, available_at)
  SELECT workspace_id, id, artifact_id, state, format, declared_size, expected_digest, content_hash, r2_key, created_at, available_at
  FROM artifact_versions;

DROP TABLE artifact_versions;

ALTER TABLE artifact_versions_new RENAME TO artifact_versions;

CREATE INDEX artifact_versions_artifact_idx
  ON artifact_versions (workspace_id, artifact_id);

-- Exactly one state exit from `uploading`, plus the retention purge exit
-- from `available` to `retained`. Finalization must carry the verified
-- content hash and server-derived R2 key; abandonment carries neither; a
-- purge changes nothing but the state so the hash, key, and metadata stay
-- as the purge record.
CREATE TRIGGER artifact_versions_state_guarded
BEFORE UPDATE ON artifact_versions
WHEN NOT (
  (
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
  ) OR (
    OLD.state IS 'available'
    AND NEW.state IS 'retained'
    AND NEW.workspace_id IS OLD.workspace_id
    AND NEW.id IS OLD.id
    AND NEW.artifact_id IS OLD.artifact_id
    AND NEW.format IS OLD.format
    AND NEW.declared_size IS OLD.declared_size
    AND NEW.expected_digest IS OLD.expected_digest
    AND NEW.content_hash IS OLD.content_hash
    AND NEW.r2_key IS OLD.r2_key
    AND NEW.created_at IS OLD.created_at
    AND NEW.available_at IS OLD.available_at
  )
) BEGIN
  SELECT RAISE(ABORT, 'artifact version state transition is not allowed');
END;
CREATE TRIGGER artifact_versions_immutable_delete
BEFORE DELETE ON artifact_versions BEGIN
  SELECT RAISE(ABORT, 'artifact versions are immutable history');
END;
