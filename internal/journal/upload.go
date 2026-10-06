// ABOUTME: Uploads journaled events through the runner channel with retry and backoff.
// ABOUTME: Applies only explicit per-event dispositions; cursors never delete journal rows.

package journal

import (
	"context"
	"encoding/json"
	"time"

	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

// UploadAction is the runner channel action carrying event batches. It names
// the E01 ingest route served at .../events/ingest (the nativePattern in
// apps/control-worker/src/api/events.ts); E01 owns disposition-only deletion.
const UploadAction = "events/ingest"

// Connection is the narrow authenticated transport boundary the uploader needs.
// *runner.Connection satisfies it; tests supply a scripted fake.
type Connection interface {
	Request(ctx context.Context, method, action string, body []byte) ([]byte, error)
}

// Uploader drains one journal through per-enrollment connections. It keeps no
// delivery state outside the journal tables, so a restart resumes safely.
type Uploader struct {
	Store       *Store
	Assignments Assignments
	Lookup      func(runnerID string) (Connection, error)
	Now         func() time.Time
}

func (uploader *Uploader) now() time.Time {
	if uploader.Now != nil {
		return uploader.Now()
	}
	return time.Now()
}

func uploadBackoff(failures int) time.Duration {
	delay := 2 * time.Second
	for index := 0; index < failures && delay < 5*time.Minute; index++ {
		delay *= 2
	}
	if delay > 5*time.Minute {
		delay = 5 * time.Minute
	}
	return delay
}

type pendingEvent struct {
	eventID    string
	stream     string
	sequence   int64
	runner     string
	execution  string
	generation int64
	provider   string
	kind       string
	session    string
	submission string
	workspace  string
	version    int64
}

// UploadOnce uploads one bounded batch per due runner enrollment and applies
// the returned dispositions. Transport faults keep every row queued with
// backoff; only explicit dispositions delete or quarantine rows.
func (uploader *Uploader) UploadOnce(ctx context.Context) (uploaded, pending int, err error) {
	now := localTimestamp(uploader.now())
	rows, err := uploader.Store.db.QueryContext(ctx, `SELECT runner_id FROM hook_source_streams WHERE next_attempt_at <= ? ORDER BY runner_id`, now)
	if err != nil {
		return 0, 0, failure("storage_failed")
	}
	runners := []string{}
	for rows.Next() {
		var runner string
		if err := rows.Scan(&runner); err != nil {
			_ = rows.Close()
			return 0, 0, failure("storage_failed")
		}
		runners = append(runners, runner)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return 0, 0, failure("storage_failed")
	}
	_ = rows.Close()
	for _, runner := range runners {
		done, _, err := uploader.uploadRunner(ctx, runner, now)
		if err != nil {
			return uploaded, 0, err
		}
		uploaded += done
	}
	if err := uploader.Store.db.QueryRowContext(ctx, "SELECT count(*) FROM hook_journal").Scan(&pending); err != nil {
		return uploaded, 0, failure("storage_failed")
	}
	var typedPending int
	if err := uploader.Store.db.QueryRowContext(ctx, `SELECT count(*) FROM hook_journal WHERE json_extract(submission_json, '$.schema_version') = 2`).Scan(&typedPending); err != nil {
		return uploaded, pending, failure("storage_failed")
	}
	// One enrollment's successful capability read cannot hide another's
	// unsupported backlog. Clear recoverable upload state only after draining.
	if typedPending == 0 {
		if err := clearUploadDegraded(ctx, uploader.Store.db); err != nil {
			return uploaded, pending, err
		}
	}
	return uploaded, pending, nil
}

func (uploader *Uploader) uploadRunner(ctx context.Context, runner, now string) (int, int, error) {
	connection, err := uploader.Lookup(runner)
	if err != nil {
		return 0, 0, nil
	}
	var typedPending int
	if err := uploader.Store.db.QueryRowContext(ctx, `SELECT count(*) FROM hook_journal WHERE runner_id = ? AND json_extract(submission_json, '$.schema_version') = 2`, runner).Scan(&typedPending); err != nil {
		return 0, 0, failure("storage_failed")
	}
	typedSupported := false
	if typedPending > 0 {
		response, err := connection.Request(ctx, "GET", "events/capabilities", nil)
		typedSupported = err == nil && protocol.DecodeWireDocument("runner-event-capabilities", response).OK
		if !typedSupported {
			reason := "telemetry_upgrade_required"
			if err != nil {
				reason = "telemetry_unavailable"
			}
			if err := setUploadDegraded(ctx, uploader.Store.db, reason, now); err != nil {
				return 0, 0, err
			}
		}
	}
	// Unsupported typed rows remain durable; they cannot starve older-peer v1
	// delivery or be rewritten into a less informative event version.
	rows, err := uploader.Store.db.QueryContext(ctx, `SELECT event_id, stream_id, source_sequence, runner_id, execution_id, assignment_generation, provider, kind, provider_session_id, submission_json, workspace_id, json_extract(submission_json, '$.schema_version')
FROM hook_journal WHERE runner_id = ? AND (? OR json_extract(submission_json, '$.schema_version') = 1) ORDER BY captured_at, rowid LIMIT ?`, runner, typedSupported, maxUploadBatch)
	if err != nil {
		return 0, 0, failure("storage_failed")
	}
	batch := []pendingEvent{}
	for rows.Next() {
		var event pendingEvent
		if err := rows.Scan(&event.eventID, &event.stream, &event.sequence, &event.runner, &event.execution, &event.generation, &event.provider, &event.kind, &event.session, &event.submission, &event.workspace, &event.version); err != nil {
			_ = rows.Close()
			return 0, 0, failure("storage_failed")
		}
		batch = append(batch, event)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return 0, 0, failure("storage_failed")
	}
	_ = rows.Close()
	if len(batch) == 0 {
		if typedPending > 0 && !typedSupported {
			uploader.recordFailure(ctx, runner, now)
		}
		return 0, 0, nil
	}
	for index := range batch {
		if batch[index].workspace == "" && uploader.Assignments != nil {
			assignment, err := uploader.Assignments.ByExecution(ctx, batch[index].execution, batch[index].generation)
			if err != nil || assignment.RunnerID != runner {
				return 0, len(batch), failure("storage_failed")
			}
			batch[index].workspace = assignment.WorkspaceID
		}
		if batch[index].workspace == "" || batch[index].workspace != batch[0].workspace {
			return 0, len(batch), failure("storage_failed")
		}
	}
	// Shrink the batch to the E01 transport bounds: at most maxUploadBatch
	// items with a body of at most uploadBodyLimit bytes. The batch holds
	// the oldest rows, so every UploadOnce makes progress and the journal
	// drains instead of stalling on a whole-batch transport rejection.
	// Oversized single items are still delivered one per batch: the server
	// answers those with a per-event permanently_rejected disposition that
	// quarantines exactly that row.
	sent := batch[:0]
	events := make([]json.RawMessage, 0, len(batch))
	for _, event := range batch {
		candidate := append(events, json.RawMessage(event.submission))
		body, err := json.Marshal(map[string]any{"schema_version": 1, "events": candidate})
		if err != nil {
			return 0, len(batch), failure("storage_failed")
		}
		if len(body) > uploadBodyLimit && len(events) > 0 {
			break
		}
		events = candidate
		sent = append(sent, event)
	}
	batch = sent
	body, err := json.Marshal(map[string]any{"schema_version": 1, "events": events})
	// Every locally validated item fits; this arm guards local corruption.
	if err != nil || (len(body) > uploadBodyLimit && len(batch) > 1) {
		return 0, len(batch), failure("storage_failed")
	}
	response, err := connection.Request(ctx, "POST", UploadAction, body)
	if err != nil {
		uploader.recordFailure(ctx, runner, now)
		return 0, len(batch), nil
	}
	ack, ok := parseAcknowledgement(response)
	if !ok || ack.WorkspaceId != batch[0].workspace || !matchesBatch(batch, ack.Dispositions) {
		// A corrupt acknowledgement is a transport fault: no row is deleted or
		// quarantined from an unreadable response.
		uploader.recordFailure(ctx, runner, now)
		return 0, len(batch), nil
	}
	return uploader.applyDispositions(ctx, runner, batch, ack.Dispositions, now, typedPending > 0 && !typedSupported)
}

func parseDispositions(response []byte) ([]generated.EventDisposition, bool) {
	ack, ok := parseAcknowledgement(response)
	return ack.Dispositions, ok
}

func parseAcknowledgement(response []byte) (generated.RunnerEventIngestResult, bool) {
	var ack generated.RunnerEventIngestResult
	if !protocol.DecodeWireDocument("runner-event-ingest-result", response).OK {
		return ack, false
	}
	if json.Unmarshal(response, &ack) != nil {
		return ack, false
	}
	return ack, true
}

func matchesBatch(batch []pendingEvent, dispositions []generated.EventDisposition) bool {
	if len(batch) != len(dispositions) {
		return false
	}
	byID := make(map[string]pendingEvent, len(batch))
	for _, event := range batch {
		byID[event.eventID] = event
	}
	for _, disposition := range dispositions {
		event, ok := byID[disposition.EventId]
		if !ok || event.stream != disposition.SourceStreamId || event.sequence != int64(disposition.SourceSequence) {
			return false
		}
		delete(byID, disposition.EventId)
	}
	return len(byID) == 0
}

func (uploader *Uploader) applyDispositions(ctx context.Context, runner string, batch []pendingEvent, dispositions []generated.EventDisposition, now string, compatibilityRetry bool) (int, int, error) {
	byID := make(map[string]pendingEvent, len(batch))
	for _, event := range batch {
		byID[event.eventID] = event
	}
	tx, err := uploader.Store.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, len(batch), failure("storage_failed")
	}
	defer tx.Rollback()
	removed := 0
	retryable := false
	for _, disposition := range dispositions {
		event, ok := byID[disposition.EventId]
		if !ok || event.stream != disposition.SourceStreamId || event.sequence != int64(disposition.SourceSequence) {
			continue
		}
		switch disposition.Disposition {
		case "accepted", "already_committed":
			if _, err := tx.ExecContext(ctx, "DELETE FROM hook_journal WHERE event_id = ?", event.eventID); err != nil {
				return 0, len(batch), failure("storage_failed")
			}
			removed++
		case "permanently_rejected":
			// A locally valid v2 item rejected as an unknown schema indicates
			// compatibility drift, not poison data. Preserve its exact bytes.
			if event.version == 2 && disposition.Diagnostic != nil && (disposition.Diagnostic.Category == "unknown_version" || disposition.Diagnostic.Code == "unsupported_schema_version") {
				if err := setUploadDegraded(ctx, tx, "telemetry_upgrade_required", now); err != nil {
					return 0, len(batch), err
				}
				retryable = true
				continue
			}
			reason := "permanent_reject"
			if disposition.Diagnostic != nil && disposition.Diagnostic.Code != "" {
				reason = "permanent_reject_" + disposition.Diagnostic.Code
				if len(reason) > 64 {
					reason = reason[:64]
				}
			}
			var captured string
			if err := tx.QueryRowContext(ctx, "SELECT captured_at FROM hook_journal WHERE event_id = ?", event.eventID).Scan(&captured); err != nil {
				return 0, len(batch), failure("storage_failed")
			}
			if err := quarantine(ctx, tx, event.execution, event.generation, event.provider, event.kind, event.session, reason, captured, now); err != nil {
				return 0, len(batch), err
			}
			if _, err := tx.ExecContext(ctx, "DELETE FROM hook_journal WHERE event_id = ?", event.eventID); err != nil {
				return 0, len(batch), failure("storage_failed")
			}
			removed++
		case "retryable":
			retryable = true
			if _, err := tx.ExecContext(ctx, "UPDATE hook_journal SET attempts = attempts + 1 WHERE event_id = ?", event.eventID); err != nil {
				return 0, len(batch), failure("storage_failed")
			}
		default:
			return 0, len(batch), failure("storage_failed")
		}
		delete(byID, disposition.EventId)
	}
	if retryable || len(byID) > 0 || compatibilityRetry {
		for _, event := range byID {
			if _, err := tx.ExecContext(ctx, "UPDATE hook_journal SET attempts = attempts + 1 WHERE event_id = ?", event.eventID); err != nil {
				return 0, len(batch), failure("storage_failed")
			}
		}
		var failures int
		if err := tx.QueryRowContext(ctx, "SELECT failures FROM hook_source_streams WHERE runner_id = ?", runner).Scan(&failures); err != nil {
			return 0, len(batch), failure("storage_failed")
		}
		if _, err := tx.ExecContext(ctx, "UPDATE hook_source_streams SET failures = failures + 1, next_attempt_at = ? WHERE runner_id = ?", localTimestamp(uploader.now().Add(uploadBackoff(failures+1))), runner); err != nil {
			return 0, len(batch), failure("storage_failed")
		}
	} else {
		if _, err := tx.ExecContext(ctx, "UPDATE hook_source_streams SET failures = 0, next_attempt_at = ? WHERE runner_id = ?", now, runner); err != nil {
			return 0, len(batch), failure("storage_failed")
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, len(batch), failure("storage_failed")
	}
	return removed, len(batch) - removed, nil
}

func (uploader *Uploader) recordFailure(ctx context.Context, runner, now string) {
	var failures int
	if err := uploader.Store.db.QueryRowContext(ctx, "SELECT failures FROM hook_source_streams WHERE runner_id = ?", runner).Scan(&failures); err != nil {
		return
	}
	next := localTimestamp(uploader.now().Add(uploadBackoff(failures + 1)))
	_, _ = uploader.Store.db.ExecContext(ctx, "UPDATE hook_source_streams SET failures = failures + 1, next_attempt_at = ? WHERE runner_id = ?", next, runner)
}
