// ABOUTME: Proves restart recovery end to end: reopen, fencing advance, reconcile, and retained guards.
// ABOUTME: A restarted worker never replays an uncertain effect and never inherits a live lock silently.

package discussion_test

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/qdis/bfb/internal/discussion"
)

func TestRestartMidTurnReconcilesWithoutDuplication(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "crash.sqlite")
	store, err := discussion.OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	discussionID, run := uid(910), uid(911)
	deadline := "2026-09-17T13:00:00Z"
	if err := store.CreateSchedule(ctx, discussionID, 3, deadline, nowAt(0)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Acquire(ctx, discussionID, 0, run, "fake", checkoutA, "worker-one", nowAt(0)); err != nil {
		t.Fatal(err)
	}
	authority := newAuthority()
	runner := &fakeRunner{byOrdinal: map[int]scriptedTurn{}}
	workdir := t.TempDir()
	planner := kitPlanner(t, workdir)
	request := discussion.TurnRequest{
		DiscussionID: discussionID, TurnID: uid(912), DeliveryID: uid(913),
		Slot: 0, Ordinal: 1, Provider: "fake", WorkingDir: workdir,
		RunID: run, ExecutionID: uid(914), Generation: 1, Fresh: true,
		ExternalContext: []byte(`{"brief":"synthetic","peer":[]}`),
		Worker:          "worker-one", Fencing: 1, IdempotencyKey: uid(915),
	}
	runner.byOrdinal[1] = scriptedTurn{err: errors.New("kernel panic mid-turn"), effect: true}
	requireCode(t, discussion.DispatchTurn(ctx, store, planner, authority, runner, request, nil, map[string]bool{}, "sha256:"+"c", nowAt(10)), "delivery_unknown")
	// The process dies with the attempt in flight.
	_ = store.Close()
	reopened, err := discussion.OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	report, err := reopened.Reopen(ctx, discussionID, 0, nowAt(11))
	if err != nil || len(report.Unknown) != 1 || !report.Paused {
		t.Fatalf("restart must surface one unknown paused attempt, got %+v %v", report, err)
	}
	// A second reopen is stable: unknown attempts stay unknown until an
	// explicit reconcile step resolves them.
	second, err := reopened.Reopen(ctx, discussionID, 0, nowAt(12))
	if err != nil || len(second.Unknown) != 0 || len(second.Ambiguous) != 0 {
		t.Fatalf("reopen must be stable once unknown, got %+v %v", second, err)
	}
	next, err := reopened.Reacquire(ctx, discussionID, 0, "worker-two", nowAt(13))
	if err != nil || next.Fencing != 2 {
		t.Fatalf("reacquire must advance fencing, got %+v %v", next, err)
	}
	// Provider evidence arrives late (a SessionStart observed by the journal):
	// confirm exactly once, store the bounded output, and finish the ordinal.
	if err := reopened.ConfirmUnknown(ctx, uid(913), "worker-two", 2, "synthetic-session", nowAt(14)); err != nil {
		t.Fatal(err)
	}
	output, err := discussion.ValidateRecommendation(validOutput("late proof"), nil, map[string]bool{}, "sha256:"+"c")
	if err != nil {
		t.Fatal(err)
	}
	if err := reopened.StoreOutput(ctx, discussionID, 0, 1, uid(913), output, nowAt(15)); err != nil {
		t.Fatal(err)
	}
	if err := reopened.CompleteAttempt(ctx, uid(913), "worker-two", 2, nowAt(16)); err != nil {
		t.Fatal(err)
	}
	if err := reopened.MarkCompleted(ctx, discussionID, 1, nowAt(17)); err != nil {
		t.Fatal(err)
	}
	// The crashed worker cannot write after fencing advanced.
	requireCode(t, reopened.FailAttempt(ctx, uid(913), "worker-one", 1, nowAt(18)), "fencing_stale")
}
