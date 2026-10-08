// ABOUTME: Builds closed activity and token telemetry while retaining immutable semantic identities.
// ABOUTME: Acknowledgement deletes pending bytes but never forgets the original phase or usage fact.

package journal

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/qdis/bfb/internal/provider"
)

type telemetryIdentity struct {
	session, family, id, phase, fingerprint string
}

func candidateTelemetry(candidate *provider.Candidate, kind string) (map[string]any, telemetryIdentity) {
	identity := telemetryIdentity{session: candidate.SessionID}
	var payload map[string]any
	if candidate.Kind == "usage" && candidate.UsageID != "" {
		identity.family, identity.id, identity.phase = "tokens", candidate.UsageID, "turn_delta"
		var model any
		if candidate.Model != "" {
			model = candidate.Model
		}
		payload = map[string]any{"measurement": "tokens", "usage_id": candidate.UsageID, "basis": candidate.Basis, "model": model, "quality": candidate.Quality, "tokens": map[string]any{
			"input": candidate.InputTokens, "output": candidate.OutputTokens, "cache_read": candidate.CacheReadTokens, "cache_write": candidate.CacheWriteTokens, "reasoning": candidate.ReasoningTokens,
		}}
	} else if candidate.ActivityID != "" && (strings.HasPrefix(kind, "turn_") || strings.HasPrefix(kind, "tool_")) {
		identity.family, identity.id, identity.phase = strings.Split(kind, "_")[0], candidate.ActivityID, "end"
		if strings.HasSuffix(kind, "_started") {
			identity.phase = "start"
		}
		payload = map[string]any{"activity_id": candidate.ActivityID}
		if identity.family == "tool" && candidate.ParentTurnID != "" {
			payload["parent_turn_id"] = candidate.ParentTurnID
		}
	}
	if payload != nil {
		encoded, _ := json.Marshal(map[string]any{"kind": kind, "payload": payload})
		identity.fingerprint = fmt.Sprintf("%x", sha256.Sum256(encoded))
	}
	return payload, identity
}

func lookupTelemetryIdentity(ctx context.Context, tx *sql.Tx, input HookInput, identity telemetryIdentity) (Receipt, bool, error) {
	var fingerprint, eventID string
	err := tx.QueryRowContext(ctx, `SELECT fingerprint, event_id FROM hook_telemetry_identities
WHERE execution_id = ? AND assignment_generation = ? AND provider_session_id = ? AND family = ? AND activity_id = ? AND phase = ?`,
		input.ExecutionID, input.Generation, identity.session, identity.family, identity.id, identity.phase).Scan(&fingerprint, &eventID)
	if err == sql.ErrNoRows {
		return Receipt{}, false, nil
	}
	if err != nil {
		return Receipt{}, false, failure("storage_failed")
	}
	if fingerprint != identity.fingerprint {
		return Receipt{Status: "rejected", Code: "telemetry_identity_conflict"}, true, nil
	}
	return Receipt{Status: "duplicate", EventID: eventID}, true, nil
}

func retainTelemetryIdentity(ctx context.Context, tx *sql.Tx, input HookInput, identity telemetryIdentity, eventID, capturedAt string) error {
	var count int
	if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM hook_telemetry_identities").Scan(&count); err != nil {
		return failure("storage_failed")
	}
	if count >= maxJournalRows {
		return failure("telemetry_degraded")
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO hook_telemetry_identities
(execution_id, assignment_generation, provider_session_id, family, activity_id, phase, fingerprint, event_id, captured_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, input.ExecutionID, input.Generation, identity.session, identity.family, identity.id, identity.phase, identity.fingerprint, eventID, capturedAt)
	if err != nil {
		return failure("storage_failed")
	}
	return nil
}

func telemetrySourceID(input HookInput, identity telemetryIdentity) string {
	encoded, _ := json.Marshal([]any{input.ExecutionID, input.Generation, identity.session, identity.family, identity.id, identity.phase})
	return fmt.Sprintf("telemetry-%x", sha256.Sum256(encoded))
}

// Upload compatibility is recoverable; it never clears or overwrites a
// retention-capacity or corrupt-history fault raised by capture.
func clearUploadDegraded(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `UPDATE hook_journal_meta SET value = CASE key WHEN 'telemetry_degraded' THEN '0' ELSE '' END
WHERE key IN ('telemetry_degraded', 'degraded_reason') AND (SELECT value FROM hook_journal_meta WHERE key = 'degraded_reason') IN ('telemetry_upgrade_required', 'telemetry_unavailable')`)
	if err != nil {
		return failure("storage_failed")
	}
	return nil
}

func setUploadDegraded(ctx context.Context, exec interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}, reason, now string) error {
	_, err := exec.ExecContext(ctx, `UPDATE hook_journal_meta SET value = CASE key WHEN 'telemetry_degraded' THEN '1' WHEN 'degraded_reason' THEN ? ELSE ? END
WHERE key IN ('telemetry_degraded', 'degraded_reason', 'degraded_at') AND (SELECT value FROM hook_journal_meta WHERE key = 'degraded_reason') IN ('', 'telemetry_upgrade_required', 'telemetry_unavailable')`, reason, now)
	if err != nil {
		return failure("storage_failed")
	}
	return nil
}

func (store *Store) captureFailure(ctx context.Context, tx *sql.Tx, err error, now string) error {
	if asCode(err) != "telemetry_degraded" {
		return err
	}
	// Roll back allocated sequence/binding/intent rows before using the pool;
	// the daemon has a single SQLite connection.
	_ = tx.Rollback()
	if err := setDegraded(ctx, store.db, "telemetry_identity_capacity", now); err != nil {
		return err
	}
	return failure("telemetry_degraded")
}
