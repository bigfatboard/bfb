-- ABOUTME: Pins each run control to one execution, claim and optional resumed launch before delivery.
-- ABOUTME: Retains the effect-start checkpoint and prevents uncertain or completed effects from reopening.

ALTER TABLE execution_control_effects ADD COLUMN resume_launch_id TEXT
    CHECK (resume_launch_id IS NULL OR action = 'resume');
ALTER TABLE execution_control_effects ADD COLUMN effect_started_at TEXT;

CREATE TRIGGER execution_control_identity_immutable
BEFORE UPDATE OF control_id, execution_id, assignment_generation, runner_id, action, claim_key, expires_at
ON execution_control_effects
BEGIN
    SELECT RAISE(ABORT, 'immutable execution control identity');
END;

CREATE TRIGGER execution_control_resume_immutable
BEFORE UPDATE OF resume_launch_id ON execution_control_effects
WHEN OLD.resume_launch_id IS NOT NULL AND NEW.resume_launch_id IS NOT OLD.resume_launch_id
BEGIN
    SELECT RAISE(ABORT, 'immutable resumed launch identity');
END;

CREATE TRIGGER execution_control_start_immutable
BEFORE UPDATE OF effect_started_at ON execution_control_effects
WHEN (OLD.effect_started_at IS NOT NULL AND NEW.effect_started_at IS NOT OLD.effect_started_at)
    OR (OLD.effect_started_at IS NULL AND NEW.effect_started_at IS NOT NULL
        AND (OLD.state != 'prepared' OR NEW.state != 'applying'))
BEGIN
    SELECT RAISE(ABORT, 'immutable execution control delivery');
END;

CREATE TRIGGER execution_control_cannot_reopen
BEFORE UPDATE OF state ON execution_control_effects
WHEN (OLD.state IN ('applied', 'rejected', 'delivery_unknown') AND NEW.state != OLD.state)
    OR (OLD.state = 'applying' AND NEW.state = 'prepared')
    OR (OLD.state = 'prepared' AND NEW.state = 'applied')
    OR (NEW.state = 'applying' AND NEW.effect_started_at IS NULL)
BEGIN
    SELECT RAISE(ABORT, 'execution control cannot replay');
END;

CREATE INDEX execution_controls_pending ON execution_control_effects(execution_id, state, control_id);
