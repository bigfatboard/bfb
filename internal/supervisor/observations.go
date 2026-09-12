// ABOUTME: Atomically captures bounded native process observations with execution-local sequence and provenance.
// ABOUTME: Preserves startup, containment uncertainty and final-hook deadlines independently of event delivery.

package supervisor

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
)

const processHeartbeatInterval = 15 * time.Second
const finalHookGrace = 15 * time.Second
const observationCapacity = 8192
const maxObservationSequence = 9007199254740991

// These inputs are supplied only by local inspection or the durable unstarted
// cleanup barrier. No RPC accepts process facts or event IDs from a caller.
type processCapture struct {
	State         string
	ProviderImage bool
	Diagnostic    error
}

type observationCheckpoint struct {
	Sequence          int64
	ProviderObserved  string
	ProcessAbsent     string
	LastObserved      string
	EventWindowEndsAt string
}

func scanObservationCheckpoint(row assignmentScanner) (observationCheckpoint, error) {
	var checkpoint observationCheckpoint
	if err := row.Scan(&checkpoint.Sequence, &checkpoint.ProviderObserved, &checkpoint.ProcessAbsent, &checkpoint.LastObserved, &checkpoint.EventWindowEndsAt); err != nil {
		return checkpoint, failure("storage_failed")
	}
	if checkpoint.Sequence < 0 || checkpoint.Sequence > maxObservationSequence || (checkpoint.Sequence == 0) != (checkpoint.LastObserved == "") {
		return checkpoint, failure("execution_assignment_invalid")
	}
	var last time.Time
	for _, stamp := range []string{checkpoint.LastObserved, checkpoint.ProviderObserved, checkpoint.ProcessAbsent, checkpoint.EventWindowEndsAt} {
		if stamp == "" {
			continue
		}
		parsed, err := time.Parse(time.RFC3339Nano, stamp)
		if err != nil || localTimestamp(parsed) != stamp {
			return checkpoint, failure("execution_assignment_invalid")
		}
		if stamp == checkpoint.LastObserved {
			last = parsed
		}
	}
	for _, stamp := range []string{checkpoint.ProviderObserved, checkpoint.ProcessAbsent} {
		if stamp != "" {
			parsed, _ := time.Parse(time.RFC3339Nano, stamp)
			if parsed.After(last) {
				return checkpoint, failure("execution_assignment_invalid")
			}
		}
	}
	if (checkpoint.ProcessAbsent == "") != (checkpoint.EventWindowEndsAt == "") {
		return checkpoint, failure("execution_assignment_invalid")
	}
	if checkpoint.ProcessAbsent != "" {
		absent, _ := time.Parse(time.RFC3339Nano, checkpoint.ProcessAbsent)
		provider, _ := time.Parse(time.RFC3339Nano, checkpoint.ProviderObserved)
		if localTimestamp(absent.Add(finalHookGrace)) != checkpoint.EventWindowEndsAt || provider.After(absent) {
			return checkpoint, failure("execution_assignment_invalid")
		}
	}
	return checkpoint, nil
}

const observationColumns = `event_sequence,coalesce(provider_observed_at,''),coalesce(process_absent_at,''),
coalesce(last_process_observed_at,''),coalesce(event_window_ends_at,'')`

func (store *IntentStore) observationCheckpoint(ctx context.Context, intent string) (observationCheckpoint, error) {
	return scanObservationCheckpoint(store.db.QueryRowContext(ctx, "SELECT "+observationColumns+" FROM local_execution_assignments WHERE intent_id = ?", intent))
}

func sameObservedAssignment(current, observed LocalAssignment) bool {
	if current.IntentID != observed.IntentID || current.Claim.Assignment.RunExecutionId != observed.Claim.Assignment.RunExecutionId || current.Claim.Assignment.AssignmentGeneration != observed.Claim.Assignment.AssignmentGeneration || current.LockID != observed.LockID || (current.Supervisor == nil) != (observed.Supervisor == nil) || (current.Group == nil) != (observed.Group == nil) {
		return false
	}
	return (current.Supervisor == nil || *current.Supervisor == *observed.Supervisor) && (current.Group == nil || *current.Group == *observed.Group)
}

func (store *IntentStore) captureProcess(ctx context.Context, observed LocalAssignment, capture processCapture, now time.Time) (*generated.LocalExecutionObservation, error) {
	if !terminalIntent.MatchString(observed.IntentID) || (capture.ProviderImage && capture.State != "live") {
		return nil, failure("invalid_request")
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, failure("storage_failed")
	}
	defer tx.Rollback()
	assignment, err := scanAssignment(tx.QueryRowContext(ctx, "SELECT "+assignmentColumns+" FROM local_execution_assignments WHERE intent_id = ?", observed.IntentID))
	if err != nil || !sameObservedAssignment(assignment, observed) {
		return nil, failure("execution_assignment_invalid")
	}
	checkpoint, err := scanObservationCheckpoint(tx.QueryRowContext(ctx, "SELECT "+observationColumns+" FROM local_execution_assignments WHERE intent_id = ?", observed.IntentID))
	if err != nil {
		return nil, err
	}
	stamp := localTimestamp(now)
	now, err = time.Parse(time.RFC3339Nano, stamp)
	created, createdErr := time.Parse(time.RFC3339Nano, assignment.CreatedAt)
	last, _ := time.Parse(time.RFC3339Nano, checkpoint.LastObserved)
	if err != nil || createdErr != nil || now.Before(created) || now.Before(last) {
		return nil, failure("execution_assignment_invalid")
	}
	if checkpoint.ProcessAbsent != "" {
		if capture.State == "gone" || capture.State == "never_started" {
			return nil, nil
		}
		return nil, failure("execution_assignment_invalid")
	}
	state := assignment.State
	kind, diagnostic := "", ""
	switch capture.State {
	case "live":
		if assignment.Supervisor == nil || assignment.Group == nil || assignment.LockID == "" || (state != "group_ready" && state != "running" && state != "containment_unknown") {
			return nil, failure("execution_assignment_invalid")
		}
		if state == "containment_unknown" {
			return nil, nil
		}
		if checkpoint.ProviderObserved == "" {
			if !capture.ProviderImage {
				return nil, nil
			}
			kind, state, checkpoint.ProviderObserved = "execution_attached", "running", stamp
		} else {
			if now.Sub(last) < processHeartbeatInterval {
				return nil, nil
			}
			kind = "heartbeat"
		}
	case "unknown":
		if assignment.Supervisor == nil || (state != "registered" && state != "group_ready" && state != "running" && state != "containment_unknown") {
			return nil, failure("execution_assignment_invalid")
		}
		if state == "containment_unknown" && checkpoint.LastObserved != "" {
			return nil, nil
		}
		kind, state, diagnostic = "execution_detached", "containment_unknown", "containment_unknown"
	case "gone":
		if assignment.Supervisor == nil || assignment.LockID == "" || (state != "registered" && state != "group_ready" && state != "running" && state != "containment_unknown") {
			return nil, failure("execution_assignment_invalid")
		}
		if assignment.Group == nil {
			history, err := readNativeHistory(ctx, tx, assignment)
			if err != nil || history.Group == nil || history.LocalReleasedAt == "" {
				return nil, failure("containment_unknown")
			}
		}
		kind = "execution_ended"
		if state != "containment_unknown" {
			state = "ending"
		}
	case "never_started":
		if assignment.Group != nil || capture.Diagnostic == nil {
			return nil, failure("execution_assignment_invalid")
		}
		if assignment.Supervisor == nil {
			// Unregistered cleanup must atomically exclude future registration.
			var cleanup sql.NullString
			if assignment.LockID != "" || state != "blocked" ||
				tx.QueryRowContext(ctx, "SELECT cleanup_lock_id FROM execution_commands WHERE runner_id = ? AND command_id = ?", assignment.Claim.Assignment.RunnerId, assignment.Claim.Specification.LaunchId).Scan(&cleanup) != nil || !cleanup.Valid || !executionID.MatchString(cleanup.String) {
				return nil, failure("execution_assignment_invalid")
			}
		} else {
			// A registered helper needs either native release or a closed final-
			// authorization gate with fresh preflight supervisor absence.
			history, err := readNativeHistory(ctx, tx, assignment)
			if err != nil || history.Group != nil || (history.LocalReleasedAt == "" && !hasPreflightProof(ctx, tx, assignment)) ||
				(state != "registered" && state != "containment_unknown" && !(state == "blocked" && history.PreflightStoppedAt != "")) {
				return nil, failure("containment_unknown")
			}
			if state != "containment_unknown" {
				state = "blocked"
			}
		}
		kind, diagnostic = "launch_blocked", daemon.AsFailure(capture.Diagnostic).Diagnostic().Code
	default:
		return nil, failure("invalid_request")
	}
	if capture.State == "gone" || capture.State == "never_started" {
		checkpoint.ProcessAbsent, checkpoint.EventWindowEndsAt = stamp, localTimestamp(now.Add(finalHookGrace))
	}
	if checkpoint.Sequence == maxObservationSequence {
		return nil, failure("execution_capacity")
	}
	var count int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM execution_observations").Scan(&count); err != nil {
		return nil, failure("storage_failed")
	}
	if count >= observationCapacity {
		return nil, failure("execution_capacity")
	}
	event := generated.LocalExecutionObservation{
		SchemaVersion: 1, EventId: daemon.NewRequestID(), RunExecutionId: assignment.Claim.Assignment.RunExecutionId,
		AssignmentGeneration: assignment.Claim.Assignment.AssignmentGeneration, Sequence: checkpoint.Sequence + 1,
		Kind: kind, OccurredAt: stamp, CaptureOrigin: "runner_observed", ProcessState: capture.State, ProviderStart: "unobserved",
	}
	if checkpoint.ProviderObserved != "" {
		event.ProviderStart = "observed"
	}
	if diagnostic != "" {
		event.Diagnostic = &diagnostic
	}
	data, err := wireJSON("local-execution-observation", event)
	if err != nil || len(data) > 8192 {
		return nil, failure("execution_assignment_invalid")
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO execution_observations
(event_id,execution_id,assignment_generation,sequence,observation_json,captured_at) VALUES (?,?,?,?,?,?)`,
		event.EventId, event.RunExecutionId, event.AssignmentGeneration, event.Sequence, string(data), stamp)
	if err != nil {
		return nil, failure("storage_failed")
	}
	_, err = tx.ExecContext(ctx, `UPDATE local_execution_assignments SET state = ?, event_sequence = ?,
provider_observed_at = nullif(?,''), process_absent_at = nullif(?,''), event_window_ends_at = nullif(?,''),
last_process_observed_at = ?, diagnostic = nullif(?,'') WHERE intent_id = ?`,
		state, event.Sequence, checkpoint.ProviderObserved, checkpoint.ProcessAbsent, checkpoint.EventWindowEndsAt, stamp, diagnostic, assignment.IntentID)
	if err != nil || tx.Commit() != nil {
		return nil, failure("storage_failed")
	}
	return &event, nil
}

// PendingObservations returns only typed local facts, never private assignment
// correlation or fresh lease authority. Reading does not acknowledge delivery.
func (store *IntentStore) PendingObservations(ctx context.Context, limit int) ([]generated.LocalExecutionObservation, error) {
	if limit < 1 || limit > 256 {
		return nil, failure("invalid_request")
	}
	rows, err := store.db.QueryContext(ctx, `SELECT event_id,execution_id,assignment_generation,sequence,observation_json,captured_at
FROM execution_observations WHERE imported_at IS NULL ORDER BY rowid LIMIT ?`, limit)
	if err != nil {
		return nil, failure("storage_failed")
	}
	defer rows.Close()
	result := []generated.LocalExecutionObservation{}
	for rows.Next() {
		var id, execution, data, stamp string
		var generation, sequence int64
		var event generated.LocalExecutionObservation
		if rows.Scan(&id, &execution, &generation, &sequence, &data, &stamp) != nil || len(data) > 8192 || strictPrivateJSON([]byte(data), &event) != nil {
			return nil, failure("execution_assignment_invalid")
		}
		if _, err = wireJSON("local-execution-observation", json.RawMessage(data)); err != nil || event.EventId != id || event.RunExecutionId != execution || event.AssignmentGeneration != generation || event.Sequence != sequence || event.OccurredAt != stamp {
			return nil, failure("execution_assignment_invalid")
		}
		result = append(result, event)
	}
	if rows.Err() != nil {
		return nil, failure("storage_failed")
	}
	return result, nil
}

// eventWindowOpen checks only the local capture window, not correlation or
// upload authorization. Hooks may precede the daemon's first image observation.
// Once absence is recorded its deadline is immutable; replay continues afterward.
func (store *IntentStore) eventWindowOpen(ctx context.Context, intent string, capturedAt time.Time) (bool, error) {
	assignment, err := store.ByIntent(ctx, intent)
	if err != nil {
		return false, err
	}
	checkpoint, err := store.observationCheckpoint(ctx, intent)
	if err != nil {
		return false, err
	}
	if assignment.Group == nil {
		return false, nil
	}
	started, _ := time.Parse(time.RFC3339Nano, assignment.CreatedAt)
	if capturedAt.Before(started) {
		return false, nil
	}
	if checkpoint.EventWindowEndsAt != "" {
		end, _ := time.Parse(time.RFC3339Nano, checkpoint.EventWindowEndsAt)
		return capturedAt.Before(end), nil
	}
	return true, nil
}

// closeEventWindows records the ordinary ending-to-ended transition without
// inventing a new event, changing a run result or clearing unknown containment.
func (store *IntentStore) closeEventWindows(ctx context.Context, now time.Time) error {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return failure("storage_failed")
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, "SELECT intent_id FROM local_execution_assignments WHERE state = 'ending' ORDER BY execution_id LIMIT 256")
	if err != nil {
		return failure("storage_failed")
	}
	intents := []string{}
	for rows.Next() {
		var intent string
		if rows.Scan(&intent) != nil {
			_ = rows.Close()
			return failure("storage_failed")
		}
		intents = append(intents, intent)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return failure("storage_failed")
	}
	for _, intent := range intents {
		checkpoint, err := scanObservationCheckpoint(tx.QueryRowContext(ctx, "SELECT "+observationColumns+" FROM local_execution_assignments WHERE intent_id = ?", intent))
		if err != nil {
			return err
		}
		end, err := time.Parse(time.RFC3339Nano, checkpoint.EventWindowEndsAt)
		if err != nil {
			return failure("execution_assignment_invalid")
		}
		if !now.Before(end) {
			if _, err = tx.ExecContext(ctx, "UPDATE local_execution_assignments SET state = 'ended' WHERE intent_id = ? AND state = 'ending'", intent); err != nil {
				return failure("storage_failed")
			}
		}
	}
	if tx.Commit() != nil {
		return failure("storage_failed")
	}
	return nil
}
