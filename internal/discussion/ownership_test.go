// ABOUTME: Proves single-writer session ownership with fencing across workers and restarts.
// ABOUTME: Wrong, busy, unowned, and revoked sessions fail without advancing delivery state.

package discussion_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/qdis/bfb/internal/discussion"
)

func TestDuplicateWorkersConflict(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "shared.sqlite")
	first, err := discussion.OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := discussion.OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	discussionID, run := uid(1), uid(2)
	if _, err := first.Acquire(ctx, discussionID, 0, run, "fake", checkoutA, "worker-one", nowAt(0)); err != nil {
		t.Fatal(err)
	}
	// The same worker reacquires idempotently.
	if _, err := first.Acquire(ctx, discussionID, 0, run, "fake", checkoutA, "worker-one", nowAt(0)); err != nil {
		t.Fatal(err)
	}
	// A duplicate worker cannot take over, including with a fresh handle.
	if _, err := second.Acquire(ctx, discussionID, 0, run, "fake", checkoutA, "worker-two", nowAt(1)); err == nil || discussion.Code(err) != "ownership_conflict" {
		t.Fatalf("want ownership_conflict, got %v", err)
	}
}

func TestRestartRequiresReconcileThenBumpsFencing(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "restart.sqlite")
	store, err := discussion.OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	discussionID, run := uid(3), uid(4)
	owned, err := store.Acquire(ctx, discussionID, 0, run, "fake", checkoutA, "worker-one", nowAt(0))
	if err != nil {
		t.Fatal(err)
	}
	if owned.Fencing != 1 {
		t.Fatalf("first fencing must be 1, got %d", owned.Fencing)
	}
	_ = store.Close()
	// A new worker after restart cannot acquire directly.
	restarted, err := discussion.OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	if _, err := restarted.Acquire(ctx, discussionID, 0, run, "fake", checkoutA, "worker-two", nowAt(2)); err == nil || discussion.Code(err) != "ownership_conflict" {
		t.Fatalf("want ownership_conflict, got %v", err)
	}
	// With no in-flight attempts, reconcile is immediate and fencing advances.
	report, err := restarted.Reopen(ctx, discussionID, 0, nowAt(3))
	if err != nil || len(report.Retryable) != 0 || len(report.Unknown) != 0 || report.Paused {
		t.Fatalf("clean restart must report nothing, got %+v %v", report, err)
	}
	next, err := restarted.Reacquire(ctx, discussionID, 0, "worker-two", nowAt(4))
	if err != nil {
		t.Fatal(err)
	}
	if next.Fencing != 2 || next.OwnerWorker != "worker-two" {
		t.Fatalf("reacquire must bump fencing, got %+v", next)
	}
	// The crashed worker's generation is stale now.
	if err := restarted.BindSession(ctx, discussionID, 0, "worker-one", 1, "synthetic-session"); err == nil || discussion.Code(err) != "fencing_stale" {
		t.Fatalf("want fencing_stale, got %v", err)
	}
}

func TestSessionBindingIsExactAndImmutable(t *testing.T) {
	ctx := context.Background()
	store := openStore(t)
	discussionID, run := uid(5), uid(6)
	if _, err := store.Acquire(ctx, discussionID, 0, run, "fake", checkoutA, "worker-one", nowAt(0)); err != nil {
		t.Fatal(err)
	}
	if err := store.BindSession(ctx, discussionID, 0, "worker-one", 1, "synthetic-session"); err != nil {
		t.Fatal(err)
	}
	// The same binding is idempotent.
	if err := store.BindSession(ctx, discussionID, 0, "worker-one", 1, "synthetic-session"); err != nil {
		t.Fatal(err)
	}
	// A competing session never rebinds the participant.
	if err := store.BindSession(ctx, discussionID, 0, "worker-one", 1, "other-session"); err == nil || discussion.Code(err) != "session_conflict" {
		t.Fatalf("want session_conflict, got %v", err)
	}
	// Malformed identities fail visibly.
	if err := store.BindSession(ctx, discussionID, 0, "worker-one", 1, "has space"); err == nil || discussion.Code(err) != "session_mismatch" {
		t.Fatalf("want session_mismatch, got %v", err)
	}
	owned, err := store.Owned(ctx, discussionID, 0)
	if err != nil || owned.ObservedSession != "synthetic-session" {
		t.Fatalf("binding must persist, got %+v %v", owned, err)
	}
}

func TestUnownedSlotRejectsWriters(t *testing.T) {
	ctx := context.Background()
	store := openStore(t)
	if _, err := store.CheckWriter(ctx, uid(7), 0, "worker-one", 1); err == nil || discussion.Code(err) != "ownership_required" {
		t.Fatalf("want ownership_required, got %v", err)
	}
}

func TestReleaseRetainsGuardsWhileUnsettled(t *testing.T) {
	ctx := context.Background()
	fixture := setupDiscussion(t, 3)
	request := fixture.request(0, 1, 1, true, "")
	if _, err := fixture.store.RecordAttempt(ctx, request, 1, nowAt(1)); err != nil {
		t.Fatal(err)
	}
	if err := fixture.store.Release(ctx, fixture.discussion, 0, "worker-one", 1, nowAt(2)); err == nil || discussion.Code(err) != "recovery_pending" {
		t.Fatalf("want recovery_pending, got %v", err)
	}
	if err := fixture.store.FailAttempt(ctx, request.DeliveryID, "worker-one", 1, nowAt(3)); err != nil {
		t.Fatal(err)
	}
	if err := fixture.store.Release(ctx, fixture.discussion, 0, "worker-one", 1, nowAt(4)); err != nil {
		t.Fatal(err)
	}
	// A released slot needs reconcile, not a fresh acquire.
	if _, err := fixture.store.Acquire(ctx, fixture.discussion, 0, fixture.run[0], "fake", checkoutA, "worker-one", nowAt(5)); err == nil || discussion.Code(err) != "recovery_pending" {
		t.Fatalf("want recovery_pending, got %v", err)
	}
}

func TestSameCheckoutSerializes(t *testing.T) {
	ctx := context.Background()
	store := openStore(t)
	if err := store.AcquireCheckout(ctx, checkoutA, uid(8), 0, nowAt(0)); err != nil {
		t.Fatal(err)
	}
	// The same holder reacquires idempotently.
	if err := store.AcquireCheckout(ctx, checkoutA, uid(8), 0, nowAt(0)); err != nil {
		t.Fatal(err)
	}
	// A second participant on the same worktree waits.
	if err := store.AcquireCheckout(ctx, checkoutA, uid(9), 1, nowAt(1)); err == nil || discussion.Code(err) != "checkout_occupied" {
		t.Fatalf("want checkout_occupied, got %v", err)
	}
	// A different worktree proceeds concurrently.
	if err := store.AcquireCheckout(ctx, checkoutB, uid(9), 1, nowAt(1)); err != nil {
		t.Fatal(err)
	}
	// Only the holder releases.
	if err := store.ReleaseCheckout(ctx, checkoutA, uid(9), 1); err == nil || discussion.Code(err) != "checkout_occupied" {
		t.Fatalf("want checkout_occupied, got %v", err)
	}
	if err := store.ReleaseCheckout(ctx, checkoutA, uid(8), 0); err != nil {
		t.Fatal(err)
	}
	if err := store.AcquireCheckout(ctx, checkoutA, uid(9), 1, nowAt(2)); err != nil {
		t.Fatal(err)
	}
}
