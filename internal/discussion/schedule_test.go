// ABOUTME: Proves the bounded scheduler: independent initials, ordered challenges, deadline and stop.
// ABOUTME: Out-of-roster, over-bound, and out-of-order turns fail before any provider effect.

package discussion_test

import (
	"context"
	"testing"
	"time"
)

func deadlineAt(hour int) string {
	return time.Date(2026, 9, 17, hour, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)
}

func TestInitialPositionsAreIndependent(t *testing.T) {
	ctx := context.Background()
	store := openStore(t)
	discussionID := uid(10)
	if err := store.CreateSchedule(ctx, discussionID, 3, deadlineAt(13), nowAt(0)); err != nil {
		t.Fatal(err)
	}
	// Either initial may go first.
	if err := store.RequireTurnReady(ctx, discussionID, 1, 2, nowAt(1)); err != nil {
		t.Fatal(err)
	}
	if err := store.RequireTurnReady(ctx, discussionID, 0, 1, nowAt(1)); err != nil {
		t.Fatal(err)
	}
}

func TestChallengesRequireEarlierCompletion(t *testing.T) {
	ctx := context.Background()
	store := openStore(t)
	discussionID := uid(11)
	if err := store.CreateSchedule(ctx, discussionID, 3, deadlineAt(13), nowAt(0)); err != nil {
		t.Fatal(err)
	}
	requireCode(t, store.RequireTurnReady(ctx, discussionID, 0, 3, nowAt(1)), "schedule_violation")
	if err := store.MarkCompleted(ctx, discussionID, 1, nowAt(2)); err != nil {
		t.Fatal(err)
	}
	// One initial is not enough for the first challenge.
	requireCode(t, store.RequireTurnReady(ctx, discussionID, 0, 3, nowAt(3)), "schedule_violation")
	if err := store.MarkCompleted(ctx, discussionID, 2, nowAt(4)); err != nil {
		t.Fatal(err)
	}
	if err := store.RequireTurnReady(ctx, discussionID, 0, 3, nowAt(5)); err != nil {
		t.Fatal(err)
	}
	// Completion never reopens.
	requireCode(t, store.MarkCompleted(ctx, discussionID, 1, nowAt(6)), "invalid_transition")
}

func TestSchedulerBoundsRosterAndTurns(t *testing.T) {
	ctx := context.Background()
	store := openStore(t)
	if err := store.CreateSchedule(ctx, uid(12), 0, deadlineAt(13), nowAt(0)); err == nil {
		t.Fatal("zero rounds must fail")
	}
	if err := store.CreateSchedule(ctx, uid(13), 4, deadlineAt(13), nowAt(0)); err == nil {
		t.Fatal("four rounds must fail")
	}
	discussionID := uid(14)
	if err := store.CreateSchedule(ctx, discussionID, 1, deadlineAt(13), nowAt(0)); err != nil {
		t.Fatal(err)
	}
	// One round allows exactly two turns.
	if err := store.RequireTurnReady(ctx, discussionID, 0, 1, nowAt(1)); err != nil {
		t.Fatal(err)
	}
	requireCode(t, store.RequireTurnReady(ctx, discussionID, 0, 3, nowAt(1)), "schedule_violation")
	// Ordinals belong to their slot.
	requireCode(t, store.RequireTurnReady(ctx, discussionID, 1, 1, nowAt(1)), "schedule_violation")
	// Slot 2 does not exist.
	requireCode(t, store.RequireTurnReady(ctx, discussionID, 2, 1, nowAt(1)), "schedule_violation")
	// No schedule means no turn.
	requireCode(t, store.RequireTurnReady(ctx, uid(15), 0, 1, nowAt(1)), "schedule_required")
}

func TestDeadlineStopsScheduler(t *testing.T) {
	ctx := context.Background()
	store := openStore(t)
	discussionID := uid(16)
	if err := store.CreateSchedule(ctx, discussionID, 3, deadlineAt(13), nowAt(0)); err != nil {
		t.Fatal(err)
	}
	requireCode(t, store.RequireTurnReady(ctx, discussionID, 0, 1, deadlineAt(14)), "deadline_exceeded")
	schedule, err := store.ReadSchedule(ctx, discussionID)
	if err != nil || schedule.StopReason != "deadline_exceeded" {
		t.Fatalf("deadline must stop visibly, got %+v %v", schedule, err)
	}
	requireCode(t, store.RequireTurnReady(ctx, discussionID, 1, 2, deadlineAt(14)), "discussion_stopped")
}
