-- ABOUTME: Persists one-time local execution intents, immutable assignments and bounded supervision delivery.
-- ABOUTME: Separates process observations and control effects from cloud run results and connection state.

CREATE TABLE execution_commands (
    runner_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    command_kind TEXT NOT NULL CHECK (command_kind IN ('launch', 'run_control')),
    expires_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    claim_key TEXT NOT NULL,
    claim_started_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'waiting', 'complete', 'containment_unknown')),
    diagnostic TEXT,
    PRIMARY KEY (runner_id, command_id)
) STRICT;

CREATE TABLE local_execution_assignments (
    execution_id TEXT PRIMARY KEY,
    assignment_generation INTEGER NOT NULL CHECK (assignment_generation BETWEEN 1 AND 9007199254740991),
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    runner_id TEXT NOT NULL,
    checkout_id TEXT NOT NULL,
    launch_id TEXT NOT NULL,
    intent_id TEXT NOT NULL UNIQUE,
    physical_worktree_hash TEXT NOT NULL,
    fencing_generation INTEGER NOT NULL CHECK (fencing_generation BETWEEN 1 AND 9007199254740991),
    claim_json TEXT NOT NULL CHECK (length(claim_json) <= 32768 AND json_valid(claim_json)),
    provider_identity_hash TEXT NOT NULL,
    correlation_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('intent_ready', 'offered', 'delivery_unknown', 'registered', 'group_ready', 'running', 'ending', 'ended', 'blocked', 'containment_unknown')),
    supervisor_json TEXT CHECK (supervisor_json IS NULL OR (length(supervisor_json) <= 2048 AND json_valid(supervisor_json))),
    local_lock_id TEXT,
    owned_group_json TEXT CHECK (owned_group_json IS NULL OR (length(owned_group_json) <= 2048 AND json_valid(owned_group_json))),
    event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (event_sequence BETWEEN 0 AND 9007199254740991),
    lease_sequence INTEGER NOT NULL DEFAULT 0 CHECK (lease_sequence BETWEEN 0 AND 9007199254740991),
    event_window_ends_at TEXT,
    diagnostic TEXT,
    UNIQUE (runner_id, launch_id),
    UNIQUE (execution_id, assignment_generation),
    FOREIGN KEY (runner_id, launch_id) REFERENCES execution_commands(runner_id, command_id)
) STRICT;

CREATE TRIGGER local_execution_identity_immutable
BEFORE UPDATE OF execution_id, assignment_generation, workspace_id, project_id, task_id,
    run_id, runner_id, checkout_id, launch_id, intent_id, physical_worktree_hash,
    fencing_generation, provider_identity_hash, correlation_token, created_at, expires_at
ON local_execution_assignments
BEGIN
    SELECT RAISE(ABORT, 'immutable local execution assignment');
END;

CREATE TRIGGER local_supervisor_identity_immutable
BEFORE UPDATE OF supervisor_json ON local_execution_assignments
WHEN OLD.supervisor_json IS NOT NULL AND (NEW.supervisor_json IS NULL OR NEW.supervisor_json != OLD.supervisor_json)
BEGIN
    SELECT RAISE(ABORT, 'immutable local supervisor identity');
END;

CREATE TRIGGER local_group_identity_immutable
BEFORE UPDATE OF owned_group_json, local_lock_id ON local_execution_assignments
WHEN (OLD.owned_group_json IS NOT NULL AND (NEW.owned_group_json IS NULL OR NEW.owned_group_json != OLD.owned_group_json))
    OR (OLD.local_lock_id IS NOT NULL AND (NEW.local_lock_id IS NULL OR NEW.local_lock_id != OLD.local_lock_id))
BEGIN
    SELECT RAISE(ABORT, 'immutable local group identity');
END;

CREATE TRIGGER local_event_window_cannot_reopen
BEFORE UPDATE OF event_window_ends_at ON local_execution_assignments
WHEN OLD.event_window_ends_at IS NOT NULL AND (NEW.event_window_ends_at IS NULL OR NEW.event_window_ends_at != OLD.event_window_ends_at)
BEGIN
    SELECT RAISE(ABORT, 'immutable local event window end');
END;

CREATE TABLE execution_observations (
    event_id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    assignment_generation INTEGER NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
    observation_json TEXT NOT NULL CHECK (length(observation_json) <= 8192 AND json_valid(observation_json)),
    captured_at TEXT NOT NULL,
    imported_at TEXT,
    UNIQUE (execution_id, assignment_generation, sequence),
    FOREIGN KEY (execution_id, assignment_generation) REFERENCES local_execution_assignments(execution_id, assignment_generation)
) STRICT;

CREATE TABLE execution_control_effects (
    control_id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    assignment_generation INTEGER NOT NULL,
    runner_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('focus_existing', 'resume', 'interrupt', 'terminate', 'cancel')),
    claim_key TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('prepared', 'applying', 'applied', 'rejected', 'delivery_unknown')),
    diagnostic TEXT,
    FOREIGN KEY (execution_id, assignment_generation) REFERENCES local_execution_assignments(execution_id, assignment_generation)
) STRICT;

CREATE INDEX execution_commands_pending ON execution_commands(state, received_at);
CREATE INDEX local_executions_physical ON local_execution_assignments(physical_worktree_hash, state);
CREATE INDEX execution_observations_pending ON execution_observations(imported_at, captured_at);
