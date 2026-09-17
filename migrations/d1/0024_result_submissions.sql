-- ABOUTME: Persists immutable per-run result submissions and human review decisions.
-- ABOUTME: Rows are never updated or deleted; outdated state is computed on read, never stored.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE result_submissions (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 2048),
  limitations TEXT NOT NULL DEFAULT '' CHECK (length(limitations) <= 2048),
  evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json)),
  git_branch TEXT CHECK (git_branch IS NULL OR length(git_branch) BETWEEN 1 AND 256),
  git_commit TEXT CHECK (git_commit IS NULL OR (length(git_commit) = 40 AND git_commit GLOB '[0-9a-f]*')),
  git_dirty INTEGER CHECK (git_dirty IS NULL OR git_dirty IN (0, 1)),
  config_snapshot_id TEXT NOT NULL,
  config_hash TEXT NOT NULL CHECK (config_hash GLOB 'sha256:[0-9a-f]*' AND length(config_hash) = 71),
  submitted_by_kind TEXT NOT NULL CHECK (submitted_by_kind IN ('agent_run', 'human')),
  submitted_by_id TEXT NOT NULL CHECK (length(submitted_by_id) BETWEEN 1 AND 128),
  submitted_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, run_id, version),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs (workspace_id, id),
  FOREIGN KEY (workspace_id, config_snapshot_id)
    REFERENCES run_configuration_snapshots (workspace_id, id)
);

CREATE TABLE result_reviews (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  submission_version INTEGER NOT NULL CHECK (submission_version >= 1),
  decision TEXT NOT NULL CHECK (decision IN ('request_changes', 'accept')),
  reviewer_human_id TEXT NOT NULL,
  comment TEXT CHECK (comment IS NULL OR length(comment) BETWEEN 1 AND 2048),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES runs (workspace_id, id),
  FOREIGN KEY (workspace_id, submission_id) REFERENCES result_submissions (workspace_id, id),
  FOREIGN KEY (reviewer_human_id) REFERENCES humans (id)
);

CREATE TRIGGER result_submissions_immutable_update
BEFORE UPDATE ON result_submissions BEGIN
  SELECT RAISE(ABORT, 'result submissions are immutable');
END;
CREATE TRIGGER result_submissions_immutable_delete
BEFORE DELETE ON result_submissions BEGIN
  SELECT RAISE(ABORT, 'result submissions cannot be deleted');
END;

CREATE TRIGGER result_reviews_immutable_update
BEFORE UPDATE ON result_reviews BEGIN
  SELECT RAISE(ABORT, 'result reviews are immutable');
END;
CREATE TRIGGER result_reviews_immutable_delete
BEFORE DELETE ON result_reviews BEGIN
  SELECT RAISE(ABORT, 'result reviews cannot be deleted');
END;
