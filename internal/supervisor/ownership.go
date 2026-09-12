// ABOUTME: Pins verified supervisor lock and child identities before final authorization or provider execution.
// ABOUTME: Preserves original ownership across duplicate RPC delivery and lost cloud responses.

package supervisor

import (
	"context"
	"encoding/json"
	"time"
)

// PinOwnership accepts only native identities already checked by the service.
// Its transaction never spans network I/O or hands signal authority to the daemon.
func (store *IntentStore) PinOwnership(ctx context.Context, intent string, owner SupervisorIdentity, lockID string, group *Process, now time.Time) (LocalAssignment, error) {
	if !terminalIntent.MatchString(intent) || !owner.valid() || !executionID.MatchString(lockID) {
		return LocalAssignment{}, failure("execution_assignment_invalid")
	}
	if group != nil && (!validRecordedProcess(*group) || group.Zombie || group.GroupID != group.PID || group.ParentPID != owner.Process.PID) {
		return LocalAssignment{}, failure("containment_unknown")
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return LocalAssignment{}, failure("storage_failed")
	}
	defer tx.Rollback()
	assignment, err := scanAssignment(tx.QueryRowContext(ctx, "SELECT "+assignmentColumns+" FROM local_execution_assignments WHERE intent_id = ?", intent))
	if err != nil {
		return LocalAssignment{}, err
	}
	if assignment.Supervisor == nil || *assignment.Supervisor != owner || (assignment.State != "registered" && assignment.State != "group_ready") || (assignment.LockID != "" && assignment.LockID != lockID) || (group != nil && assignment.Group != nil && *group != *assignment.Group) {
		return LocalAssignment{}, failure("execution_assignment_invalid")
	}
	wire, err := assignment.wire()
	if err != nil {
		return LocalAssignment{}, err
	}
	if _, err := launchDeadline(wire, now); err != nil {
		return LocalAssignment{}, err
	}
	if group == nil {
		_, err = tx.ExecContext(ctx, "UPDATE local_execution_assignments SET local_lock_id = ? WHERE intent_id = ?", lockID, intent)
	} else {
		// A group is recorded only after the first final request has pinned its
		// lock. A retry may preserve it but can never replace or clear it.
		if assignment.LockID != lockID {
			return LocalAssignment{}, failure("execution_assignment_invalid")
		}
		encoded, _ := json.Marshal(group)
		_, err = tx.ExecContext(ctx, "UPDATE local_execution_assignments SET owned_group_json = ?, state = 'group_ready' WHERE intent_id = ?", string(encoded), intent)
	}
	if err != nil || tx.Commit() != nil {
		return LocalAssignment{}, failure("storage_failed")
	}
	assignment.LockID = lockID
	if group != nil {
		leader := *group
		assignment.Group, assignment.State = &leader, "group_ready"
	}
	return assignment, nil
}
