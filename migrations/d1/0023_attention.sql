-- ABOUTME: Persists typed human attention requests with permission, blocking, and resolution state.
-- ABOUTME: Raw per-transition observations stay immutable for A04; request rows advance open to answered to resolved.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE attention_requests (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  run_execution_id TEXT NOT NULL,
  assignment_generation INTEGER NOT NULL CHECK (assignment_generation >= 1),
  kind TEXT NOT NULL CHECK (kind IN (
    'clarification', 'review', 'credential', 'capability', 'destructive_action', 'blocker'
  )),
  required_role TEXT NOT NULL CHECK (required_role IN ('reviewer', 'member', 'owner')),
  reference_kind TEXT CHECK (reference_kind IS NULL OR (length(reference_kind) >= 1 AND length(reference_kind) <= 64)),
  reference_id TEXT CHECK (reference_id IS NULL OR (length(reference_id) >= 1 AND length(reference_id) <= 128)),
  question TEXT NOT NULL CHECK (length(question) >= 1 AND length(question) <= 2048),
  blocking INTEGER NOT NULL CHECK (blocking IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('open', 'answered', 'resolved')),
  answer TEXT CHECK (answer IS NULL OR (length(answer) >= 1 AND length(answer) <= 2048)),
  answered_by_human_id TEXT,
  requested_at TEXT NOT NULL,
  first_response_at TEXT,
  answered_at TEXT,
  resolved_at TEXT,
  resource_version INTEGER NOT NULL CHECK (resource_version >= 1),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (workspace_id, run_execution_id, assignment_generation)
    REFERENCES execution_assignments (workspace_id, execution_id, assignment_generation)
);

CREATE INDEX attention_requests_workspace_listing
  ON attention_requests (workspace_id, state, blocking DESC, kind, requested_at ASC, id ASC);

CREATE TABLE attention_observations (
  workspace_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  attention_id TEXT NOT NULL,
  observed_kind TEXT NOT NULL CHECK (observed_kind IN ('requested', 'answered', 'resolved')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('runner', 'agent_run', 'human')),
  actor_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, observation_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (workspace_id, attention_id) REFERENCES attention_requests (workspace_id, id)
);

CREATE INDEX attention_observations_attention
  ON attention_observations (workspace_id, attention_id, occurred_at ASC, observation_id ASC);

CREATE TRIGGER attention_observations_immutable_update
BEFORE UPDATE ON attention_observations BEGIN
  SELECT RAISE(ABORT, 'attention observations are immutable');
END;
CREATE TRIGGER attention_observations_immutable_delete
BEFORE DELETE ON attention_observations BEGIN
  SELECT RAISE(ABORT, 'attention observations cannot be deleted');
END;
