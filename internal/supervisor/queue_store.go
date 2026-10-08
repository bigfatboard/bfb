// ABOUTME: Recovers bounded pending commands and serializes unstarted cleanup against intent issuance and registration.
// ABOUTME: Retains original claim and cleanup identities until cloud reconciliation confirms the reservation is settled.

package supervisor

import (
	"context"
	"database/sql"
	"errors"

	"github.com/qdis/bfb/internal/daemon"
)

const commandColumns = `workspace_id,runner_id,command_id,command_kind,expires_at,claim_key,claim_started_at,state,coalesce(cleanup_lock_id,'')`

func scanCommand(row assignmentScanner, command *LocalCommand) error {
	return row.Scan(&command.WorkspaceID, &command.RunnerID, &command.ID, &command.Kind, &command.ExpiresAt,
		&command.ClaimKey, &command.ClaimStartedAt, &command.State, &command.CleanupLockID)
}

// Pending closes its cursor before the caller can query an assignment on the
// daemon's single database connection. In-flight execution does not hold it open.
func (store *IntentStore) Pending(ctx context.Context) ([]LocalCommand, error) {
	return store.pending(ctx, "launch")
}

func (store *IntentStore) pending(ctx context.Context, kind string) ([]LocalCommand, error) {
	rows, err := store.db.QueryContext(ctx, "SELECT "+commandColumns+" FROM execution_commands WHERE state IN ('queued','waiting') AND command_kind = ? ORDER BY received_at,runner_id,command_id LIMIT 256", kind)
	if err != nil {
		return nil, failure("storage_failed")
	}
	defer rows.Close()
	commands := []LocalCommand{}
	for rows.Next() {
		var command LocalCommand
		if scanCommand(rows, &command) != nil {
			return nil, failure("storage_failed")
		}
		commands = append(commands, command)
	}
	if rows.Err() != nil {
		return nil, failure("storage_failed")
	}
	return commands, nil
}

func (store *IntentStore) ByCommand(ctx context.Context, command LocalCommand) (*LocalAssignment, error) {
	var intent string
	err := store.db.QueryRowContext(ctx, "SELECT intent_id FROM local_execution_assignments WHERE runner_id = ? AND launch_id = ?", command.RunnerID, command.ID).Scan(&intent)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, failure("storage_failed")
	}
	assignment, err := store.ByIntent(ctx, intent)
	if err != nil {
		return nil, err
	}
	if assignment.Claim.Assignment.WorkspaceId != command.WorkspaceID || assignment.Claim.Specification.ExpiresAt != command.ExpiresAt {
		return nil, failure("execution_assignment_invalid")
	}
	return &assignment, nil
}

func (store *IntentStore) Wait(ctx context.Context, command LocalCommand, reason error) error {
	var diagnostic any
	if reason != nil {
		diagnostic = daemon.AsFailure(reason).Code
	}
	_, err := store.db.ExecContext(ctx, `UPDATE execution_commands SET state = 'waiting', diagnostic = ?
WHERE runner_id = ? AND command_id = ? AND state IN ('queued','waiting')`, diagnostic, command.RunnerID, command.ID)
	if err != nil {
		return failure("storage_failed")
	}
	return nil
}

// BeginUnstartedCleanup is the local absence proof: atomically prevent future
// issuance and block any unconsumed helper intent. A racing registration wins
// or loses this transaction; a stale nil-supervisor snapshot is never enough.
// The cleanup ID describes never-acquired lock evidence, not a physical lock.
func (store *IntentStore) BeginUnstartedCleanup(ctx context.Context, command LocalCommand) (LocalCommand, error) {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return LocalCommand{}, failure("storage_failed")
	}
	defer tx.Rollback()
	var current LocalCommand
	if scanCommand(tx.QueryRowContext(ctx, "SELECT "+commandColumns+" FROM execution_commands WHERE runner_id = ? AND command_id = ?", command.RunnerID, command.ID), &current) != nil ||
		current.WorkspaceID != command.WorkspaceID || current.Kind != "launch" || current.ClaimKey != command.ClaimKey || current.ClaimStartedAt != command.ClaimStartedAt || current.ExpiresAt != command.ExpiresAt || (current.State != "queued" && current.State != "waiting") {
		return LocalCommand{}, failure("execution_assignment_invalid")
	}
	var intent string
	err = tx.QueryRowContext(ctx, "SELECT intent_id FROM local_execution_assignments WHERE runner_id = ? AND launch_id = ?", command.RunnerID, command.ID).Scan(&intent)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return LocalCommand{}, failure("storage_failed")
	}
	if err == nil {
		assignment, err := scanAssignment(tx.QueryRowContext(ctx, "SELECT "+assignmentColumns+" FROM local_execution_assignments WHERE intent_id = ?", intent))
		if err != nil {
			return LocalCommand{}, err
		}
		if assignment.Supervisor != nil || assignment.LockID != "" || assignment.Group != nil ||
			(assignment.State != "intent_ready" && assignment.State != "offered" && assignment.State != "delivery_unknown" && assignment.State != "blocked") {
			return LocalCommand{}, failure("containment_unknown")
		}
		if _, err = tx.ExecContext(ctx, "UPDATE local_execution_assignments SET state = 'blocked' WHERE intent_id = ?", intent); err != nil {
			return LocalCommand{}, failure("storage_failed")
		}
	}
	if current.CleanupLockID == "" {
		current.CleanupLockID = daemon.NewRequestID()
	}
	if !executionID.MatchString(current.CleanupLockID) {
		return LocalCommand{}, failure("execution_assignment_invalid")
	}
	if _, err = tx.ExecContext(ctx, "UPDATE execution_commands SET state = 'waiting', cleanup_lock_id = ? WHERE runner_id = ? AND command_id = ?", current.CleanupLockID, command.RunnerID, command.ID); err != nil {
		return LocalCommand{}, failure("storage_failed")
	}
	if err = tx.Commit(); err != nil {
		return LocalCommand{}, failure("storage_failed")
	}
	current.State = "waiting"
	return current, nil
}

// CompleteUnstarted follows a bound cloud receipt, never a timeout or status
// code. Its local barrier remains in place after completion and redelivery.
func (store *IntentStore) CompleteUnstarted(ctx context.Context, command LocalCommand) error {
	if !executionID.MatchString(command.CleanupLockID) {
		return failure("execution_assignment_invalid")
	}
	result, err := store.db.ExecContext(ctx, `UPDATE execution_commands SET state = 'complete', diagnostic = NULL
WHERE runner_id = ? AND command_id = ? AND workspace_id = ? AND claim_key = ? AND cleanup_lock_id = ?
AND state IN ('waiting','complete') AND NOT EXISTS (SELECT 1 FROM local_execution_assignments
WHERE runner_id = ? AND launch_id = ? AND (state != 'blocked' OR supervisor_json IS NOT NULL OR local_lock_id IS NOT NULL OR owned_group_json IS NOT NULL))`,
		command.RunnerID, command.ID, command.WorkspaceID, command.ClaimKey, command.CleanupLockID, command.RunnerID, command.ID)
	if err != nil {
		return failure("storage_failed")
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		return failure("execution_assignment_invalid")
	}
	return nil
}
