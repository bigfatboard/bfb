// ABOUTME: Reconciles persisted delivery facts after a crash without blind redispatch.
// ABOUTME: Recorded attempts stay retryable; possible effects become unknown and pause the owner.

package discussion

import (
	"context"
	"time"
)

// RecoveryReport distinguishes the two crash windows for one participant:
// attempts that never reached an effect stay retryable, while attempts with
// a possible provider effect become unknown and pause ownership.
type RecoveryReport struct {
	DiscussionID string
	Slot         int
	Retryable    []Attempt
	Unknown      []Attempt
	Ambiguous    []Attempt
	Paused       bool
}

// Reopen reconciles one participant after a restart. It never resends: an
// unacknowledged external effect reconciles through Acknowledge once provider
// facts prove it, or pauses visibly through MarkAmbiguous when they cannot.
func (store *Store) Reopen(ctx context.Context, discussionID string, slot int, now string) (RecoveryReport, error) {
	report := RecoveryReport{DiscussionID: discussionID, Slot: slot}
	if !validIdentity(discussionID) || (slot != 0 && slot != 1) {
		return report, failure("invalid_request")
	}
	if _, err := time.Parse(time.RFC3339Nano, now); err != nil {
		return report, failure("invalid_request")
	}
	rows, err := store.db.QueryContext(ctx,
		`SELECT attempt_id FROM discussion_attempts
		 WHERE discussion_id = ? AND slot = ? AND state IN ('recorded', 'effect_started', 'acknowledged', 'ambiguous')
		 ORDER BY ordinal`,
		discussionID, slot)
	if err != nil {
		return report, failure("storage_failed")
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return report, failure("storage_failed")
		}
		ids = append(ids, id)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return report, failure("storage_failed")
	}
	for _, id := range ids {
		attempt, err := store.ReadAttempt(ctx, id)
		if err != nil {
			return report, err
		}
		switch attempt.State {
		case "recorded":
			// Crash before dispatch left no possible effect: retryable as-is.
			report.Retryable = append(report.Retryable, attempt)
		case "ambiguous":
			report.Ambiguous = append(report.Ambiguous, attempt)
		default:
			// Crash after a possible provider effect: retain guards first.
			if err := store.MarkUnknown(ctx, id, now); err != nil {
				return report, err
			}
			unknown, err := store.ReadAttempt(ctx, id)
			if err != nil {
				return report, err
			}
			report.Unknown = append(report.Unknown, unknown)
		}
	}
	if len(report.Unknown) != 0 || len(report.Ambiguous) != 0 {
		if _, err := store.db.ExecContext(ctx,
			`UPDATE discussion_ownership SET state = 'paused', revision = revision + 1, updated_at = ?
			 WHERE discussion_id = ? AND slot = ? AND state = 'owned'`,
			now, discussionID, slot); err != nil {
			return report, failure("storage_failed")
		}
		report.Paused = true
	}
	return report, nil
}
