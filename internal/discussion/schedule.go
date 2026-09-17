// ABOUTME: Sequences bounded discussion rounds: independent initials, then ordered challenges.
// ABOUTME: Enforces deadline, stop, and turn bounds before any provider effect may start.

package discussion

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// Schedule is the durable bounded-turn plan for one discussion.
type Schedule struct {
	DiscussionID string
	Rounds       int
	Deadline     string
	Stopped      string
	StopReason   string
	Completed    []int
}

// MaxTurns bounds every discussion the scheduler will conduct.
const MaxTurns = 6

// CreateSchedule freezes the bounded round plan for a discussion. Rounds
// default to three (six participant turns) and never exceed that bound.
func (store *Store) CreateSchedule(ctx context.Context, discussionID string, rounds int, deadline, now string) error {
	if !validIdentity(discussionID) {
		return failure("invalid_request")
	}
	if rounds < 1 || rounds > 3 {
		return failure("invalid_request")
	}
	if _, err := time.Parse(time.RFC3339Nano, deadline); err != nil {
		return failure("invalid_request")
	}
	if _, err := store.db.ExecContext(ctx,
		`INSERT INTO discussion_schedules (discussion_id, rounds, deadline, stopped, stop_reason, completed_ordinals, updated_at)
		 VALUES (?, ?, ?, NULL, NULL, '[]', ?)
		 ON CONFLICT (discussion_id) DO NOTHING`,
		discussionID, rounds, deadline, now); err != nil {
		return failure("storage_failed")
	}
	return nil
}

// ReadSchedule loads the current schedule for a discussion.
func (store *Store) ReadSchedule(ctx context.Context, discussionID string) (Schedule, error) {
	var schedule Schedule
	var stopped, reason sql.NullString
	var completed string
	err := store.db.QueryRowContext(ctx,
		`SELECT discussion_id, rounds, deadline, stopped, stop_reason, completed_ordinals
		 FROM discussion_schedules WHERE discussion_id = ?`, discussionID).Scan(
		&schedule.DiscussionID, &schedule.Rounds, &schedule.Deadline, &stopped, &reason, &completed)
	if errors.Is(err, sql.ErrNoRows) {
		return Schedule{}, failure("schedule_required")
	}
	if err != nil {
		return Schedule{}, failure("storage_failed")
	}
	if stopped.Valid {
		schedule.Stopped = stopped.String
	}
	if reason.Valid {
		schedule.StopReason = reason.String
	}
	if err := json.Unmarshal([]byte(completed), &schedule.Completed); err != nil {
		return Schedule{}, failure("storage_failed")
	}
	return schedule, nil
}

// StopSchedule records a terminal scheduler stop. Cancellation, deadline,
// revocation, and ambiguous delivery all stop; a stopped schedule never
// dispatches another turn.
func (store *Store) StopSchedule(ctx context.Context, discussionID, stopped, reason, now string) error {
	valid := map[string]bool{
		"human_cancelled": true, "deadline_exceeded": true, "context_changed": true,
		"sponsor_revoked": true, "delivery_ambiguous": true, "provider_failed": true,
	}
	if !valid[reason] {
		return failure("invalid_request")
	}
	if _, err := time.Parse(time.RFC3339Nano, stopped); err != nil {
		return failure("invalid_request")
	}
	result, err := store.db.ExecContext(ctx,
		`UPDATE discussion_schedules SET stopped = ?, stop_reason = ?, updated_at = ?
		 WHERE discussion_id = ? AND stopped IS NULL`,
		stopped, reason, now, discussionID)
	if err != nil {
		return failure("storage_failed")
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return failure("storage_failed")
	}
	return nil
}

// MarkCompleted records one finished ordinal. Completion is monotonic: an
// ordinal completes once and never reopens.
func (store *Store) MarkCompleted(ctx context.Context, discussionID string, ordinal int, now string) error {
	schedule, err := store.ReadSchedule(ctx, discussionID)
	if err != nil {
		return err
	}
	for _, done := range schedule.Completed {
		if done == ordinal {
			return failure("invalid_transition")
		}
	}
	schedule.Completed = append(schedule.Completed, ordinal)
	encoded, _ := json.Marshal(schedule.Completed)
	if _, err := store.db.ExecContext(ctx,
		`UPDATE discussion_schedules SET completed_ordinals = ?, updated_at = ? WHERE discussion_id = ?`,
		string(encoded), now, discussionID); err != nil {
		return failure("storage_failed")
	}
	return nil
}

// slotForOrdinal assigns ordinals to roster slots: odd ordinals to slot 0,
// even ordinals to slot 1, so initials are independent and later rounds alternate.
func slotForOrdinal(ordinal int) int { return (ordinal - 1) % 2 }

// RequireTurnReady enforces every scheduler gate before a dispatch: a frozen
// schedule, a live deadline, no stop, a bounded ordinal for this slot, and
// completion of all earlier ordinals (initial positions stay independent).
func (store *Store) RequireTurnReady(ctx context.Context, discussionID string, slot, ordinal int, now string) error {
	schedule, err := store.ReadSchedule(ctx, discussionID)
	if err != nil {
		return err
	}
	moment, err := time.Parse(time.RFC3339Nano, now)
	if err != nil {
		return failure("invalid_request")
	}
	if schedule.Stopped != "" {
		return failure("discussion_stopped")
	}
	deadline, err := time.Parse(time.RFC3339Nano, schedule.Deadline)
	if err != nil {
		return failure("storage_failed")
	}
	if !moment.Before(deadline) {
		_ = store.StopSchedule(ctx, discussionID, now, "deadline_exceeded", now)
		return failure("deadline_exceeded")
	}
	if ordinal < 1 || ordinal > schedule.Rounds*2 || slotForOrdinal(ordinal) != slot {
		return failure("schedule_violation")
	}
	completed := map[int]bool{}
	for _, done := range schedule.Completed {
		completed[done] = true
	}
	if completed[ordinal] {
		return failure("invalid_transition")
	}
	// Ordinals 1 and 2 are independent initial positions. Every later
	// ordinal requires all earlier ordinals to have completed first.
	for earlier := 1; earlier < ordinal; earlier++ {
		if ordinal > 2 && !completed[earlier] {
			return failure("schedule_violation")
		}
	}
	return nil
}
