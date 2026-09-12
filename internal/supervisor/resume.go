// ABOUTME: Binds exact-session continuation to one claimed control and a durably released source execution.
// ABOUTME: Rechecks retained native identities while the ordinary launch gate acquires the new physical lock.

package supervisor

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
)

type resumeReader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type resumeSource struct {
	assignment LocalAssignment
	history    nativeHistory
}

// A cloud release alone is insufficient. The original local command must have
// settled after native release and a captured, actually observed provider end.
func readResumeSource(ctx context.Context, reader resumeReader, effect controlEffect, now time.Time) (resumeSource, error) {
	assignment, err := scanAssignment(reader.QueryRowContext(ctx, "SELECT "+assignmentColumns+" FROM local_execution_assignments WHERE execution_id = ? AND assignment_generation = ?", effect.ExecutionID, effect.Generation))
	if err != nil || effect.Action != "resume" || assignment.Claim.Assignment.RunnerId != effect.RunnerID ||
		assignment.Supervisor == nil || assignment.LockID == "" || assignment.Group == nil ||
		(assignment.State != "ending" && assignment.State != "ended" && assignment.State != "containment_unknown") {
		return resumeSource{}, failure("provider_session_invalid")
	}
	var command LocalCommand
	if scanCommand(reader.QueryRowContext(ctx, "SELECT "+commandColumns+" FROM execution_commands WHERE runner_id = ? AND command_id = ?", effect.RunnerID, assignment.Claim.Specification.LaunchId), &command) != nil ||
		command.Kind != "launch" || command.State != "complete" || command.CleanupLockID != "" || command.WorkspaceID != assignment.Claim.Assignment.WorkspaceId {
		return resumeSource{}, failure("containment_unknown")
	}
	history, err := readNativeHistory(ctx, reader, assignment)
	if err != nil || history.Group == nil || history.Group.Leader != *assignment.Group || history.Group.Incomplete || history.LocalReleasedAt == "" || history.ReleasedGroupHash != nativeGroupHash(history.Group) {
		return resumeSource{}, failure("containment_unknown")
	}
	released, err := time.Parse(time.RFC3339Nano, history.LocalReleasedAt)
	checkpoint, checkpointErr := scanObservationCheckpoint(reader.QueryRowContext(ctx, "SELECT "+observationColumns+" FROM local_execution_assignments WHERE intent_id = ?", assignment.IntentID))
	absent, absentErr := time.Parse(time.RFC3339Nano, checkpoint.ProcessAbsent)
	if err != nil || checkpointErr != nil || absentErr != nil || checkpoint.ProviderObserved == "" || now.Before(released) || now.Before(absent) {
		return resumeSource{}, failure("containment_unknown")
	}
	return resumeSource{assignment: assignment, history: history}, nil
}

func (source resumeSource) verifyGone() error {
	table, err := InspectProcesses()
	if err != nil {
		return failure("containment_unknown")
	}
	if owner, exists := table[source.assignment.Supervisor.Process.PID]; exists && !owner.Zombie {
		return failure("containment_unknown")
	}
	// PID/group reuse remains ambiguous even when a different process owns it.
	// This reads history; it cannot clear a marker or signal any old/new owner.
	if !source.history.Group.ProveGone(table) {
		return failure("containment_unknown")
	}
	return nil
}

func (source resumeSource) binding(claim generated.LaunchClaimResult) (provider.SessionBinding, error) {
	parent, child := source.assignment.Claim, claim
	old, next := parent.Assignment, child.Assignment
	var session struct {
		ProviderSessionID string `json:"provider_session_id"`
		ObservedSessionID string `json:"observed_session_id"`
	}
	data, err := json.Marshal(child.Specification.ResumeSession)
	if err != nil || strictPrivateJSON(data, &session) != nil || !executionID.MatchString(session.ProviderSessionID) ||
		old.WorkspaceId != next.WorkspaceId || old.ProjectId != next.ProjectId || old.TaskId != next.TaskId || old.RunId != next.RunId ||
		old.RunnerId != next.RunnerId || old.CheckoutId != next.CheckoutId || old.RunExecutionId == next.RunExecutionId ||
		next.AssignmentGeneration <= old.AssignmentGeneration || child.FencingGeneration <= parent.FencingGeneration ||
		child.Specification.LaunchId == parent.Specification.LaunchId || child.Specification.ConfigSnapshotId != parent.Specification.ConfigSnapshotId ||
		child.Specification.ConfigSnapshotHash != parent.Specification.ConfigSnapshotHash || child.Snapshot.PhysicalWorktreeHash != parent.Snapshot.PhysicalWorktreeHash {
		return provider.SessionBinding{}, failure("provider_session_invalid")
	}
	// C09 owns the observed provider-session record. Its immutable child claim
	// supplies the exact ID; the local control supplies the prior owned execution.
	return provider.SessionBinding{Provider: string(parent.Specification.ExecutionConfig.Provider), ObservedID: session.ObservedSessionID,
		RunID: old.RunId, ExecutionID: old.RunExecutionId, Generation: old.AssignmentGeneration}, nil
}

// A pulled child can arrive before the original control claim reply is stored.
// Missing/unfinished binding is a wait, never permission for a fresh launch.
func resumeForClaim(ctx context.Context, db *sql.DB, claim generated.LaunchClaimResult, now time.Time) (*resumeSource, error) {
	var id string
	var count int
	if db.QueryRowContext(ctx, "SELECT coalesce(min(control_id),''),count(*) FROM execution_control_effects WHERE resume_launch_id = ?", claim.Specification.LaunchId).Scan(&id, &count) != nil {
		return nil, failure("storage_failed")
	}
	if count == 0 && claim.Specification.ResumeSession == nil {
		return nil, nil
	}
	if count != 1 || claim.Specification.ResumeSession == nil {
		return nil, failure("provider_session_invalid")
	}
	store := NewIntentStore(db)
	command, err := store.Command(ctx, claim.Assignment.RunnerId, id)
	if err != nil || command.WorkspaceID != claim.Assignment.WorkspaceId || (command.State != "queued" && command.State != "waiting") || command.ExpiresAt != claim.Specification.ExpiresAt {
		return nil, failure("provider_session_invalid")
	}
	effect, err := store.control(ctx, command)
	if err != nil || effect == nil || effect.Action != "resume" || effect.State != "applying" || effect.StartedAt == "" || effect.ResumeLaunchID != claim.Specification.LaunchId {
		return nil, failure("provider_session_invalid")
	}
	started, first := time.Parse(time.RFC3339Nano, effect.StartedAt)
	expires, second := time.Parse(time.RFC3339Nano, effect.ExpiresAt)
	if first != nil || second != nil || now.Before(started) || !now.Before(expires) {
		return nil, failure("expired_intent")
	}
	source, err := readResumeSource(ctx, db, *effect, now)
	if err != nil {
		return nil, err
	}
	if _, err = source.binding(claim); err != nil {
		return nil, err
	}
	if err = source.verifyGone(); err != nil {
		return nil, err
	}
	return &source, nil
}

func planExecution(registry *provider.Registry, probe provider.Probe, claim generated.LaunchClaimResult, directory string, source *resumeSource, now time.Time) (provider.Plan, error) {
	input := provider.LaunchInput{Config: claim.Specification.ExecutionConfig, WorkingDirectory: directory}
	policy := provider.Policy{AllowedCapabilities: probe.Capabilities}
	if claim.Specification.ResumeSession == nil && source == nil {
		return registry.PlanLaunch(probe, input, policy, now)
	}
	if source == nil || claim.Specification.ResumeSession == nil {
		return provider.Plan{}, failure("provider_session_invalid")
	}
	binding, err := source.binding(claim)
	if err != nil {
		return provider.Plan{}, err
	}
	return registry.PlanResume(probe, provider.ResumeInput{LaunchInput: input, Session: binding}, policy, now)
}

func (store *IntentStore) beginResumeControl(ctx context.Context, command LocalCommand, expected controlEffect, observed resumeSource, now time.Time) (controlEffect, error) {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return controlEffect{}, failure("storage_failed")
	}
	defer tx.Rollback()
	if _, err = currentControlCommand(ctx, tx, command); err != nil {
		return controlEffect{}, err
	}
	effect, err := scanControl(tx.QueryRowContext(ctx, "SELECT "+controlColumns+" FROM execution_control_effects WHERE control_id = ?", command.ID))
	if err != nil || effect != expected || effect.State != "prepared" || effect.StartedAt != "" || effect.Action != "resume" ||
		!executionID.MatchString(effect.ResumeLaunchID) || effect.ResumeLaunchID == command.ID || effect.ClaimKey != command.ClaimKey || effect.RunnerID != command.RunnerID || effect.ExpiresAt != command.ExpiresAt {
		return controlEffect{}, failure("execution_assignment_invalid")
	}
	expires, first := time.Parse(time.RFC3339Nano, effect.ExpiresAt)
	accepted, second := time.Parse(time.RFC3339Nano, command.ClaimStartedAt)
	if first != nil || second != nil || now.Before(accepted) || !now.Before(expires) {
		return controlEffect{}, failure("expired_intent")
	}
	source, err := readResumeSource(ctx, tx, effect, now)
	if err != nil || !sameObservedAssignment(source.assignment, observed.assignment) || source.assignment.Claim.Assignment.WorkspaceId != command.WorkspaceID {
		return controlEffect{}, failure("provider_session_invalid")
	}
	if err = source.verifyGone(); err != nil {
		return controlEffect{}, err
	}
	effect.State, effect.StartedAt = "applying", localTimestamp(now)
	if _, err = tx.ExecContext(ctx, "UPDATE execution_control_effects SET state = 'applying', effect_started_at = ? WHERE control_id = ?", effect.StartedAt, effect.ID); err != nil || tx.Commit() != nil {
		return controlEffect{}, failure("storage_failed")
	}
	return effect, nil
}
