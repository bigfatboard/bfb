// ABOUTME: Proves the deterministic fault matrix: crash windows, duplicate workers, restart, and session authority.
// ABOUTME: Crash before dispatch stays retryable; a possible effect reconciles or pauses without blind replay.

package discussion_test

import (
	"context"
	"errors"
	"testing"

	"github.com/qdis/bfb/internal/discussion"
)

func TestHappyPathTurnCompletes(t *testing.T) {
	ctx := context.Background()
	fixture := setupDiscussion(t, 3)
	fixture.runner.byOrdinal[1] = scriptedTurn{session: "synthetic-session", output: validOutput("first position")}
	if err := discussion.DispatchTurn(ctx, fixture.store, fixture.planner, fixture.authority, fixture.runner, fixture.request(0, 1, 1, true, ""), nil, map[string]bool{}, "sha256:"+"c", nowAt(10)); err != nil {
		t.Fatal(err)
	}
	attempt, err := fixture.store.ReadAttempt(ctx, uid(401))
	if err != nil || attempt.State != "completed" || attempt.SessionID != "synthetic-session" {
		t.Fatalf("attempt must complete with its session, got %+v %v", attempt, err)
	}
	owned, err := fixture.store.Owned(ctx, fixture.discussion, 0)
	if err != nil || owned.ObservedSession != "synthetic-session" {
		t.Fatalf("session must bind once, got %+v %v", owned, err)
	}
	output, err := fixture.store.ReadOutput(ctx, fixture.discussion, 0, 1)
	if err != nil || output.Recommendation != "first position" {
		t.Fatalf("bounded output must persist, got %+v %v", output, err)
	}
	schedule, err := fixture.store.ReadSchedule(ctx, fixture.discussion)
	if err != nil || len(schedule.Completed) != 1 {
		t.Fatalf("scheduler must advance, got %+v %v", schedule, err)
	}
	// The checkout releases after the turn.
	if err := fixture.store.AcquireCheckout(ctx, checkoutA, fixture.discussion, 1, nowAt(11)); err != nil {
		t.Fatal(err)
	}
	// A duplicate dispatch of the finished turn fails instead of duplicating.
	requireCode(t, discussion.DispatchTurn(ctx, fixture.store, fixture.planner, fixture.authority, fixture.runner, fixture.request(0, 1, 1, true, ""), nil, map[string]bool{}, "sha256:"+"c", nowAt(12)), "invalid_transition")
}

func TestCrashBeforeDispatchIsRetryable(t *testing.T) {
	ctx := context.Background()
	fixture := setupDiscussion(t, 3)
	// The provider effect never starts: crash before dispatch.
	fixture.runner.byOrdinal[1] = scriptedTurn{err: errors.New("process lost before spawn")}
	requireCode(t, discussion.DispatchTurn(ctx, fixture.store, fixture.planner, fixture.authority, fixture.runner, fixture.request(0, 1, 1, true, ""), nil, map[string]bool{}, "sha256:"+"c", nowAt(10)), "dispatch_failed")
	report, err := fixture.store.Reopen(ctx, fixture.discussion, 0, nowAt(11))
	if err != nil || len(report.Retryable) != 1 || len(report.Unknown) != 0 || report.Paused {
		t.Fatalf("crash before dispatch must stay retryable, got %+v %v", report, err)
	}
	// Retry under the same idempotency key completes exactly once.
	fixture.runner.byOrdinal[1] = scriptedTurn{session: "synthetic-session", output: validOutput("retried position")}
	if err := discussion.DispatchTurn(ctx, fixture.store, fixture.planner, fixture.authority, fixture.runner, fixture.request(0, 1, 1, true, ""), nil, map[string]bool{}, "sha256:"+"c", nowAt(12)); err != nil {
		t.Fatal(err)
	}
	if calls := len(fixture.runner.calls); calls != 2 {
		t.Fatalf("exactly one retry may run, got %d calls", calls)
	}
}

func TestCrashAfterPossibleEffectPausesUntilReconciled(t *testing.T) {
	ctx := context.Background()
	fixture := setupDiscussion(t, 3)
	// The effect may exist but its acknowledgement is lost.
	fixture.runner.byOrdinal[1] = scriptedTurn{err: errors.New("supervisor lost after spawn"), effect: true}
	requireCode(t, discussion.DispatchTurn(ctx, fixture.store, fixture.planner, fixture.authority, fixture.runner, fixture.request(0, 1, 1, true, ""), nil, map[string]bool{}, "sha256:"+"c", nowAt(10)), "delivery_unknown")
	report, err := fixture.store.Reopen(ctx, fixture.discussion, 0, nowAt(11))
	if err != nil || len(report.Unknown) != 1 || !report.Paused {
		t.Fatalf("possible effect must pause, got %+v %v", report, err)
	}
	// A blind retry is refused while the effect is uncertain.
	fixture.runner.byOrdinal[1] = scriptedTurn{session: "synthetic-session", output: validOutput("duplicate")}
	requireCode(t, discussion.DispatchTurn(ctx, fixture.store, fixture.planner, fixture.authority, fixture.runner, fixture.request(0, 1, 1, true, ""), nil, map[string]bool{}, "sha256:"+"c", nowAt(12)), "discussion_stopped")
	// A fresh worker reconciles only after taking fencing from a clean Reopen state.
	next, err := fixture.store.Reacquire(ctx, fixture.discussion, 0, "worker-two", nowAt(13))
	if err != nil || next.Fencing != 2 {
		t.Fatalf("reacquire must advance fencing, got %+v %v", next, err)
	}
	// The crashed generation stays stale.
	requireCode(t, fixture.store.MarkEffectStarted(ctx, uid(401), "worker-one", 1, nowAt(14)), "fencing_stale")
	// Provider facts prove the effect: confirm once, then finish without duplication.
	if err := fixture.store.ConfirmUnknown(ctx, uid(401), "worker-two", 2, "synthetic-session", nowAt(15)); err != nil {
		t.Fatal(err)
	}
	requireCode(t, fixture.store.ConfirmUnknown(ctx, uid(401), "worker-two", 2, "synthetic-session", nowAt(16)), "invalid_transition")
	if err := fixture.store.StoreOutput(ctx, fixture.discussion, 0, 1, uid(401), mustValidate(t, validOutput("reconciled position"), "sha256:"+"c"), nowAt(17)); err != nil {
		t.Fatal(err)
	}
	if err := fixture.store.CompleteAttempt(ctx, uid(401), "worker-two", 2, nowAt(18)); err != nil {
		t.Fatal(err)
	}
	if err := fixture.store.MarkCompleted(ctx, fixture.discussion, 1, nowAt(19)); err != nil {
		t.Fatal(err)
	}
}

func TestUnprovableEffectPausesVisibly(t *testing.T) {
	ctx := context.Background()
	fixture := setupDiscussion(t, 3)
	fixture.runner.byOrdinal[1] = scriptedTurn{err: errors.New("supervisor lost after spawn"), effect: true}
	requireCode(t, discussion.DispatchTurn(ctx, fixture.store, fixture.planner, fixture.authority, fixture.runner, fixture.request(0, 1, 1, true, ""), nil, map[string]bool{}, "sha256:"+"c", nowAt(10)), "delivery_unknown")
	if _, err := fixture.store.Reopen(ctx, fixture.discussion, 0, nowAt(11)); err != nil {
		t.Fatal(err)
	}
	next, err := fixture.store.Reacquire(ctx, fixture.discussion, 0, "worker-two", nowAt(12))
	if err != nil || next.Fencing != 2 {
		t.Fatalf("reacquire must advance fencing, got %+v %v", next, err)
	}
	// No provider fact proves the outcome: pause visibly, never resend.
	if err := fixture.store.MarkAmbiguous(ctx, uid(401), "worker-two", 2, nowAt(13)); err != nil {
		t.Fatal(err)
	}
	attempt, err := fixture.store.ReadAttempt(ctx, uid(401))
	if err != nil || attempt.State != "ambiguous" {
		t.Fatalf("delivery must stay ambiguous, got %+v %v", attempt, err)
	}
	schedule, err := fixture.store.ReadSchedule(ctx, fixture.discussion)
	if err != nil || schedule.StopReason != "delivery_ambiguous" {
		t.Fatalf("scheduler must name ambiguity, got %+v %v", schedule, err)
	}
	requireCode(t, discussion.DispatchTurn(ctx, fixture.store, fixture.planner, fixture.authority, fixture.runner, fixture.request(0, 1, 2, true, ""), nil, map[string]bool{}, "sha256:"+"c", nowAt(14)), "discussion_stopped")
	// Uncertainty retains guards: ownership cannot release.
	requireCode(t, fixture.store.Release(ctx, fixture.discussion, 0, "worker-two", 2, nowAt(15)), "recovery_pending")
}

func TestDuplicateWorkerCannotDispatch(t *testing.T) {
	ctx := context.Background()
	fixture := setupDiscussion(t, 3)
	fixture.runner.byOrdinal[1] = scriptedTurn{session: "synthetic-session", output: validOutput("first")}
	shadow := fixture.request(0, 1, 1, true, "")
	shadow.Worker = "worker-two"
	requireCode(t, discussion.DispatchTurn(ctx, fixture.store, fixture.planner, fixture.authority, fixture.runner, shadow, nil, map[string]bool{}, "sha256:"+"c", nowAt(10)), "fencing_stale")
	if len(fixture.runner.calls) != 0 {
		t.Fatal("a duplicate worker must never reach the provider")
	}
}

func TestSessionAuthorityMatrix(t *testing.T) {
	ctx := context.Background()
	fixture := setupDiscussion(t, 3)
	fixture.runner.byOrdinal[1] = scriptedTurn{session: "synthetic-session", output: validOutput("first")}
	fixture.runner.byOrdinal[2] = scriptedTurn{session: "synthetic-session", output: validOutput("second")}
	if err := discussion.DispatchTurn(ctx, fixture.store, fixture.planner, fixture.authority, fixture.runner, fixture.request(0, 1, 1, true, ""), nil, map[string]bool{}, "sha256:"+"c", nowAt(10)); err != nil {
		t.Fatal(err)
	}
	// Wrong session: slot 0 continues with an identity it never bound.
	if err := fixture.store.MarkCompleted(ctx, fixture.discussion, 2, nowAt(11)); err != nil {
		t.Fatal(err)
	}
	wrong := fixture.request(0, 3, 3, false, "other-session")
	requireCode(t, discussion.DispatchTurn(ctx, fixture.store, fixture.planner, fixture.authority, fixture.runner, wrong, nil, map[string]bool{}, "sha256:"+"c", nowAt(12)), "session_mismatch")
	// Busy session: slot 1 cannot acknowledge the session slot 0 owns.
	if _, err := fixture.store.RecordAttempt(ctx, fixture.request(1, 2, 2, false, "synthetic-session"), 1, nowAt(13)); err != nil {
		t.Fatal(err)
	}
	if err := fixture.store.MarkEffectStarted(ctx, uid(402), "worker-one", 1, nowAt(14)); err != nil {
		t.Fatal(err)
	}
	requireCode(t, fixture.store.Acknowledge(ctx, uid(402), "worker-one", 1, "synthetic-session", nowAt(15)), "session_busy")
	// Unowned slot: a schedule without ownership means no turn.
	ghostID := uid(700)
	if err := fixture.store.CreateSchedule(ctx, ghostID, 3, "2026-09-17T13:00:00Z", nowAt(15)); err != nil {
		t.Fatal(err)
	}
	ghost := fixture.request(0, 1, 9, true, "")
	ghost.DiscussionID = ghostID
	ghost.RunID = uid(701)
	ghost.ExecutionID = uid(702)
	requireCode(t, discussion.DispatchTurn(ctx, fixture.store, fixture.planner, fixture.authority, fixture.runner, ghost, nil, map[string]bool{}, "sha256:"+"c", nowAt(16)), "ownership_required")
	// Revoked authority prevents new turns and terminates owned work safely.
	fixture.authority.revoked[fixture.discussion] = true
	requireCode(t, discussion.DispatchTurn(ctx, fixture.store, fixture.planner, fixture.authority, fixture.runner, fixture.request(1, 2, 3, true, ""), nil, map[string]bool{}, "sha256:"+"c", nowAt(16)), "revoked")
}

func TestCancellationDeadlineAndRevocation(t *testing.T) {
	ctx := context.Background()
	fixture := setupDiscussion(t, 3)
	if err := discussion.CancelDiscussion(ctx, fixture.store, fixture.authority, fixture.discussion, "worker-one", 1, "human_cancelled", nowAt(10)); err != nil {
		t.Fatal(err)
	}
	fixture.runner.byOrdinal[1] = scriptedTurn{session: "synthetic-session", output: validOutput("late")}
	requireCode(t, discussion.DispatchTurn(ctx, fixture.store, fixture.planner, fixture.authority, fixture.runner, fixture.request(0, 1, 1, true, ""), nil, map[string]bool{}, "sha256:"+"c", nowAt(11)), "discussion_stopped")
	if len(fixture.runner.calls) != 0 {
		t.Fatal("cancellation must prevent the provider effect")
	}
	schedule, err := fixture.store.ReadSchedule(ctx, fixture.discussion)
	if err != nil || schedule.StopReason != "human_cancelled" {
		t.Fatalf("cancel must record its reason, got %+v %v", schedule, err)
	}
}

func TestMalformedAndOversizedOutputsFailVisibly(t *testing.T) {
	ctx := context.Background()
	fixture := setupDiscussion(t, 3)
	fixture.runner.byOrdinal[1] = scriptedTurn{session: "synthetic-session", output: []byte("{not json")}
	requireCode(t, discussion.DispatchTurn(ctx, fixture.store, fixture.planner, fixture.authority, fixture.runner, fixture.request(0, 1, 1, true, ""), nil, map[string]bool{}, "sha256:"+"c", nowAt(10)), "output_malformed")
	big := make([]byte, 9000)
	for i := range big {
		big[i] = 'x'
	}
	bigFixture := setupDiscussion(t, 3)
	bigFixture.runner.byOrdinal[1] = scriptedTurn{session: "synthetic-session", output: big}
	requireCode(t, discussion.DispatchTurn(ctx, bigFixture.store, bigFixture.planner, bigFixture.authority, bigFixture.runner, bigFixture.request(0, 1, 1, true, ""), nil, map[string]bool{}, "sha256:"+"c", nowAt(10)), "output_bound_exceeded")
	for _, owned := range []struct {
		store      *discussion.Store
		discussion string
	}{{fixture.store, fixture.discussion}, {bigFixture.store, bigFixture.discussion}} {
		schedule, err := owned.store.ReadSchedule(ctx, owned.discussion)
		if err != nil || schedule.StopReason != "provider_failed" {
			t.Fatalf("bad output must stop visibly, got %+v %v", schedule, err)
		}
	}
	// Missing identity fails before any acknowledgement.
	missing := setupDiscussion(t, 3)
	missing.runner.byOrdinal[1] = scriptedTurn{output: validOutput("no session")}
	requireCode(t, discussion.DispatchTurn(ctx, missing.store, missing.planner, missing.authority, missing.runner, missing.request(0, 1, 1, true, ""), nil, map[string]bool{}, "sha256:"+"c", nowAt(10)), "session_mismatch")
}

func TestUnsupportedProviderFailsClosed(t *testing.T) {
	ctx := context.Background()
	fixture := setupDiscussion(t, 3)
	request := fixture.request(0, 1, 1, true, "")
	request.Provider = "grok"
	requireCode(t, discussion.DispatchTurn(ctx, fixture.store, fixture.planner, fixture.authority, fixture.runner, request, nil, map[string]bool{}, "sha256:"+"c", nowAt(10)), "provider_unsupported")
}

func mustValidate(t *testing.T, raw []byte, revision string) discussion.Recommendation {
	t.Helper()
	output, err := discussion.ValidateRecommendation(raw, nil, map[string]bool{}, revision)
	if err != nil {
		t.Fatal(err)
	}
	return output
}
