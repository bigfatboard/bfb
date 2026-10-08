// ABOUTME: Exposes read-only assignment and capture-window views for the L06 hook journal.
// ABOUTME: L05 retains all supervision semantics; this adapter never mutates assignments or observations.

package supervisor

import (
	"context"
	"database/sql"
	"time"

	"github.com/qdis/bfb/internal/journal"
)

// JournalAssignment is the immutable assignment view consumed by hook validation.
// It mirrors the stored claim without duplicating durable supervision state.
type JournalAssignment struct {
	IntentID     string
	ExecutionID  string
	Generation   int64
	RunnerID     string
	WorkspaceID  string
	ProjectID    string
	TaskID       string
	RunID        string
	CheckoutID   string
	Provider     string
	Token        string
	CreatedAt    string
	WindowEndsAt string
}

func journalView(assignment LocalAssignment, windowEndsAt string) JournalAssignment {
	claim := assignment.Claim
	return JournalAssignment{
		IntentID:     assignment.IntentID,
		ExecutionID:  claim.Assignment.RunExecutionId,
		Generation:   int64(claim.Assignment.AssignmentGeneration),
		RunnerID:     claim.Assignment.RunnerId,
		WorkspaceID:  claim.Assignment.WorkspaceId,
		ProjectID:    claim.Assignment.ProjectId,
		TaskID:       claim.Assignment.TaskId,
		RunID:        claim.Assignment.RunId,
		CheckoutID:   claim.Assignment.CheckoutId,
		Provider:     string(claim.Specification.ExecutionConfig.Provider),
		Token:        assignment.CorrelationToken,
		CreatedAt:    assignment.CreatedAt,
		WindowEndsAt: windowEndsAt,
	}
}

// JournalByExecution resolves one immutable assignment by execution identity.
// Unknown executions fail closed without guessing another run.
func (store *IntentStore) JournalByExecution(ctx context.Context, execution string, generation int64) (JournalAssignment, error) {
	var intent string
	if !executionID.MatchString(execution) || generation < 1 || generation > 9007199254740991 {
		return JournalAssignment{}, failure("unknown_assignment")
	}
	err := store.db.QueryRowContext(ctx, "SELECT intent_id FROM local_execution_assignments WHERE execution_id = ? AND assignment_generation = ?", execution, generation).Scan(&intent)
	if err == sql.ErrNoRows {
		return JournalAssignment{}, failure("unknown_assignment")
	}
	if err != nil {
		return JournalAssignment{}, failure("storage_failed")
	}
	return store.JournalByIntent(ctx, intent)
}

// JournalByIntent resolves one immutable assignment by local intent identity.
func (store *IntentStore) JournalByIntent(ctx context.Context, intent string) (JournalAssignment, error) {
	assignment, err := store.ByIntent(ctx, intent)
	if err != nil {
		return JournalAssignment{}, err
	}
	checkpoint, err := store.observationCheckpoint(ctx, intent)
	if err != nil {
		return JournalAssignment{}, err
	}
	return journalView(assignment, checkpoint.EventWindowEndsAt), nil
}

// JournalObservations returns pending daemon-observed facts without acknowledging
// delivery. The journal marks them imported only after its own durable commit.
func (store *IntentStore) JournalObservations(ctx context.Context, limit int) ([]JournalObservation, error) {
	pending, err := store.PendingObservations(ctx, limit)
	if err != nil {
		return nil, err
	}
	result := make([]JournalObservation, 0, len(pending))
	for _, event := range pending {
		result = append(result, JournalObservation{
			EventID:       event.EventId,
			ExecutionID:   event.RunExecutionId,
			Generation:    int64(event.AssignmentGeneration),
			Sequence:      int64(event.Sequence),
			Kind:          event.Kind,
			OccurredAt:    event.OccurredAt,
			ProviderStart: event.ProviderStart,
			Diagnostic:    event.Diagnostic,
		})
	}
	return result, nil
}

// JournalObservation is the daemon-observed fact the journal imports through the
// same durable sink with runner_observed provenance.
type JournalObservation struct {
	EventID       string
	ExecutionID   string
	Generation    int64
	Sequence      int64
	Kind          string
	OccurredAt    string
	ProviderStart string
	Diagnostic    *string
}

// JournalBackend adapts this intent store to the journal's assignment and
// observer interfaces. It performs no supervision semantic change: every
// method is a read, except MarkImported which the journal co-commits with its
// own durable rows after they are safely stored.
type JournalBackend struct{ Intents *IntentStore }

// ByExecution resolves one immutable assignment by execution identity.
func (backend JournalBackend) ByExecution(ctx context.Context, execution string, generation int64) (journal.Assignment, error) {
	view, err := backend.Intents.JournalByExecution(ctx, execution, generation)
	if err != nil {
		return journal.Assignment{}, err
	}
	return journal.Assignment{
		IntentID: view.IntentID, ExecutionID: view.ExecutionID, Generation: view.Generation,
		RunnerID: view.RunnerID, WorkspaceID: view.WorkspaceID, ProjectID: view.ProjectID,
		TaskID: view.TaskID, RunID: view.RunID, CheckoutID: view.CheckoutID,
		Provider: view.Provider, Token: view.Token, CreatedAt: view.CreatedAt, WindowEndsAt: view.WindowEndsAt,
	}, nil
}

// ByIntent resolves one immutable assignment by local intent identity.
func (backend JournalBackend) ByIntent(ctx context.Context, intent string) (journal.Assignment, error) {
	view, err := backend.Intents.JournalByIntent(ctx, intent)
	if err != nil {
		return journal.Assignment{}, err
	}
	return journal.Assignment{
		IntentID: view.IntentID, ExecutionID: view.ExecutionID, Generation: view.Generation,
		RunnerID: view.RunnerID, WorkspaceID: view.WorkspaceID, ProjectID: view.ProjectID,
		TaskID: view.TaskID, RunID: view.RunID, CheckoutID: view.CheckoutID,
		Provider: view.Provider, Token: view.Token, CreatedAt: view.CreatedAt, WindowEndsAt: view.WindowEndsAt,
	}, nil
}

// PendingObservations returns daemon-observed facts without acknowledging import.
func (backend JournalBackend) PendingObservations(ctx context.Context, limit int) ([]journal.Observation, error) {
	pending, err := backend.Intents.JournalObservations(ctx, limit)
	if err != nil {
		return nil, err
	}
	result := make([]journal.Observation, 0, len(pending))
	for _, event := range pending {
		result = append(result, journal.Observation{
			EventID: event.EventID, ExecutionID: event.ExecutionID, Generation: event.Generation,
			Sequence: event.Sequence, Kind: event.Kind, OccurredAt: event.OccurredAt,
			ProviderStart: event.ProviderStart, Diagnostic: event.Diagnostic,
		})
	}
	return result, nil
}

// MarkImported records durable journal import inside the journal transaction.
func (backend JournalBackend) MarkImported(ctx context.Context, tx *sql.Tx, eventIDs []string, now time.Time) error {
	return JournalMarkImported(ctx, tx, eventIDs, now)
}

// JournalMarkImported records durable journal import of observed facts. It runs
// in the journal's own import transaction after the journal rows commit.
func JournalMarkImported(ctx context.Context, tx *sql.Tx, eventIDs []string, now time.Time) error {
	stamp := now.UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano)
	for _, id := range eventIDs {
		result, err := tx.ExecContext(ctx, "UPDATE execution_observations SET imported_at = ? WHERE event_id = ? AND imported_at IS NULL", stamp, id)
		if err != nil {
			return failure("storage_failed")
		}
		if count, _ := result.RowsAffected(); count != 1 {
			return failure("storage_failed")
		}
	}
	return nil
}
