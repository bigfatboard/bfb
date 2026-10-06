-- ABOUTME: Binds each new upload-grant consumption to one exact immutable attempt.
-- ABOUTME: Historical consumed grants remain unchanged; new same-timestamp racers cannot both win.

CREATE TABLE artifact_upload_consumptions (
  workspace_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL CHECK (
    length(attempt_id) = 26 AND substr(attempt_id, 1, 1) GLOB '[0-7]'
    AND attempt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  consumed_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, grant_id),
  UNIQUE (attempt_id),
  FOREIGN KEY (workspace_id, grant_id)
    REFERENCES artifact_upload_grants (workspace_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER artifact_upload_consumptions_immutable_update
BEFORE UPDATE ON artifact_upload_consumptions BEGIN
  SELECT RAISE(ABORT, 'artifact upload consumptions are immutable');
END;
CREATE TRIGGER artifact_upload_consumptions_immutable_delete
BEFORE DELETE ON artifact_upload_consumptions BEGIN
  SELECT RAISE(ABORT, 'artifact upload consumptions are immutable history');
END;
