// ABOUTME: Uploads journaled events through the runner channel with retry and backoff.
// ABOUTME: Applies only explicit per-event dispositions; cursors never delete journal rows.

package journal

import (
	"bytes"
	"context"
	"encoding/json"
	"time"

	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

// UploadAction is the runner channel action carrying event batches. E01 owns
// the real ingest endpoint and must preserve disposition-only deletion.
const UploadAction = "events/submit"

// Connection is the narrow authenticated transport boundary the uploader needs.
// *runner.Connection satisfies it; tests supply a scripted fake.
type Connection interface {
	Request(ctx context.Context, method, action string, body []byte) ([]byte, error)
}

// Uploader drains one journal through per-enrollment connections. It keeps no
// delivery state outside the journal tables, so a restart resumes safely.
type Uploader struct {
	Store  *Store
	Lookup func(runnerID string) (Connection, error)
	Now    func() time.Time
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
	return uploaded, pending, nil
}

func (uploader *Uploader) uploadRunner(ctx context.Context, runner, now string) (int, int, error) {
	rows, err := uploader.Store.db.QueryContext(ctx, `SELECT event_id, stream_id, source_sequence, runner_id, execution_id, assignment_generation, provider, kind, provider_session_id, submission_json
FROM hook_journal WHERE runner_id = ? ORDER BY captured_at, rowid LIMIT ?`, runner, maxUploadBatch)
	if err != nil {
		return 0, 0, failure("storage_failed")
	}
	batch := []pendingEvent{}
	for rows.Next() {
		var event pendingEvent
		if err := rows.Scan(&event.eventID, &event.stream, &event.sequence, &event.runner, &event.execution, &event.generation, &event.provider, &event.kind, &event.session, &event.submission); err != nil {
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
		return 0, 0, nil
	}
	connection, err := uploader.Lookup(runner)
	if err != nil {
		// Offline enrollments keep their rows; the next due sweep retries.
		return 0, len(batch), nil
	}
	events := make([]json.RawMessage, 0, len(batch))
	for _, event := range batch {
		events = append(events, json.RawMessage(event.submission))
	}
	body, err := json.Marshal(map[string]any{"schema_version": 1, "events": events})
	if err != nil || len(body) > 1_048_576 {
		return 0, len(batch), failure("storage_failed")
	}
	response, err := connection.Request(ctx, "POST", UploadAction, body)
	if err != nil {
		uploader.recordFailure(ctx, runner, now)
		return 0, len(batch), nil
	}
	dispositions, ok := parseDispositions(response)
	if !ok {
		// A corrupt acknowledgement is a transport fault: no row is deleted or
		// quarantined from an unreadable response.
		uploader.recordFailure(ctx, runner, now)
		return 0, len(batch), nil
	}
	return uploader.applyDispositions(ctx, runner, batch, dispositions, now)
}

func parseDispositions(response []byte) ([]generated.EventDisposition, bool) {
	var envelope struct {
		SchemaVersion int               `json:"schema_version"`
		Dispositions  []json.RawMessage `json:"dispositions"`
	}
	decoder := json.NewDecoder(bytes.NewReader(response))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil || envelope.SchemaVersion != 1 || len(envelope.Dispositions) > 256 {
		return nil, false
	}
	result := make([]generated.EventDisposition, 0, len(envelope.Dispositions))
	for _, item := range envelope.Dispositions {
		if resultOK := protocol.DecodeWireDocument("event-disposition", item); !resultOK.OK {
			return nil, false
		}
		var disposition generated.EventDisposition
		if err := json.Unmarshal(item, &disposition); err != nil {
			return nil, false
		}
		result = append(result, disposition)
	}
	return result, true
}

func (uploader *Uploader) applyDispositions(ctx context.Context, runner string, batch []pendingEvent, dispositions []generated.EventDisposition, now string) (int, int, error) {
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
	if retryable || len(byID) > 0 {
		for _, event := range byID {
			if _, err := tx.ExecContext(ctx, "UPDATE hook_journal SET attempts = attempts + 1 WHERE event_id = ?", event.eventID); err != nil {
				return 0, len(batch), failure("storage_failed")
			}
		}
		if _, err := tx.ExecContext(ctx, "UPDATE hook_source_streams SET next_attempt_at = ? WHERE runner_id = ?", localTimestamp(uploader.now().Add(uploadBackoff(1))), runner); err != nil {
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
