// ABOUTME: Adapts daemon-local assignment and liveness state to the narrow A01 interfaces.
// ABOUTME: Reads only stable L05 columns with mirrored identity structs; drift fails closed.

package localmcp

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/qdis/bfb/internal/journal"
)

// nativeProcess mirrors the PID/group/start-identity subset of L05's process
// record. Only these three fields are read; every other L05 field is ignored,
// and absent or malformed values fail closed to zero values.
type nativeProcess struct {
	PID           int    `json:"pid"`
	GroupID       int    `json:"group_id"`
	StartIdentity string `json:"start_identity"`
}

type nativeGroup struct {
	Leader  nativeProcess `json:"leader"`
	Unknown bool          `json:"unknown"`
}

type nativeSupervisor struct {
	Process nativeProcess `json:"process"`
}

// DaemonAssignments resolves assignments from the daemon SQLite database. It
// reads only the stable identity columns and parses the PID/group/start
// subset of L05's owned-group and supervisor documents with mirrored structs;
// anything else fails closed. At merge, L05 may replace this adapter with an
// exported assignment reader; the Lookup signature already matches.
type DaemonAssignments struct{ DB *sql.DB }

// Lookup returns the assignment for an execution, or an unknown record when
// no row matches. Unknown assignment identity fails closed as
// assignment_unknown; ended states fail as assignment_ended in VerifyPeer.
func (source DaemonAssignments) Lookup(ctx context.Context, executionID string, generation int64) (AssignmentRecord, error) {
	if source.DB == nil || executionID == "" || generation < 1 {
		return AssignmentRecord{}, fail("assignment_unknown")
	}
	var state, correlation, workspace, project, task, run, runner, checkout string
	var supervisorJSON, groupJSON sql.NullString
	err := source.DB.QueryRowContext(ctx, `SELECT state, correlation_token,
workspace_id, project_id, task_id, run_id, runner_id, checkout_id,
supervisor_json, owned_group_json
FROM local_execution_assignments WHERE execution_id = ? AND assignment_generation = ?`,
		executionID, generation).Scan(&state, &correlation, &workspace, &project, &task, &run, &runner, &checkout, &supervisorJSON, &groupJSON)
	if err == sql.ErrNoRows {
		return AssignmentRecord{}, fail("assignment_unknown")
	}
	if err != nil {
		return AssignmentRecord{}, fail("storage_failed")
	}
	record := AssignmentRecord{
		Known:            true,
		CorrelationToken: correlation,
		Boundary: Boundary{
			WorkspaceID: workspace, ProjectID: project, TaskID: task, RunID: run,
			RunnerID: runner, CheckoutID: checkout,
			ExecutionID: executionID, Generation: generation,
		},
	}
	switch state {
	case "registered", "group_ready", "running":
		record.Active = true
	default:
		record.Active = false
	}
	if groupJSON.Valid && groupJSON.String != "" {
		var group nativeGroup
		if json.Unmarshal([]byte(groupJSON.String), &group) == nil && !group.Unknown &&
			group.Leader.PID > 0 && group.Leader.GroupID > 0 && group.Leader.StartIdentity != "" {
			record.OwnedGroupID = group.Leader.GroupID
			record.ProviderPID = group.Leader.PID
			record.ProviderStart = group.Leader.StartIdentity
		}
	}
	if record.OwnedGroupID == 0 && supervisorJSON.Valid && supervisorJSON.String != "" {
		var identity nativeSupervisor
		if json.Unmarshal([]byte(supervisorJSON.String), &identity) == nil &&
			identity.Process.PID > 0 && identity.Process.StartIdentity != "" {
			record.ProviderPID = identity.Process.PID
			record.ProviderStart = identity.Process.StartIdentity
		}
	}
	return record, nil
}

// DaemonAuthority rechecks local liveness on every call: an assignment row
// that disappeared or left its active states closes the capability. Cloud
// authority (revocation epochs, terminal run results) is rechecked by the
// L08 channel transport on every call; until that transport plugs in, this
// adapter reports only what the daemon database proves. See the WP-A01
// Handoff for the exact merge step.
type DaemonAuthority struct{ Assignments AssignmentSource }

func (source DaemonAuthority) Current(ctx context.Context, boundary Boundary) (AuthorityState, error) {
	record, err := source.Assignments.Lookup(ctx, boundary.ExecutionID, boundary.Generation)
	if err != nil {
		return AuthorityState{}, err
	}
	if !record.Known || !record.Active {
		return AuthorityState{ExecutionEnded: true}, nil
	}
	return AuthorityState{}, nil
}

// OfflineTransport is the pre-L08 production transport: the cloud channel is
// unreachable, so reads fail visibly and writes are journaled by the host.
// It exists so `bfb mcp stdio` has honest offline behavior before the L08
// channel client plugs in behind the WorkTransport interface.
type OfflineTransport struct{}

func (OfflineTransport) Online() bool { return false }

func (OfflineTransport) GetContext(_ context.Context, _ Boundary) ([]ContextItem, ContextDelivery, error) {
	return nil, ContextDelivery{}, fail("offline_rejected")
}

func (OfflineTransport) GetTask(_ context.Context, _ Boundary) (TaskView, error) {
	return TaskView{}, fail("offline_rejected")
}

func (OfflineTransport) UpdateTask(_ context.Context, _ Boundary, _ UpdateTaskInput, _ string) (TaskView, error) {
	return TaskView{}, fail("offline_rejected")
}

func (OfflineTransport) AddComment(_ context.Context, _ Boundary, _ string, _ string) (CommentResult, error) {
	return CommentResult{}, fail("offline_rejected")
}

func (OfflineTransport) ReportProgress(_ context.Context, _ Boundary, _ string, _ *float64, _ *float64, _ string) (CommentResult, error) {
	return CommentResult{}, fail("offline_rejected")
}

func (OfflineTransport) ProposeTask(_ context.Context, _ Boundary, _ ProposeTaskInput, _ string) (ProposeTaskResult, error) {
	return ProposeTaskResult{}, fail("offline_rejected")
}

func (OfflineTransport) RequestAttention(_ context.Context, _ Boundary, _ AttentionRequest, _ string) (AttentionRecord, error) {
	return AttentionRecord{}, fail("offline_rejected")
}

func (OfflineTransport) GetAttention(_ context.Context, _ Boundary, _ string) (AttentionRecord, error) {
	return AttentionRecord{}, fail("offline_rejected")
}

func (OfflineTransport) SubmitResult(_ context.Context, _ Boundary, _ SubmitResultInput, _ string) (SubmitResultResult, error) {
	return SubmitResultResult{}, fail("offline_rejected")
}

// JournalBindings adapts L06's hook-journal session reader to the narrow
// SessionBindingSource. The trusted observed-session row supplies the
// session ID and bind time, keyed by the immutable (execution ID,
// assignment generation) identity. The run ID echoes the verified
// capability boundary: that pair is the immutable assignment key, so the
// row for the key can only belong to the assignment the capability was
// verified against; the adapter never invents identity beyond that echo.
type JournalBindings struct {
	Sessions journal.SessionReader
}

// ObservedBinding returns the trusted binding for a verified assignment,
// or ErrSessionNotBound while L06 has committed no well-formed row. A
// storage fault propagates instead of masquerading as an unbound session;
// the capability still fails closed, but the cause stays visible.
func (bindings JournalBindings) ObservedBinding(ctx context.Context, ref AssignmentRef) (SessionBinding, error) {
	if bindings.Sessions == nil {
		return SessionBinding{}, ErrSessionNotBound
	}
	observed, err := bindings.Sessions.BoundSession(ctx, ref.ExecutionID, ref.AssignmentGeneration)
	if err != nil {
		if journal.Code(err) == "session_unbound" {
			return SessionBinding{}, ErrSessionNotBound
		}
		return SessionBinding{}, err
	}
	if observed.SessionID == "" {
		return SessionBinding{}, ErrSessionNotBound
	}
	boundAt, err := time.Parse(time.RFC3339Nano, observed.BoundAt)
	if err != nil {
		return SessionBinding{}, ErrSessionNotBound
	}
	return SessionBinding{
		ExecutionID:          ref.ExecutionID,
		AssignmentGeneration: ref.AssignmentGeneration,
		RunID:                ref.RunID,
		ObservedSessionID:    observed.SessionID,
		ObservedAt:           boundAt,
	}, nil
}
