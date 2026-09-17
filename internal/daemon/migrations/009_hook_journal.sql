-- ABOUTME: Persists the L06 hook journal: upload streams, durable events and observed session bindings.
-- ABOUTME: Deletes or quarantines rows only from explicit server dispositions, never from replay cursors.

CREATE TABLE hook_source_streams (
    runner_id TEXT PRIMARY KEY,
    stream_id TEXT NOT NULL,
    epoch TEXT NOT NULL,
    next_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_sequence BETWEEN 1 AND 9007199254740991),
    failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
    next_attempt_at TEXT NOT NULL
) STRICT;

CREATE TABLE hook_journal (
    event_id TEXT PRIMARY KEY,
    stream_id TEXT NOT NULL,
    source_sequence INTEGER NOT NULL CHECK (source_sequence BETWEEN 1 AND 9007199254740991),
    runner_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    assignment_generation INTEGER NOT NULL CHECK (assignment_generation BETWEEN 1 AND 9007199254740991),
    provider TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('launch_claimed','launch_blocked','execution_attached','execution_detached','execution_ended','session_started','session_resumed','session_ended','turn_started','turn_stopped','turn_failed','tool_started','tool_finished','tool_failed','progress_reported','attention_requested','subagent_started','subagent_ended','context_compacted','artifact_published','result_submitted','run_failed','run_cancelled','heartbeat')),
    provider_session_id TEXT NOT NULL DEFAULT '',
    source_event_id TEXT NOT NULL DEFAULT '',
    occurred_at TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    capture_origin TEXT NOT NULL CHECK (capture_origin IN ('runner_observed','agent_reported','hook_inbox')),
    submission_json TEXT NOT NULL CHECK (length(submission_json) <= 65536 AND json_valid(submission_json)),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    UNIQUE (stream_id, source_sequence)
) STRICT;

CREATE UNIQUE INDEX hook_journal_source_event
ON hook_journal (execution_id, assignment_generation, source_event_id)
WHERE source_event_id != '';

CREATE INDEX hook_journal_upload
ON hook_journal (runner_id, captured_at);

CREATE TABLE hook_observed_sessions (
    execution_id TEXT NOT NULL,
    assignment_generation INTEGER NOT NULL CHECK (assignment_generation BETWEEN 1 AND 9007199254740991),
    provider TEXT NOT NULL,
    session_id TEXT NOT NULL,
    bound_at TEXT NOT NULL,
    PRIMARY KEY (execution_id, assignment_generation)
) STRICT;

CREATE TABLE hook_quarantine (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    assignment_generation INTEGER NOT NULL CHECK (assignment_generation BETWEEN 0 AND 9007199254740991),
    provider TEXT NOT NULL,
    kind TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER hook_journal_capacity
BEFORE INSERT ON hook_journal
WHEN (SELECT count(*) FROM hook_journal) >= 16384
BEGIN
    SELECT RAISE(ABORT, 'hook journal capacity');
END;

CREATE TRIGGER hook_quarantine_capacity
BEFORE INSERT ON hook_quarantine
WHEN (SELECT count(*) FROM hook_quarantine) >= 4096
BEGIN
    SELECT RAISE(ABORT, 'hook quarantine capacity');
END;
