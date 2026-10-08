-- ABOUTME: Stores append-only author-private checkpoints with human or exact OAuth origins.
-- ABOUTME: Retains task, owner and delegation provenance without changing ordinary progress records.

CREATE TABLE task_private_checkpoints (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  owner_human_id TEXT NOT NULL,
  origin_delegation_id TEXT,
  origin_client_id TEXT,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2048 AND instr(body, char(0)) = 0),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 71 AND substr(content_hash, 1, 7) = 'sha256:'
    AND substr(content_hash, 8) NOT GLOB '*[^0-9a-f]*' AND instr(content_hash, char(0)) = 0
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CHECK ((origin_delegation_id IS NULL AND origin_client_id IS NULL)
    OR (origin_delegation_id IS NOT NULL AND origin_client_id IS NOT NULL)),
  FOREIGN KEY (workspace_id, project_id, task_id)
    REFERENCES tasks (workspace_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, owner_human_id)
    REFERENCES workspace_authorization_epochs (workspace_id, human_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, origin_delegation_id, origin_client_id)
    REFERENCES oauth_delegations (workspace_id, id, client_id) ON DELETE RESTRICT
);

CREATE INDEX task_private_checkpoints_owner
  ON task_private_checkpoints (workspace_id, task_id, owner_human_id, created_at DESC);

CREATE TRIGGER task_private_checkpoint_sponsor BEFORE INSERT ON task_private_checkpoints
WHEN NEW.origin_delegation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM oauth_delegations WHERE workspace_id = NEW.workspace_id
    AND id = NEW.origin_delegation_id AND client_id = NEW.origin_client_id
    AND human_id = NEW.owner_human_id
)
BEGIN SELECT RAISE(ABORT, 'private checkpoint sponsor mismatch'); END;

CREATE TRIGGER task_private_checkpoint_immutable BEFORE UPDATE ON task_private_checkpoints
BEGIN SELECT RAISE(ABORT, 'private checkpoint is immutable'); END;

CREATE TRIGGER task_private_checkpoint_retained BEFORE DELETE ON task_private_checkpoints
BEGIN SELECT RAISE(ABORT, 'private checkpoint is retained'); END;
