-- ABOUTME: Persists the immutable runner event ledger, raw measurement observations, and cursor-guarded projections.
-- ABOUTME: Ledger rows are never updated or deleted; projections are absolute version-guarded upserts owned by E01 ingest.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE event_ledger (
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  workspace_cursor INTEGER NOT NULL CHECK (workspace_cursor >= 1),
  source_stream_id TEXT NOT NULL,
  source_sequence INTEGER NOT NULL CHECK (source_sequence >= 1),
  source_event_id TEXT,
  run_execution_id TEXT NOT NULL,
  assignment_generation INTEGER NOT NULL CHECK (assignment_generation >= 1),
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  provider_session_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('runner', 'agent_run')),
  actor_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('runner')),
  source_id TEXT NOT NULL,
  source_provider TEXT CHECK (source_provider IN ('claude', 'codex', 'grok', 'fake')),
  capture_origin TEXT NOT NULL CHECK (capture_origin IN ('runner_observed', 'agent_reported', 'hook_inbox')),
  kind TEXT NOT NULL CHECK (kind IN (
    'launch_claimed', 'launch_blocked', 'execution_attached', 'execution_detached', 'execution_ended',
    'session_started', 'session_resumed', 'session_ended',
    'turn_started', 'turn_stopped', 'turn_failed',
    'tool_started', 'tool_finished', 'tool_failed',
    'progress_reported', 'attention_requested',
    'subagent_started', 'subagent_ended', 'context_compacted',
    'artifact_published', 'result_submitted', 'run_failed', 'run_cancelled', 'heartbeat'
  )),
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (workspace_id, event_id),
  UNIQUE (workspace_id, workspace_cursor),
  UNIQUE (workspace_id, source_stream_id, source_sequence),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (workspace_id, run_execution_id, assignment_generation)
    REFERENCES execution_assignments (workspace_id, execution_id, assignment_generation)
);
CREATE TRIGGER event_ledger_immutable_update
BEFORE UPDATE ON event_ledger BEGIN
  SELECT RAISE(ABORT, 'event ledger rows are immutable');
END;
CREATE TRIGGER event_ledger_immutable_delete
BEFORE DELETE ON event_ledger BEGIN
  SELECT RAISE(ABORT, 'event ledger rows cannot be deleted');
END;

CREATE TABLE measurement_observations (
  workspace_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  run_execution_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  measure_kind TEXT NOT NULL,
  capture_origin TEXT NOT NULL CHECK (capture_origin IN ('runner_observed', 'agent_reported', 'hook_inbox')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('runner', 'agent_run')),
  actor_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  committed_cursor INTEGER NOT NULL CHECK (committed_cursor >= 1),
  PRIMARY KEY (workspace_id, observation_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (workspace_id, observation_id) REFERENCES event_ledger (workspace_id, event_id)
);
CREATE TRIGGER measurement_observations_immutable_update
BEFORE UPDATE ON measurement_observations BEGIN
  SELECT RAISE(ABORT, 'measurement observations are immutable');
END;
CREATE TRIGGER measurement_observations_immutable_delete
BEFORE DELETE ON measurement_observations BEGIN
  SELECT RAISE(ABORT, 'measurement observations cannot be deleted');
END;

CREATE TABLE run_event_projections (
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  last_cursor INTEGER NOT NULL CHECK (last_cursor >= 1),
  event_count INTEGER NOT NULL CHECK (event_count >= 0),
  last_kind TEXT NOT NULL,
  last_occurred_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, run_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE execution_event_projections (
  workspace_id TEXT NOT NULL,
  run_execution_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  last_cursor INTEGER NOT NULL CHECK (last_cursor >= 1),
  event_count INTEGER NOT NULL CHECK (event_count >= 0),
  last_kind TEXT NOT NULL,
  last_occurred_at TEXT NOT NULL,
  heartbeat_count INTEGER NOT NULL CHECK (heartbeat_count >= 0),
  last_heartbeat_at TEXT,
  last_heartbeat_cursor INTEGER CHECK (last_heartbeat_cursor IS NULL OR last_heartbeat_cursor >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, run_execution_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE session_event_projections (
  workspace_id TEXT NOT NULL,
  run_execution_id TEXT NOT NULL,
  provider_session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  last_cursor INTEGER NOT NULL CHECK (last_cursor >= 1),
  event_count INTEGER NOT NULL CHECK (event_count >= 0),
  last_kind TEXT NOT NULL,
  last_occurred_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, run_execution_id, provider_session_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE event_kind_counters (
  workspace_id TEXT NOT NULL,
  run_execution_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  event_count INTEGER NOT NULL CHECK (event_count >= 0),
  last_cursor INTEGER NOT NULL CHECK (last_cursor >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, run_execution_id, kind),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);
