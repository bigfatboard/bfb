-- ABOUTME: Pins a distinct cleanup identity before proving that a command cannot acquire a local supervisor.
-- ABOUTME: Prevents queued launch issuance and completed-command reopening after durable cleanup begins.

ALTER TABLE execution_commands ADD COLUMN cleanup_lock_id TEXT;

CREATE TRIGGER execution_cleanup_identity_immutable
BEFORE UPDATE OF cleanup_lock_id ON execution_commands
WHEN OLD.cleanup_lock_id IS NOT NULL AND (NEW.cleanup_lock_id IS NULL OR NEW.cleanup_lock_id != OLD.cleanup_lock_id)
BEGIN
    SELECT RAISE(ABORT, 'immutable execution cleanup identity');
END;

CREATE TRIGGER execution_command_cannot_reopen
BEFORE UPDATE OF state ON execution_commands
WHEN OLD.state = 'complete' AND NEW.state != 'complete'
BEGIN
    SELECT RAISE(ABORT, 'completed execution command');
END;

CREATE TRIGGER execution_cleanup_prevents_issuance
BEFORE INSERT ON local_execution_assignments
WHEN EXISTS (SELECT 1 FROM execution_commands WHERE runner_id = NEW.runner_id AND command_id = NEW.launch_id
    AND (cleanup_lock_id IS NOT NULL OR state NOT IN ('queued', 'waiting')))
BEGIN
    SELECT RAISE(ABORT, 'execution cleanup already started');
END;
