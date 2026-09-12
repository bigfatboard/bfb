// ABOUTME: Closes registered launches whose final-authorization gate was never pinned or passed.
// ABOUTME: Proves original helper absence without clearing, replacing or initializing any physical lock marker.

package supervisor

import (
	"context"
	"database/sql"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/runner"
)

// PinOwnership commits before the first online final request, and spawning
// requires that authorization. Closing this gate therefore excludes all future
// provider children, even if a helper had already acquired a native reservation.
func (store *IntentStore) beginPreflightCleanup(ctx context.Context, observed LocalAssignment, command LocalCommand) (LocalAssignment, LocalCommand, error) {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return LocalAssignment{}, LocalCommand{}, failure("storage_failed")
	}
	defer tx.Rollback()
	assignment, err := scanAssignment(tx.QueryRowContext(ctx, "SELECT "+assignmentColumns+" FROM local_execution_assignments WHERE intent_id = ?", observed.IntentID))
	if err != nil || !sameObservedAssignment(assignment, observed) || assignment.Supervisor == nil || assignment.LockID != "" || assignment.Group != nil ||
		(assignment.State != "registered" && assignment.State != "blocked" && assignment.State != "containment_unknown") {
		return LocalAssignment{}, LocalCommand{}, failure("containment_unknown")
	}
	history, err := readNativeHistory(ctx, tx, assignment)
	if err != nil || history.Group != nil || history.LocalReleasedAt != "" {
		return LocalAssignment{}, LocalCommand{}, failure("containment_unknown")
	}
	var current LocalCommand
	if scanCommand(tx.QueryRowContext(ctx, "SELECT "+commandColumns+" FROM execution_commands WHERE runner_id = ? AND command_id = ?", command.RunnerID, command.ID), &current) != nil ||
		current.WorkspaceID != assignment.Claim.Assignment.WorkspaceId || current.RunnerID != assignment.Claim.Assignment.RunnerId || current.ID != assignment.Claim.Specification.LaunchId ||
		current.Kind != "launch" || current.ClaimKey != command.ClaimKey || current.ClaimStartedAt != command.ClaimStartedAt || current.ExpiresAt != command.ExpiresAt ||
		(current.State != "queued" && current.State != "waiting") {
		return LocalAssignment{}, LocalCommand{}, failure("execution_assignment_invalid")
	}
	if current.CleanupLockID == "" {
		current.CleanupLockID = daemon.NewRequestID()
	}
	if !executionID.MatchString(current.CleanupLockID) {
		return LocalAssignment{}, LocalCommand{}, failure("execution_assignment_invalid")
	}
	if assignment.State != "containment_unknown" {
		assignment.State = "blocked"
	}
	if _, err = tx.ExecContext(ctx, "UPDATE local_execution_assignments SET state = ? WHERE intent_id = ?", assignment.State, assignment.IntentID); err != nil {
		return LocalAssignment{}, LocalCommand{}, failure("storage_failed")
	}
	if _, err = tx.ExecContext(ctx, "UPDATE execution_commands SET state = 'waiting', cleanup_lock_id = ? WHERE runner_id = ? AND command_id = ?", current.CleanupLockID, current.RunnerID, current.ID); err != nil || tx.Commit() != nil {
		return LocalAssignment{}, LocalCommand{}, failure("storage_failed")
	}
	current.State = "waiting"
	return assignment, current, nil
}

func hasPreflightProof(ctx context.Context, reader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, assignment LocalAssignment) bool {
	history, err := readNativeHistory(ctx, reader, assignment)
	if err != nil || history.PreflightStoppedAt == "" {
		return false
	}
	var cleanup string
	return reader.QueryRowContext(ctx, "SELECT coalesce(cleanup_lock_id,'') FROM execution_commands WHERE runner_id = ? AND command_id = ?", assignment.Claim.Assignment.RunnerId, assignment.Claim.Specification.LaunchId).Scan(&cleanup) == nil && executionID.MatchString(cleanup)
}

func (service *Service) preflightAbsent(inspector nativeInspector, assignment LocalAssignment) (time.Time, error) {
	started := service.options.Now()
	table, err := inspector.processes()
	if err != nil || assignment.Supervisor == nil {
		return time.Time{}, failure("containment_unknown")
	}
	if owner, exists := table[assignment.Supervisor.Process.PID]; exists && !owner.Zombie {
		// A reused PID is still ambiguous. Never signal or adopt it.
		return time.Time{}, failure("containment_unknown")
	}
	now := service.options.Now()
	if now.Before(started) || now.Sub(started) > finalRequestLimit {
		return time.Time{}, failure("containment_unknown")
	}
	return now, nil
}

func (service *Service) cleanupPreflight(ctx context.Context, store *IntentStore, inspector nativeInspector, assignment LocalAssignment, command LocalCommand, connection runner.RunnerConnection, receipt generated.LaunchReconciliation) error {
	if receipt.LaunchState == "started" || (receipt.ReservationState != "reserved" && receipt.ReservationState != "released" && receipt.ReservationState != "superseded") {
		return failure("containment_unknown")
	}
	// Reconciliation already completed. Check absence both before and after
	// the transaction; a stale snapshot cannot close a concurrently pinned gate.
	if _, err := service.preflightAbsent(inspector, assignment); err != nil {
		return err
	}
	assignment, command, err := store.beginPreflightCleanup(ctx, assignment, command)
	if err != nil {
		return err
	}
	service.nativeMu.Lock()
	now, err := service.preflightAbsent(inspector, assignment)
	if err == nil {
		_, err = store.rememberNative(ctx, assignment, nativeHistory{PreflightStoppedAt: localTimestamp(now)})
	}
	service.nativeMu.Unlock()
	if err != nil {
		return err
	}
	if receipt.ReservationState == "released" || receipt.ReservationState == "superseded" {
		return service.settlePreflight(ctx, store, inspector, assignment)
	}
	if receipt.ObservationSequence == nil {
		return failure("execution_assignment_invalid")
	}
	sequence, err := store.nextLeaseSequence(ctx, assignment, *receipt.ObservationSequence)
	if err != nil {
		return err
	}
	owner := assignment.Supervisor.wire()
	observation, err := wireJSON("checkout-lease-observation", generated.CheckoutLeaseObservation{
		SchemaVersion: 1, RunExecutionId: assignment.Claim.Assignment.RunExecutionId, AssignmentGeneration: assignment.Claim.Assignment.AssignmentGeneration,
		FencingGeneration: assignment.Claim.FencingGeneration, Sequence: sequence, ObservedAt: localTimestamp(now), Operation: "release",
		Supervisor: &owner, LocalLockId: command.CleanupLockID, SupervisorState: "gone", GroupState: "never_started", LockState: "gone", DescendantsState: "none",
	})
	if err != nil {
		return err
	}
	current := service.options.Now()
	if current.Before(now) || current.Sub(now) > finalRequestLimit {
		return failure("containment_unknown")
	}
	if _, err = requestLaunch(ctx, connection, "leases/observe", observation); err != nil {
		return err
	}
	body, err := claimRequest(command)
	if err != nil {
		return err
	}
	data, err := requestLaunch(ctx, connection, "launch/reconcile", body)
	if err != nil {
		return err
	}
	settled, err := reconciliation(data, command, &assignment)
	if err != nil || settled.LaunchState == "started" || (settled.ReservationState != "released" && settled.ReservationState != "superseded") {
		return failure("containment_unknown")
	}
	return service.settlePreflight(ctx, store, inspector, assignment)
}

func (service *Service) settlePreflight(ctx context.Context, store *IntentStore, inspector nativeInspector, assignment LocalAssignment) error {
	service.nativeMu.Lock()
	defer service.nativeMu.Unlock()
	if !hasPreflightProof(ctx, store.db, assignment) {
		return failure("containment_unknown")
	}
	now, err := service.preflightAbsent(inspector, assignment)
	if err != nil {
		return err
	}
	if _, err = store.captureProcess(ctx, assignment, processCapture{State: "never_started", Diagnostic: failure("launch_blocked")}, now); err != nil {
		return err
	}
	return store.completeRegistered(ctx, assignment)
}
