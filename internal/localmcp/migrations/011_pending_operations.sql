-- ABOUTME: Journals A01 pending offline business mutations with full replay evidence.
-- ABOUTME: Shares no table with L06 hook state; replay rechecks authority, policy, and versions.

CREATE TABLE IF NOT EXISTS pending_operations (
    request_id TEXT PRIMARY KEY,
    tool TEXT NOT NULL CHECK (tool IN ('bfb_update_task', 'bfb_add_comment', 'bfb_report_progress', 'bfb_propose_task')),
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    runner_id TEXT NOT NULL,
    checkout_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    assignment_generation INTEGER NOT NULL CHECK (assignment_generation >= 1),
    observed_session_id TEXT NOT NULL,
    principal TEXT NOT NULL,
    grant_name TEXT NOT NULL,
    expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
    payload_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    capture_proof TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    policy_decision TEXT NOT NULL CHECK (policy_decision = 'pending_sync'),
    state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'rejected')),
    outcome_json TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS pending_operations_run_state
    ON pending_operations (run_id, state, captured_at);
