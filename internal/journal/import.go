// ABOUTME: Imports daemon-observed facts through the same durable sink with runner_observed provenance.
// ABOUTME: Provider hooks can never assert these kinds; only local inspection supplies them.

package journal

import (
	"context"
	"encoding/json"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

var observationKinds = map[string]bool{
	"launch_blocked":     true,
	"execution_attached": true,
	"execution_detached": true,
	"execution_ended":    true,
	"heartbeat":          true,
}

// ImportObservations journals pending daemon process observations with
// runner_observed provenance and marks them imported in the same transaction.
// Capture and checkpoint roll back together, so a crash never loses an
// accepted observation and never journals one twice.
func (store *Store) ImportObservations(ctx context.Context, assignments Assignments, observers Observers, limit int, now time.Time) (imported, quarantined int, err error) {
	pending, err := observers.PendingObservations(ctx, limit)
	if err != nil {
		return 0, 0, err
	}
	for _, observation := range pending {
		outcome, err := store.importOne(ctx, assignments, observers, observation, now)
		if err != nil {
			return imported, quarantined, err
		}
		if outcome == "imported" {
			imported++
		} else {
			quarantined++
		}
	}
	return imported, quarantined, nil
}

func (store *Store) importOne(ctx context.Context, assignments Assignments, observers Observers, observation Observation, now time.Time) (string, error) {
	assignment, err := assignments.ByExecution(ctx, observation.ExecutionID, observation.Generation)
	if err != nil {
		return store.quarantineObservation(ctx, observers, observation, "unknown_assignment", now)
	}
	if !observationKinds[observation.Kind] {
		return store.quarantineObservation(ctx, observers, observation, "observation_kind_invalid", now)
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return "", failure("storage_failed")
	}
	defer tx.Rollback()
	epoch, err := store.ensureEpochTx(ctx, tx)
	if err != nil {
		return "", err
	}
	stream, err := store.streamForRunner(ctx, tx, assignment.RunnerID, epoch, localTimestamp(now))
	if err != nil {
		return "", err
	}
	sequence, err := nextSequence(ctx, tx, assignment.RunnerID)
	if err != nil {
		return "", err
	}
	source := "l05-" + observation.EventID
	submission := generated.RunnerEventSubmission{
		SchemaVersion: 1, EventId: daemon.NewRequestID(), SourceStreamId: stream, SourceSequence: sequence,
		SourceEventId: &source, RunExecutionId: observation.ExecutionID, AssignmentGeneration: observation.Generation,
		Kind: observation.Kind, OccurredAt: observation.OccurredAt, CaptureOrigin: "runner_observed", Payload: map[string]any{},
	}
	if hint := ulidHint(assignment.WorkspaceID); hint != "" {
		value := hint
		submission.ClaimedWorkspaceId = &value
	}
	if hint := ulidHint(assignment.ProjectID); hint != "" {
		value := hint
		submission.ClaimedProjectId = &value
	}
	if hint := ulidHint(assignment.TaskID); hint != "" {
		value := hint
		submission.ClaimedTaskId = &value
	}
	if hint := ulidHint(assignment.RunID); hint != "" {
		value := hint
		submission.ClaimedRunId = &value
	}
	data, err := json.Marshal(submission)
	if err != nil {
		return "", failure("storage_failed")
	}
	if result := protocol.DecodeWireDocument("runner-event-submission", data); !result.OK {
		return "", failure("storage_failed")
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO hook_journal
(event_id, stream_id, source_sequence, runner_id, execution_id, assignment_generation, provider, kind, provider_session_id, source_event_id, occurred_at, captured_at, capture_origin, submission_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, 'runner_observed', ?)`,
		submission.EventId, stream, sequence, assignment.RunnerID, observation.ExecutionID, observation.Generation,
		assignment.Provider, observation.Kind, source, observation.OccurredAt, localTimestamp(now), string(data)); err != nil {
		return "", failure("storage_failed")
	}
	if err := observers.MarkImported(ctx, tx, []string{observation.EventID}, now); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", failure("storage_failed")
	}
	return "imported", nil
}

func (store *Store) quarantineObservation(ctx context.Context, observers Observers, observation Observation, reason string, now time.Time) (string, error) {
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return "", failure("storage_failed")
	}
	defer tx.Rollback()
	if err := quarantine(ctx, tx, observation.ExecutionID, observation.Generation, "daemon", observation.Kind, "", reason, observation.OccurredAt, localTimestamp(now)); err != nil {
		return "", err
	}
	if err := observers.MarkImported(ctx, tx, []string{observation.EventID}, now); err != nil {
		return "", err
	}
	if err := setDegraded(ctx, tx, reason, localTimestamp(now)); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", failure("storage_failed")
	}
	return "quarantined", nil
}
