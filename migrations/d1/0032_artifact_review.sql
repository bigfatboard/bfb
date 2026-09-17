-- ABOUTME: Adds immutable artifact review records owned by V03.
-- ABOUTME: Reviews bind exact version and hash; history is append-only and never mutates versions.

-- One human decision per row on an exact artifact version. The reviewed
-- content hash is bound at decision time and must equal the version's stored
-- hash; a newer available version makes earlier reviews historical without
-- rewriting them. Optional git_commit and config_hash bind the observed
-- repository and configuration facts; optional review_timer_observation_id
-- references an A04 review-timer observation whose duration V03 reads but
-- never computes. Reviews never change artifact bytes, versions, runs,
-- tasks, results, launches, policies, or credentials.
CREATE TABLE artifact_reviews (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  reviewer_human_id TEXT NOT NULL REFERENCES humans (id) ON DELETE RESTRICT,
  authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch >= 1),
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'request_changes', 'comment')),
  comment TEXT CHECK (comment IS NULL OR (length(comment) >= 1 AND length(comment) <= 2048)),
  git_commit TEXT CHECK (git_commit IS NULL OR length(git_commit) = 40),
  config_hash TEXT CHECK (config_hash IS NULL OR (length(config_hash) = 71 AND substr(config_hash, 1, 7) = 'sha256:')),
  review_timer_observation_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (id),
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES artifacts (workspace_id, id),
  FOREIGN KEY (workspace_id, version_id) REFERENCES artifact_versions (workspace_id, id),
  FOREIGN KEY (workspace_id, review_timer_observation_id)
    REFERENCES review_timer_observations (workspace_id, observation_id)
);

CREATE INDEX artifact_reviews_artifact_idx
  ON artifact_reviews (workspace_id, artifact_id, created_at ASC, id ASC);

CREATE INDEX artifact_reviews_version_idx
  ON artifact_reviews (workspace_id, version_id);

-- Reviews are immutable history: no update and no delete path exists.
CREATE TRIGGER artifact_reviews_immutable_update
BEFORE UPDATE ON artifact_reviews BEGIN
  SELECT RAISE(ABORT, 'artifact reviews are immutable');
END;
CREATE TRIGGER artifact_reviews_immutable_delete
BEFORE DELETE ON artifact_reviews BEGIN
  SELECT RAISE(ABORT, 'artifact reviews are immutable history');
END;
