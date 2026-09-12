// ABOUTME: Reserves monotonic request-bound lease sequences independently of replayable event sequences.
// ABOUTME: Completes registered launch delivery only after durable native absence proof and process-end capture.

package supervisor

import "context"

func (store *IntentStore) nextLeaseSequence(ctx context.Context, observed LocalAssignment, cloud int64) (int64, error) {
	if cloud < 0 || cloud >= maxObservationSequence {
		return 0, failure("execution_capacity")
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, failure("storage_failed")
	}
	defer tx.Rollback()
	assignment, err := scanAssignment(tx.QueryRowContext(ctx, "SELECT "+assignmentColumns+" FROM local_execution_assignments WHERE intent_id = ?", observed.IntentID))
	if err != nil || !sameObservedAssignment(assignment, observed) || assignment.Supervisor == nil {
		return 0, failure("execution_assignment_invalid")
	}
	if assignment.LockID == "" && !hasPreflightProof(ctx, tx, assignment) {
		return 0, failure("containment_unknown")
	}
	var sequence int64
	if err = tx.QueryRowContext(ctx, `SELECT lease_sequence FROM local_execution_assignments a WHERE intent_id = ?
AND EXISTS (SELECT 1 FROM execution_commands c WHERE c.runner_id = a.runner_id AND c.command_id = a.launch_id AND c.state != 'complete')`, assignment.IntentID).Scan(&sequence); err != nil {
		return 0, failure("execution_assignment_invalid")
	}
	sequence = max(sequence, cloud)
	if sequence >= maxObservationSequence {
		return 0, failure("execution_capacity")
	}
	sequence++
	if _, err = tx.ExecContext(ctx, "UPDATE local_execution_assignments SET lease_sequence = ? WHERE intent_id = ?", sequence, assignment.IntentID); err != nil || tx.Commit() != nil {
		return 0, failure("storage_failed")
	}
	return sequence, nil
}

func (store *IntentStore) completeRegistered(ctx context.Context, observed LocalAssignment) error {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return failure("storage_failed")
	}
	defer tx.Rollback()
	assignment, err := scanAssignment(tx.QueryRowContext(ctx, "SELECT "+assignmentColumns+" FROM local_execution_assignments WHERE intent_id = ?", observed.IntentID))
	if err != nil || !sameObservedAssignment(assignment, observed) || assignment.Supervisor == nil {
		return failure("execution_assignment_invalid")
	}
	history, err := readNativeHistory(ctx, tx, assignment)
	if err != nil || (history.LocalReleasedAt == "" && !hasPreflightProof(ctx, tx, assignment)) {
		return failure("containment_unknown")
	}
	checkpoint, err := scanObservationCheckpoint(tx.QueryRowContext(ctx, "SELECT "+observationColumns+" FROM local_execution_assignments WHERE intent_id = ?", assignment.IntentID))
	if err != nil || checkpoint.ProcessAbsent == "" {
		return failure("containment_unknown")
	}
	if _, err = tx.ExecContext(ctx, `UPDATE execution_commands SET state = 'complete', diagnostic = NULL
WHERE runner_id = ? AND command_id = ? AND workspace_id = ? AND command_kind = 'launch'`, assignment.Claim.Assignment.RunnerId, assignment.Claim.Specification.LaunchId, assignment.Claim.Assignment.WorkspaceId); err != nil || tx.Commit() != nil {
		return failure("storage_failed")
	}
	return nil
}
