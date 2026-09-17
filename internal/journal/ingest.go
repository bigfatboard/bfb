// ABOUTME: Validates provider hooks against immutable assignments and journals durable upload events.
// ABOUTME: Binds the first SessionStart atomically and never re-parses provider raw schemas.

package journal

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
)

// HookInput carries one bounded provider hook delivery with its local capture
// proof. The correlation token authenticates capture only and never uploads.
type HookInput struct {
	Provider    string
	Raw         []byte
	ExecutionID string
	Generation  int64
	Token       string
	WorkspaceID string
	ProjectID   string
	TaskID      string
	RunID       string
	CapturedAt  time.Time
}

// Receipt is the durable local outcome returned quickly to the provider hook.
// Rejections are visible and safe; storage faults stay retryable by the caller.
type Receipt struct {
	Status   string `json:"status"`
	EventID  string `json:"event_id,omitempty"`
	Sequence int64  `json:"sequence,omitempty"`
	Code     string `json:"code,omitempty"`
}

var candidateKinds = map[string]string{
	"session_started": "session_started",
	"turn_started":    "turn_started",
	"turn_completed":  "turn_stopped",
	"tool_started":    "tool_started",
	"tool_completed":  "",
	"interrupted":     "turn_failed",
	"session_ended":   "session_ended",
	"provider_error":  "turn_failed",
	"usage":           "progress_reported",
}

// validatedHook is a hook that passed assignment, correlation and window checks.
type validatedHook struct {
	candidate  *provider.Candidate
	assignment Assignment
	kind       string
	stamp      string
}

// validateHook checks the hook against the immutable L05 assignment without
// touching journal state. A returned empty stamp means a visible rejection with
// the returned code; a returned error means a retryable storage or hook fault.
func validateHook(ctx context.Context, assignments Assignments, registry *provider.Registry, input HookInput) (validatedHook, string, error) {
	if len(input.Raw) == 0 || len(input.Raw) > provider.MaxHookBytes {
		return validatedHook{}, "", failure("provider_event_invalid")
	}
	assignment, err := assignments.ByExecution(ctx, input.ExecutionID, input.Generation)
	if err != nil {
		return validatedHook{}, asCode(err), nil
	}
	if assignment.RunnerID == "" || assignment.Provider == "" || assignment.Token == "" || assignment.CreatedAt == "" {
		return validatedHook{}, "unknown_assignment", nil
	}
	if !validToken(input.Token, assignment.Token) {
		return validatedHook{}, "correlation_rejected", nil
	}
	if input.Provider != assignment.Provider {
		return validatedHook{}, "provider_mismatch", nil
	}
	candidate, err := registry.NormalizeHook(input.Provider, input.Raw)
	if err != nil || candidate == nil {
		return validatedHook{}, "", failure("provider_event_invalid")
	}
	stamp := localTimestamp(input.CapturedAt)
	created, err := time.Parse(time.RFC3339Nano, assignment.CreatedAt)
	if err != nil || input.CapturedAt.Before(created) {
		return validatedHook{}, "event_window_closed", nil
	}
	if assignment.WindowEndsAt != "" {
		windowEnd, err := time.Parse(time.RFC3339Nano, assignment.WindowEndsAt)
		if err != nil || !input.CapturedAt.Before(windowEnd) {
			return validatedHook{}, "event_window_closed", nil
		}
	}
	kind, ok := candidateKinds[candidate.Kind]
	if !ok {
		return validatedHook{}, "provider_event_invalid", nil
	}
	if candidate.Kind == "tool_completed" {
		kind = "tool_finished"
		if candidate.Outcome == "failed" || candidate.Outcome == "cancelled" {
			kind = "tool_failed"
		}
	}
	if candidate.SessionID == "" && candidate.Kind == "session_started" {
		return validatedHook{}, "provider_event_invalid", nil
	}
	return validatedHook{candidate: candidate, assignment: assignment, kind: kind, stamp: stamp}, "", nil
}

// Ingest validates one hook delivery and journals its durable upload event in a
// single transaction: event ID and source sequence allocation, session binding,
// duplicate suppression and capture-window checks commit or roll back together.
func (store *Store) Ingest(ctx context.Context, assignments Assignments, registry *provider.Registry, input HookInput, now time.Time) (Receipt, error) {
	validated, code, err := validateHook(ctx, assignments, registry, input)
	if err != nil {
		return Receipt{}, err
	}
	if validated.stamp == "" {
		return Receipt{Status: "rejected", Code: code}, nil
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return Receipt{}, failure("storage_failed")
	}
	defer tx.Rollback()
	receipt, err := journalTx(ctx, store, tx, validated, input, now)
	if err != nil {
		return Receipt{}, err
	}
	if err := tx.Commit(); err != nil {
		return Receipt{}, failure("storage_failed")
	}
	return receipt, nil
}

// journalTx journals one validated hook inside the caller's transaction so
// inbox import can co-commit its file receipt atomically. It never commits.
func journalTx(ctx context.Context, store *Store, tx *sql.Tx, validated validatedHook, input HookInput, now time.Time) (Receipt, error) {
	candidate, assignment, kind, stamp := validated.candidate, validated.assignment, validated.kind, validated.stamp
	origin := "agent_reported"
	if candidate.SessionID != "" {
		// The first session-scoped hook atomically binds the observed
		// session, because provider hooks run concurrently and SessionStart
		// may lose the race to its own turns. A competing session never
		// rebinds the execution; it is rejected and quarantined.
		bound, _, err := bindSession(ctx, tx, input.Provider, candidate.SessionID, input.ExecutionID, input.Generation, localTimestamp(now))
		if err != nil {
			return Receipt{}, err
		}
		if !bound {
			if err := quarantine(ctx, tx, input.ExecutionID, input.Generation, input.Provider, kind, candidate.SessionID, "session_conflict", stamp, localTimestamp(now)); err != nil {
				return Receipt{}, err
			}
			return Receipt{Status: "quarantined", Code: "session_conflict"}, nil
		}
		// An idempotent duplicate SessionStart matches the binding without
		// journaling another session event, even when redelivered with a
		// new source ID: it remains the same bound session.
		if candidate.Kind == "session_started" {
			if eventID, found, err := firstSessionEvent(ctx, tx, input.ExecutionID, input.Generation, candidate.SessionID); err != nil {
				return Receipt{}, err
			} else if found {
				return Receipt{Status: "duplicate", EventID: eventID}, nil
			}
		}
	}
	// Independently redelivered hooks carrying the provider's stable event ID
	// journal once; transport retries of a persisted BFB event dedup by event ID.
	if candidate.SourceEventID != "" && candidate.Kind != "session_started" {
		if eventID, found, err := duplicateEvent(ctx, tx, input.ExecutionID, input.Generation, candidate.SourceEventID); err != nil {
			return Receipt{}, err
		} else if found {
			return Receipt{Status: "duplicate", EventID: eventID}, nil
		}
	}

	epoch, err := store.ensureEpochTx(ctx, tx)
	if err != nil {
		return Receipt{}, err
	}
	stream, err := store.streamForRunner(ctx, tx, assignment.RunnerID, epoch, localTimestamp(now))
	if err != nil {
		return Receipt{}, err
	}
	sequence, err := nextSequence(ctx, tx, assignment.RunnerID)
	if err != nil {
		return Receipt{}, err
	}
	submission := generated.RunnerEventSubmission{
		SchemaVersion: 1, EventId: daemon.NewRequestID(), SourceStreamId: stream, SourceSequence: sequence,
		RunExecutionId: input.ExecutionID, AssignmentGeneration: input.Generation,
		Kind: kind, OccurredAt: stamp, CaptureOrigin: origin, Payload: map[string]any{},
	}
	if candidate.SourceEventID != "" {
		source := candidate.SourceEventID
		submission.SourceEventId = &source
	}
	if candidate.SessionID != "" {
		session := candidate.SessionID
		submission.ProviderSessionId = &session
	}
	if hint := ulidHint(input.WorkspaceID); hint != "" {
		value := hint
		submission.ClaimedWorkspaceId = &value
	}
	if hint := ulidHint(input.ProjectID); hint != "" {
		value := hint
		submission.ClaimedProjectId = &value
	}
	if hint := ulidHint(input.TaskID); hint != "" {
		value := hint
		submission.ClaimedTaskId = &value
	}
	if hint := ulidHint(input.RunID); hint != "" {
		value := hint
		submission.ClaimedRunId = &value
	}
	data, err := json.Marshal(submission)
	if err != nil {
		return Receipt{}, failure("storage_failed")
	}
	if result := protocol.DecodeWireDocument("runner-event-submission", data); !result.OK {
		return Receipt{}, failure("storage_failed")
	}
	sourceEvent := ""
	if submission.SourceEventId != nil {
		sourceEvent = *submission.SourceEventId
	}
	sessionID := ""
	if submission.ProviderSessionId != nil {
		sessionID = *submission.ProviderSessionId
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO hook_journal
(event_id, stream_id, source_sequence, runner_id, execution_id, assignment_generation, provider, kind, provider_session_id, source_event_id, occurred_at, captured_at, capture_origin, submission_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		submission.EventId, stream, sequence, assignment.RunnerID, input.ExecutionID, input.Generation,
		input.Provider, kind, sessionID, sourceEvent, stamp, stamp, origin, string(data)); err != nil {
		return Receipt{}, failure("storage_failed")
	}
	return Receipt{Status: "accepted", EventID: submission.EventId, Sequence: int64(sequence)}, nil
}

func firstSessionEvent(ctx context.Context, tx *sql.Tx, execution string, generation int64, session string) (string, bool, error) {
	var eventID string
	err := tx.QueryRowContext(ctx, "SELECT event_id FROM hook_journal WHERE execution_id = ? AND assignment_generation = ? AND kind = 'session_started' AND provider_session_id = ? ORDER BY rowid LIMIT 1", execution, generation, session).Scan(&eventID)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, failure("storage_failed")
	}
	return eventID, true, nil
}

func duplicateEvent(ctx context.Context, tx *sql.Tx, execution string, generation int64, source string) (string, bool, error) {
	var eventID string
	err := tx.QueryRowContext(ctx, "SELECT event_id FROM hook_journal WHERE execution_id = ? AND assignment_generation = ? AND source_event_id = ?", execution, generation, source).Scan(&eventID)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, failure("storage_failed")
	}
	return eventID, true, nil
}

func quarantine(ctx context.Context, tx *sql.Tx, execution string, generation int64, provider, kind, session, reason, captured, now string) error {
	if _, err := tx.ExecContext(ctx, "INSERT INTO hook_quarantine (id, execution_id, assignment_generation, provider, kind, session_id, reason, captured_at, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		daemon.NewRequestID(), execution, generation, provider, kind, session, reason, captured, now); err != nil {
		return failure("storage_failed")
	}
	return nil
}

func ulidHint(value string) string {
	if len(value) != 26 {
		return ""
	}
	for _, c := range []byte(value) {
		if !(c >= '0' && c <= '9' || c >= 'A' && c <= 'H' || c >= 'J' && c <= 'K' || c >= 'M' && c <= 'N' || c >= 'P' && c <= 'T' || c >= 'V' && c <= 'Z') {
			return ""
		}
	}
	if value[0] > '7' {
		return ""
	}
	return value
}

func (store *Store) ensureEpochTx(ctx context.Context, tx *sql.Tx) (string, error) {
	var epoch string
	if err := tx.QueryRowContext(ctx, "SELECT value FROM hook_journal_meta WHERE key = 'db_epoch'").Scan(&epoch); err != nil {
		return "", failure("storage_failed")
	}
	if epoch != "" {
		return epoch, nil
	}
	epoch = daemon.NewRequestID()
	if _, err := tx.ExecContext(ctx, "UPDATE hook_journal_meta SET value = ? WHERE key = 'db_epoch' AND value = ''", epoch); err != nil {
		return "", failure("storage_failed")
	}
	if err := tx.QueryRowContext(ctx, "SELECT value FROM hook_journal_meta WHERE key = 'db_epoch'").Scan(&epoch); err != nil || epoch == "" {
		return "", failure("storage_failed")
	}
	return epoch, nil
}

func nextSequence(ctx context.Context, tx *sql.Tx, runner string) (int64, error) {
	if _, err := tx.ExecContext(ctx, "UPDATE hook_source_streams SET next_sequence = next_sequence + 1 WHERE runner_id = ?", runner); err != nil {
		return 0, failure("storage_failed")
	}
	var next int64
	if err := tx.QueryRowContext(ctx, "SELECT next_sequence FROM hook_source_streams WHERE runner_id = ?", runner).Scan(&next); err != nil {
		return 0, failure("storage_failed")
	}
	return next - 1, nil
}
