// ABOUTME: Reuses fresh native supervision evidence to fence daemon-owned agent work.
// ABOUTME: Retains uncertainty without granting recovery, launch or cloud authority to the caller.

package supervisor

import (
	"context"
	"database/sql"
	"errors"
)

// CheckAgentOwnership checks an already authenticated agent's exact execution.
// Callers must independently verify the kernel peer and cloud authority, and
// repeat this check after network waits before releasing private results.
func (service *Service) CheckAgentOwnership(ctx context.Context, executionID string, generation int64) error {
	if err := service.waitReady(ctx); err != nil {
		return err
	}
	service.mu.RLock()
	defer service.mu.RUnlock()
	return service.checkAgentOwnership(ctx, executionID, generation, service.nativeInspector(service.paths, service.files))
}

func (store *IntentStore) activeAgentAssignment(ctx context.Context, execution string, generation int64) (LocalAssignment, error) {
	if !executionID.MatchString(execution) || generation < 1 {
		return LocalAssignment{}, failure("execution_assignment_invalid")
	}
	row := store.db.QueryRowContext(ctx, "SELECT "+assignmentColumns+" FROM local_execution_assignments WHERE execution_id = ? AND assignment_generation = ?", execution, generation)
	if err := row.Err(); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return LocalAssignment{}, failure("storage_failed")
	}
	assignment, err := scanAssignment(row)
	if err != nil {
		return LocalAssignment{}, err
	}
	if assignment.Supervisor == nil || assignment.Group == nil || assignment.LockID == "" ||
		(assignment.State != "group_ready" && assignment.State != "running") {
		return LocalAssignment{}, failure("execution_assignment_invalid")
	}
	return assignment, nil
}

// The inspector argument is private so tests can isolate native faults without
// adding a configurable production bypass or duplicating lock/signature logic.
func (service *Service) checkAgentOwnership(ctx context.Context, executionID string, generation int64, inspector nativeInspector) error {
	if service.store == nil || service.files == nil {
		return failure("daemon_offline")
	}
	service.nativeMu.Lock()
	defer service.nativeMu.Unlock()
	assignment, err := service.store.activeAgentAssignment(ctx, executionID, generation)
	if err != nil {
		return err
	}
	facts, checkpoint, err := service.inspectNativeLocked(ctx, service.store, inspector, assignment)
	if err != nil {
		return err
	}
	if checkpoint.ProcessAbsent != "" || checkpoint.EventWindowEndsAt != "" || facts.Capture.State != "live" ||
		facts.SupervisorState != "verified" || facts.GroupState != "live" || facts.LockState != "held" ||
		(!facts.RootAuthority && facts.Descendants != "contained") ||
		facts.History.Uncertain || facts.History.LocalReleasedAt != "" || facts.History.ReleasedGroupHash != "" || facts.History.PreflightStoppedAt != "" ||
		facts.History.Group == nil || facts.History.Group.Unknown || facts.History.Group.HadEscape || facts.History.Group.Incomplete {
		return failure("containment_unknown")
	}
	current, err := service.store.activeAgentAssignment(ctx, executionID, generation)
	if err != nil {
		return err
	}
	if !sameObservedAssignment(current, assignment) || current.Claim.Assignment != assignment.Claim.Assignment ||
		current.Claim.FencingGeneration != assignment.Claim.FencingGeneration ||
		current.Claim.Specification.ConfigSnapshotHash != assignment.Claim.Specification.ConfigSnapshotHash ||
		current.Claim.Snapshot.PhysicalWorktreeHash != assignment.Claim.Snapshot.PhysicalWorktreeHash ||
		current.ProviderIdentityHash != assignment.ProviderIdentityHash || current.CorrelationToken != assignment.CorrelationToken {
		return failure("execution_assignment_invalid")
	}
	return nil
}
