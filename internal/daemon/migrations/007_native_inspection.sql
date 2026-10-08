-- ABOUTME: Retains bounded daemon-observed process history independently of the supervisor's lock record.
-- ABOUTME: Preserves containment uncertainty across event-capacity failures, daemon restart and local recovery.

CREATE TABLE execution_native_history (
    execution_id TEXT PRIMARY KEY REFERENCES local_execution_assignments(execution_id),
    history_json TEXT NOT NULL CHECK (length(history_json) <= 65536 AND json_valid(history_json))
) STRICT;
