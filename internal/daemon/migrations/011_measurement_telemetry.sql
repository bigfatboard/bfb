-- ABOUTME: Retains bounded immutable telemetry phase identities independently of pending upload rows.
-- ABOUTME: Adds local workspace attribution without rewriting historical event or protected journal bytes.

ALTER TABLE hook_journal ADD COLUMN workspace_id TEXT NOT NULL DEFAULT '';

CREATE TABLE hook_telemetry_identities (
    execution_id TEXT NOT NULL,
    assignment_generation INTEGER NOT NULL CHECK (assignment_generation BETWEEN 1 AND 9007199254740991),
    provider_session_id TEXT NOT NULL,
    family TEXT NOT NULL CHECK (family IN ('turn','tool','tokens')),
    activity_id TEXT NOT NULL CHECK (length(activity_id) BETWEEN 1 AND 128),
    phase TEXT NOT NULL CHECK (phase IN ('start','end','turn_delta')),
    fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
    event_id TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    PRIMARY KEY (execution_id, assignment_generation, provider_session_id, family, activity_id, phase)
) STRICT;

CREATE TRIGGER hook_telemetry_identity_capacity
BEFORE INSERT ON hook_telemetry_identities
WHEN (SELECT count(*) FROM hook_telemetry_identities) >= 16384
BEGIN
    SELECT RAISE(ABORT, 'telemetry identity capacity');
END;

CREATE TRIGGER hook_telemetry_identity_immutable_update
BEFORE UPDATE ON hook_telemetry_identities
BEGIN
    SELECT RAISE(ABORT, 'telemetry identity immutable');
END;

CREATE TRIGGER hook_telemetry_identity_immutable_delete
BEFORE DELETE ON hook_telemetry_identities
BEGIN
    SELECT RAISE(ABORT, 'telemetry identity immutable');
END;
