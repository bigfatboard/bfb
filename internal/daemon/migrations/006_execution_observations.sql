-- ABOUTME: Retains native startup and absence observations independently of pending event delivery.
-- ABOUTME: Prevents observation rewind and bounds durable process events without deleting unimported evidence.

ALTER TABLE local_execution_assignments ADD COLUMN provider_observed_at TEXT;
ALTER TABLE local_execution_assignments ADD COLUMN process_absent_at TEXT;
ALTER TABLE local_execution_assignments ADD COLUMN last_process_observed_at TEXT;

CREATE TRIGGER local_provider_observation_immutable
BEFORE UPDATE OF provider_observed_at ON local_execution_assignments
WHEN OLD.provider_observed_at IS NOT NULL AND (NEW.provider_observed_at IS NULL OR NEW.provider_observed_at != OLD.provider_observed_at)
BEGIN
    SELECT RAISE(ABORT, 'immutable provider observation');
END;

CREATE TRIGGER local_process_absence_immutable
BEFORE UPDATE OF process_absent_at ON local_execution_assignments
WHEN OLD.process_absent_at IS NOT NULL AND (NEW.process_absent_at IS NULL OR NEW.process_absent_at != OLD.process_absent_at)
BEGIN
    SELECT RAISE(ABORT, 'immutable process absence');
END;

CREATE TRIGGER local_observation_sequence_monotonic
BEFORE UPDATE OF event_sequence ON local_execution_assignments
WHEN NEW.event_sequence < OLD.event_sequence
BEGIN
    SELECT RAISE(ABORT, 'execution observation sequence rewind');
END;

CREATE TRIGGER local_process_observation_requires_sequence
BEFORE UPDATE OF last_process_observed_at ON local_execution_assignments
WHEN NEW.last_process_observed_at IS NULL OR NEW.event_sequence <= OLD.event_sequence
BEGIN
    SELECT RAISE(ABORT, 'process observation without sequence');
END;

CREATE TRIGGER execution_observation_capacity
BEFORE INSERT ON execution_observations
WHEN (SELECT count(*) FROM execution_observations) >= 8192
BEGIN
    SELECT RAISE(ABORT, 'execution observation capacity');
END;
