// ABOUTME: Merges bounded daemon-observed descendant identities without discarding prior containment evidence.
// ABOUTME: Persists inspection history separately from replayable events and the helper-owned native lock marker.

package supervisor

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/qdis/bfb/internal/provider"
)

type nativeHistory struct {
	Group              *Group `json:"group"`
	Uncertain          bool   `json:"uncertain"`
	LocalReleasedAt    string `json:"local_released_at,omitempty"`
	ReleasedGroupHash  string `json:"released_group_hash,omitempty"`
	PreflightStoppedAt string `json:"preflight_stopped_at,omitempty"`
}

func (history nativeHistory) valid(assignment LocalAssignment) bool {
	if assignment.Supervisor == nil {
		return false
	}
	if history.ReleasedGroupHash != "" && (history.LocalReleasedAt == "" || !worktreeDigest.MatchString(history.ReleasedGroupHash)) {
		return false
	}
	if history.LocalReleasedAt != "" {
		stamp, err := time.Parse(time.RFC3339Nano, history.LocalReleasedAt)
		created, createdErr := time.Parse(time.RFC3339Nano, assignment.CreatedAt)
		if err != nil || createdErr != nil || assignment.LockID == "" || localTimestamp(stamp) != history.LocalReleasedAt || stamp.Before(created) {
			return false
		}
	}
	if history.PreflightStoppedAt != "" {
		stamp, err := time.Parse(time.RFC3339Nano, history.PreflightStoppedAt)
		created, createdErr := time.Parse(time.RFC3339Nano, assignment.CreatedAt)
		if err != nil || createdErr != nil || localTimestamp(stamp) != history.PreflightStoppedAt || stamp.Before(created) ||
			assignment.LockID != "" || assignment.Group != nil || history.Group != nil || history.LocalReleasedAt != "" ||
			(assignment.State != "blocked" && assignment.State != "containment_unknown") {
			return false
		}
	}
	if history.Group == nil {
		return true
	}
	group := history.Group
	if assignment.LockID == "" || (assignment.Group != nil && group.Leader != *assignment.Group) {
		return false
	}
	record := LockRecord{Version: 1, LockID: assignment.LockID, Binding: assignment.lockBinding(), Owner: assignment.Supervisor.Process, Group: group, State: "containment_unknown"}
	return record.valid()
}

func nativeGroupHash(group *Group) string {
	data, _ := json.Marshal(group)
	return provider.Hash(data)
}

func (assignment LocalAssignment) lockBinding() LockBinding {
	claim := assignment.Claim
	return LockBinding{ExecutionID: claim.Assignment.RunExecutionId, AssignmentGeneration: claim.Assignment.AssignmentGeneration, FencingGeneration: claim.FencingGeneration, PhysicalWorktreeHash: claim.Snapshot.PhysicalWorktreeHash}
}

// mergeGroups retains original identities. A conflicting PID is ambiguity,
// never permission to replace the remembered process or signal its successor.
func mergeGroups(prior, current *Group) *Group {
	if prior == nil && current == nil {
		return nil
	}
	if prior == nil {
		prior, current = current, nil
	}
	merged := *prior
	merged.Observed = make(map[int]Process, len(prior.Observed))
	for pid, process := range prior.Observed {
		merged.Observed[pid] = process
	}
	if current == nil {
		return &merged
	}
	merged.Unknown = merged.Unknown || current.Unknown
	merged.HadEscape = merged.HadEscape || current.HadEscape
	merged.Incomplete = merged.Incomplete || current.Incomplete
	if merged.Leader != current.Leader {
		merged.Unknown, merged.Incomplete = true, true
	}
	for pid, process := range current.Observed {
		if previous, exists := merged.Observed[pid]; exists {
			if !previous.Same(process) {
				merged.Unknown = true
			}
			continue
		}
		if len(merged.Observed) >= maxObservedProcesses {
			merged.Unknown, merged.Incomplete = true, true
			continue
		}
		merged.Observed[pid] = process
	}
	return &merged
}

func readNativeHistory(ctx context.Context, reader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, assignment LocalAssignment) (nativeHistory, error) {
	var history nativeHistory
	var data string
	err := reader.QueryRowContext(ctx, "SELECT history_json FROM execution_native_history WHERE execution_id = ?", assignment.Claim.Assignment.RunExecutionId).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return history, nil
	}
	if err != nil {
		return history, failure("storage_failed")
	}
	if len(data) > 65536 || strictPrivateJSON([]byte(data), &history) != nil || !history.valid(assignment) {
		return nativeHistory{}, failure("containment_unknown")
	}
	return history, nil
}

func (store *IntentStore) rememberNative(ctx context.Context, observed LocalAssignment, fresh nativeHistory) (nativeHistory, error) {
	if !fresh.valid(observed) {
		return nativeHistory{}, failure("containment_unknown")
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return nativeHistory{}, failure("storage_failed")
	}
	defer tx.Rollback()
	assignment, err := scanAssignment(tx.QueryRowContext(ctx, "SELECT "+assignmentColumns+" FROM local_execution_assignments WHERE intent_id = ?", observed.IntentID))
	if err != nil || !sameObservedAssignment(assignment, observed) {
		return nativeHistory{}, failure("execution_assignment_invalid")
	}
	prior, err := readNativeHistory(ctx, tx, assignment)
	if err != nil {
		return nativeHistory{}, err
	}
	merged := nativeHistory{Group: mergeGroups(prior.Group, fresh.Group), Uncertain: prior.Uncertain || fresh.Uncertain, LocalReleasedAt: prior.LocalReleasedAt, ReleasedGroupHash: prior.ReleasedGroupHash, PreflightStoppedAt: prior.PreflightStoppedAt}
	if merged.LocalReleasedAt == "" {
		merged.LocalReleasedAt = fresh.LocalReleasedAt
	}
	if merged.PreflightStoppedAt == "" {
		merged.PreflightStoppedAt = fresh.PreflightStoppedAt
	}
	// A later descendant must not inherit an older release checkpoint. Only
	// a fresh native release proof can certify the complete retained history.
	if fresh.ReleasedGroupHash != "" && fresh.ReleasedGroupHash != prior.ReleasedGroupHash {
		if fresh.ReleasedGroupHash != nativeGroupHash(merged.Group) {
			return nativeHistory{}, failure("containment_unknown")
		}
		merged.ReleasedGroupHash = fresh.ReleasedGroupHash
	}
	if !merged.valid(assignment) {
		return nativeHistory{}, failure("containment_unknown")
	}
	data, err := json.Marshal(merged)
	if err != nil || len(data) > 65536 {
		return nativeHistory{}, failure("execution_capacity")
	}
	before, _ := json.Marshal(prior)
	if string(before) == string(data) {
		return merged, nil
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO execution_native_history (execution_id,history_json) VALUES (?,?)
ON CONFLICT(execution_id) DO UPDATE SET history_json = excluded.history_json`, assignment.Claim.Assignment.RunExecutionId, string(data)); err != nil || tx.Commit() != nil {
		return nativeHistory{}, failure("storage_failed")
	}
	return merged, nil
}

func (store *IntentStore) supervised(ctx context.Context) ([]LocalAssignment, error) {
	rows, err := store.db.QueryContext(ctx, `SELECT `+assignmentColumns+` FROM local_execution_assignments
WHERE supervisor_json IS NOT NULL AND EXISTS (SELECT 1 FROM execution_commands c
WHERE c.runner_id = local_execution_assignments.runner_id AND c.command_id = local_execution_assignments.launch_id AND c.state != 'complete')
ORDER BY execution_id LIMIT 256`)
	if err != nil {
		return nil, failure("storage_failed")
	}
	defer rows.Close()
	assignments := []LocalAssignment{}
	for rows.Next() {
		assignment, err := scanAssignment(rows)
		if err != nil {
			return nil, err
		}
		assignments = append(assignments, assignment)
	}
	if rows.Err() != nil {
		return nil, failure("storage_failed")
	}
	return assignments, nil
}
