// ABOUTME: Adapts daemon-local assignment and liveness state to the narrow A01 interfaces.
// ABOUTME: Reads only stable L05 columns with mirrored identity structs; drift fails closed.

package localmcp

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"strings"
	"time"

	"github.com/qdis/bfb/internal/journal"
)

// nativeProcess mirrors the PID/group/start-identity subset of L05's process
// record, including zombie liveness. Other L05 fields are ignored,
// and absent or malformed values fail closed to zero values.
type nativeProcess struct {
	PID           int    `json:"pid"`
	GroupID       int    `json:"group_id"`
	StartIdentity string `json:"start_identity"`
	Zombie        bool   `json:"zombie"`
}

type nativeSupervisor struct {
	Process nativeProcess `json:"process"`
}

type nativeHistory struct {
	Uncertain          bool   `json:"uncertain"`
	LocalReleasedAt    string `json:"local_released_at"`
	ReleasedGroupHash  string `json:"released_group_hash"`
	PreflightStoppedAt string `json:"preflight_stopped_at"`
	Group              *struct {
		Leader     nativeProcess `json:"leader"`
		Unknown    bool          `json:"unknown"`
		HadEscape  bool          `json:"had_escape"`
		Incomplete bool          `json:"incomplete"`
	} `json:"group"`
}

// DaemonAssignments resolves assignments from the daemon SQLite database. It
// reads only the stable identity columns and parses the PID/group/start
// subset of L05's owned-group and supervisor documents with mirrored structs;
// malformed identity or retained uncertainty fails closed. This projection
// is a known-denial fence, not a fresh whole-group ownership inspection.
type DaemonAssignments struct{ DB *sql.DB }

// Lookup returns the assignment for an execution, or an unknown record when
// no row matches. Unknown assignment identity fails closed as
// assignment_unknown; ended states fail as assignment_ended in VerifyPeer.
func (source DaemonAssignments) Lookup(ctx context.Context, executionID string, generation int64) (AssignmentRecord, error) {
	if source.DB == nil || executionID == "" || generation < 1 {
		return AssignmentRecord{}, fail("assignment_unknown")
	}
	var state, correlation, workspace, project, task, run, runner, checkout string
	var supervisorJSON, groupJSON, historyJSON sql.NullString
	err := source.DB.QueryRowContext(ctx, `SELECT state, correlation_token,
workspace_id, project_id, task_id, run_id, runner_id, checkout_id,
supervisor_json, owned_group_json, history.history_json
FROM local_execution_assignments assignment LEFT JOIN execution_native_history history
ON history.execution_id = assignment.execution_id
WHERE assignment.execution_id = ? AND assignment.assignment_generation = ?`,
		executionID, generation).Scan(&state, &correlation, &workspace, &project, &task, &run, &runner, &checkout, &supervisorJSON, &groupJSON, &historyJSON)
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
		var leader nativeProcess
		// L05 stores the pinned Process, not its separate native-history Group.
		if decodeNativeProcess([]byte(groupJSON.String), &leader) &&
			leader.PID > 1 && leader.GroupID == leader.PID && leader.StartIdentity != "" && !leader.Zombie {
			record.OwnedGroupID = leader.GroupID
			record.ProviderPID = leader.PID
			record.ProviderStart = leader.StartIdentity
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
	if historyJSON.Valid {
		var history nativeHistory
		if !decodeNativeHistory([]byte(historyJSON.String), &history) ||
			history.Uncertain || history.LocalReleasedAt != "" || history.ReleasedGroupHash != "" || history.PreflightStoppedAt != "" ||
			(history.Group != nil && (history.Group.Unknown || history.Group.HadEscape || history.Group.Incomplete || history.Group.Leader.Zombie ||
				history.Group.Leader.PID != record.ProviderPID || history.Group.Leader.GroupID != record.OwnedGroupID ||
				history.Group.Leader.StartIdentity != record.ProviderStart)) {
			record.Active = false
		}
	}
	return record, nil
}

// projectedObject permits unrelated L05 fields, but not duplicate keys, null
// objects, trailing values or null known authority fields. Unknown fields are
// intentionally not interpreted as ownership evidence.
func projectedObject(data []byte) (map[string]json.RawMessage, bool) {
	if len(data) > 65536 {
		return nil, false
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return nil, false
	}
	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		token, err := decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok || len(fields) >= 4096 {
			return nil, false
		}
		if _, exists := fields[key]; exists {
			return nil, false
		}
		var value json.RawMessage
		if decoder.Decode(&value) != nil {
			return nil, false
		}
		fields[key] = value
	}
	end, err := decoder.Token()
	if err != nil || end != json.Delim('}') {
		return nil, false
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, false
	}
	return fields, true
}

func nonnullFields(fields map[string]json.RawMessage, names ...string) bool {
	for _, name := range names {
		for key := range fields {
			if key != name && strings.EqualFold(key, name) {
				return false
			}
		}
		if value, exists := fields[name]; exists && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return false
		}
	}
	return true
}

func decodeNativeProcess(data []byte, process *nativeProcess) bool {
	fields, ok := projectedObject(data)
	return ok && nonnullFields(fields, "pid", "group_id", "start_identity", "zombie") && json.Unmarshal(data, process) == nil
}

func decodeNativeHistory(data []byte, history *nativeHistory) bool {
	fields, ok := projectedObject(data)
	if !ok || !nonnullFields(fields, "uncertain", "local_released_at", "released_group_hash", "preflight_stopped_at") || json.Unmarshal(data, history) != nil {
		return false
	}
	for key := range fields {
		if key != "group" && strings.EqualFold(key, "group") {
			return false
		}
	}
	if group, present := fields["group"]; present {
		// L05 legitimately records no historical group before initial pinning.
		// A fresh in-process ownership check still requires its current live group.
		if bytes.Equal(bytes.TrimSpace(group), []byte("null")) {
			return true
		}
		groupFields, ok := projectedObject(group)
		if !ok || !nonnullFields(groupFields, "unknown", "had_escape", "incomplete", "leader") {
			return false
		}
		leader, present := groupFields["leader"]
		if !present || history.Group == nil || !decodeNativeProcess(leader, &history.Group.Leader) {
			return false
		}
	}
	return true
}

// DaemonAuthority checks only locally recorded assignment liveness.
// It cannot establish current cloud authority; production uses RPCTransport.
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

func (DaemonAuthority) ConfirmSession(context.Context, Boundary, SessionBinding) (ConfirmedSession, error) {
	return ConfirmedSession{}, fail("offline_rejected")
}
func (DaemonAuthority) CurrentBound(context.Context, Boundary, ConfirmedSession) (AuthorityState, error) {
	return AuthorityState{}, fail("offline_rejected")
}

// OfflineTransport rejects operations that have no connected cloud implementation.
// RPCTransport embeds it for unsupported mutations; queue permission is decided
// separately by explicit offline policy and is denied by default in production.
type OfflineTransport struct{}

func (OfflineTransport) Online() bool { return false }

func (OfflineTransport) GetContext(_ context.Context, _ Boundary, _ string) (ContextResult, error) {
	return ContextResult{}, fail("offline_rejected")
}

func (OfflineTransport) GetTask(_ context.Context, _ Boundary, _ string) (TaskView, error) {
	return TaskView{}, fail("offline_rejected")
}

func (OfflineTransport) UpdateTask(_ context.Context, _ Boundary, _ UpdateTaskInput, _ string) (TaskView, error) {
	return TaskView{}, fail("offline_rejected")
}

func (OfflineTransport) AddComment(_ context.Context, _ Boundary, _ ConfirmedSession, _ string, _ string) (CommentResult, error) {
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
		return SessionBinding{}, fail("storage_failed")
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
		Provider:             observed.Provider,
	}, nil
}
