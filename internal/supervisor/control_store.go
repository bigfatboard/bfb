// ABOUTME: Durably binds run controls and records one-way local effect delivery before native actions.
// ABOUTME: Retains original claims and uncertain outcomes across restart without inferring effects from cloud receipts.

package supervisor

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/qdis/bfb/internal/protocol/generated"
)

type controlEffect struct {
	ID, ExecutionID, RunnerID, Action, ClaimKey, ExpiresAt, State string
	ResumeLaunchID, StartedAt                                     string
	Generation                                                    int64
}

const controlColumns = `control_id,execution_id,assignment_generation,runner_id,action,claim_key,expires_at,state,coalesce(resume_launch_id,''),coalesce(effect_started_at,'')`

func scanControl(row assignmentScanner) (controlEffect, error) {
	var effect controlEffect
	err := row.Scan(&effect.ID, &effect.ExecutionID, &effect.Generation, &effect.RunnerID, &effect.Action, &effect.ClaimKey, &effect.ExpiresAt, &effect.State, &effect.ResumeLaunchID, &effect.StartedAt)
	return effect, err
}

func (store *IntentStore) control(ctx context.Context, command LocalCommand) (*controlEffect, error) {
	effect, err := scanControl(store.db.QueryRowContext(ctx, "SELECT "+controlColumns+" FROM execution_control_effects WHERE control_id = ?", command.ID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, failure("storage_failed")
	}
	if command.Kind != "run_control" || command.CleanupLockID != "" || effect.RunnerID != command.RunnerID || effect.ClaimKey != command.ClaimKey || effect.ExpiresAt != command.ExpiresAt {
		return nil, failure("execution_assignment_invalid")
	}
	return &effect, nil
}

func currentControlCommand(ctx context.Context, tx *sql.Tx, expected LocalCommand) (LocalCommand, error) {
	var command LocalCommand
	err := scanCommand(tx.QueryRowContext(ctx, "SELECT "+commandColumns+" FROM execution_commands WHERE runner_id = ? AND command_id = ?", expected.RunnerID, expected.ID), &command)
	if err != nil || command.WorkspaceID != expected.WorkspaceID || command.Kind != "run_control" || command.CleanupLockID != "" ||
		command.ClaimKey != expected.ClaimKey || command.ClaimStartedAt != expected.ClaimStartedAt || command.ExpiresAt != expected.ExpiresAt ||
		(command.State != "queued" && command.State != "waiting") {
		return LocalCommand{}, failure("execution_assignment_invalid")
	}
	return command, nil
}

// rememberControl pins metadata, not permission to execute. Both initial reads
// and fresh claims must name the same local assignment and original claim key.
func (store *IntentStore) rememberControl(ctx context.Context, command LocalCommand, receipt generated.RunControlResult) (controlEffect, error) {
	return store.persistControl(ctx, command, receipt, false)
}

func (store *IntentStore) persistControl(ctx context.Context, command LocalCommand, receipt generated.RunControlResult, complete bool) (controlEffect, error) {
	data, err := wireJSON("run-control-result", receipt)
	if err != nil {
		return controlEffect{}, err
	}
	if _, err = controlOutcome(data, command); err != nil {
		return controlEffect{}, err
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return controlEffect{}, failure("storage_failed")
	}
	defer tx.Rollback()
	if _, err = currentControlCommand(ctx, tx, command); err != nil {
		return controlEffect{}, err
	}
	if complete {
		var exists bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS (SELECT 1 FROM local_execution_assignments WHERE execution_id = ? AND assignment_generation = ?)", receipt.RunExecutionId, receipt.AssignmentGeneration).Scan(&exists); err != nil {
			return controlEffect{}, failure("storage_failed")
		}
		if !exists {
			// Terminal cloud receipts close only inbox delivery. No assignment means
			// there can be no local effect for this target; an existing differently
			// bound effect must not be hidden by a retargeted terminal receipt.
			var count int
			if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM execution_control_effects WHERE control_id = ?", command.ID).Scan(&count); err != nil || count != 0 {
				return controlEffect{}, failure("execution_assignment_invalid")
			}
			if _, err := tx.ExecContext(ctx, "UPDATE execution_commands SET state = 'complete', diagnostic = NULL WHERE runner_id = ? AND command_id = ?", command.RunnerID, command.ID); err != nil || tx.Commit() != nil {
				return controlEffect{}, failure("storage_failed")
			}
			return controlEffect{}, nil
		}
	}
	assignment, err := scanAssignment(tx.QueryRowContext(ctx, "SELECT "+assignmentColumns+" FROM local_execution_assignments WHERE execution_id = ? AND assignment_generation = ?", receipt.RunExecutionId, receipt.AssignmentGeneration))
	if err != nil || assignment.Claim.Assignment.WorkspaceId != command.WorkspaceID || assignment.Claim.Assignment.RunnerId != command.RunnerID {
		return controlEffect{}, failure("execution_assignment_invalid")
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO execution_control_effects
(control_id,execution_id,assignment_generation,runner_id,action,claim_key,expires_at,state)
VALUES (?,?,?,?,?,?,?,'prepared') ON CONFLICT(control_id) DO NOTHING`,
		command.ID, receipt.RunExecutionId, receipt.AssignmentGeneration, command.RunnerID, receipt.Action, command.ClaimKey, command.ExpiresAt)
	if err != nil {
		return controlEffect{}, failure("storage_failed")
	}
	effect, err := scanControl(tx.QueryRowContext(ctx, "SELECT "+controlColumns+" FROM execution_control_effects WHERE control_id = ?", command.ID))
	if err != nil || !effect.matches(command, receipt) {
		return controlEffect{}, failure("execution_assignment_invalid")
	}
	if effect.ResumeLaunchID == "" && receipt.ResumeLaunchId != nil {
		effect.ResumeLaunchID = *receipt.ResumeLaunchId
		if _, err = tx.ExecContext(ctx, "UPDATE execution_control_effects SET resume_launch_id = ? WHERE control_id = ?", effect.ResumeLaunchID, effect.ID); err != nil {
			return controlEffect{}, failure("storage_failed")
		}
	}
	if complete {
		if _, err = tx.ExecContext(ctx, "UPDATE execution_commands SET state = 'complete', diagnostic = NULL WHERE runner_id = ? AND command_id = ?", command.RunnerID, command.ID); err != nil {
			return controlEffect{}, failure("storage_failed")
		}
	}
	if err = tx.Commit(); err != nil {
		return controlEffect{}, failure("storage_failed")
	}
	return effect, nil
}

// completeControl closes delivery only. A terminal cloud summary does not
// overwrite the separately recorded local action or resolve containment.
func (store *IntentStore) completeControl(ctx context.Context, command LocalCommand, receipt generated.RunControlResult) error {
	if !controlTerminal(receipt) {
		return failure("execution_assignment_invalid")
	}
	_, err := store.persistControl(ctx, command, receipt, true)
	return err
}

// beginControl follows fresh online and native checks in the effect owner's
// RPC. Its transaction is the last local barrier before delivery, not a signal.
func (store *IntentStore) beginControl(ctx context.Context, command LocalCommand, expected controlEffect, observed LocalAssignment, now time.Time) (controlEffect, error) {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return controlEffect{}, failure("storage_failed")
	}
	defer tx.Rollback()
	if _, err = currentControlCommand(ctx, tx, command); err != nil {
		return controlEffect{}, err
	}
	effect, err := scanControl(tx.QueryRowContext(ctx, "SELECT "+controlColumns+" FROM execution_control_effects WHERE control_id = ?", command.ID))
	if err != nil || effect != expected || effect.State != "prepared" || effect.StartedAt != "" || effect.Action == "resume" ||
		effect.ClaimKey != command.ClaimKey || effect.RunnerID != command.RunnerID || effect.ExpiresAt != command.ExpiresAt {
		return controlEffect{}, failure("execution_assignment_invalid")
	}
	deadline, err := time.Parse(time.RFC3339Nano, effect.ExpiresAt)
	accepted, acceptedErr := time.Parse(time.RFC3339Nano, command.ClaimStartedAt)
	if err != nil || acceptedErr != nil || !now.Before(deadline) || now.Before(accepted) {
		return controlEffect{}, failure("expired_intent")
	}
	assignment, err := scanAssignment(tx.QueryRowContext(ctx, "SELECT "+assignmentColumns+" FROM local_execution_assignments WHERE execution_id = ? AND assignment_generation = ?", effect.ExecutionID, effect.Generation))
	if err != nil || !sameObservedAssignment(assignment, observed) || assignment.Supervisor == nil || assignment.LockID == "" || assignment.Group == nil ||
		(assignment.State != "group_ready" && assignment.State != "running") || assignment.Claim.Assignment.WorkspaceId != command.WorkspaceID || assignment.Claim.Assignment.RunnerId != command.RunnerID {
		return controlEffect{}, failure("execution_assignment_invalid")
	}
	history, err := readNativeHistory(ctx, tx, assignment)
	if err != nil || history.Uncertain || history.LocalReleasedAt != "" || history.Group != nil && (history.Group.Unknown || history.Group.HadEscape || history.Group.Incomplete) {
		return controlEffect{}, failure("containment_unknown")
	}
	effect.State, effect.StartedAt = "applying", localTimestamp(now)
	if _, err = tx.ExecContext(ctx, "UPDATE execution_control_effects SET state = 'applying', effect_started_at = ? WHERE control_id = ?", effect.StartedAt, effect.ID); err != nil || tx.Commit() != nil {
		return controlEffect{}, failure("storage_failed")
	}
	return effect, nil
}

// finishControl accepts only the already authenticated effect owner's result.
// Late acknowledgements after restart cannot turn uncertainty into success.
func (store *IntentStore) finishControl(ctx context.Context, expected controlEffect, disposition string) error {
	state := ""
	switch disposition {
	case "applied":
		state = "applied"
	case "local_rejected":
		state = "rejected"
	case "delivery_unknown":
		state = "delivery_unknown"
	default:
		return failure("invalid_request")
	}
	result, err := store.db.ExecContext(ctx, `UPDATE execution_control_effects SET state = ?
WHERE control_id = ? AND execution_id = ? AND assignment_generation = ? AND runner_id = ? AND claim_key = ?
AND action = ? AND expires_at = ? AND effect_started_at = ? AND state IN ('applying',?)`,
		state, expected.ID, expected.ExecutionID, expected.Generation, expected.RunnerID, expected.ClaimKey, expected.Action, expected.ExpiresAt, expected.StartedAt, state)
	if err != nil {
		return failure("storage_failed")
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 || expected.StartedAt == "" {
		return failure("execution_assignment_invalid")
	}
	return nil
}

func (store *IntentStore) recoverControls(ctx context.Context) error {
	// Resume is reconciled through its single immutable child launch; it is
	// not an ambiguous repeatable native signal or UI action.
	_, err := store.db.ExecContext(ctx, "UPDATE execution_control_effects SET state = 'delivery_unknown' WHERE state = 'applying' AND action != 'resume'")
	if err != nil {
		return failure("storage_failed")
	}
	return nil
}
