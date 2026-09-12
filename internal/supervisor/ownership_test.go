// ABOUTME: Verifies that competing native ownership writes cannot replace a previously pinned lock or child.
// ABOUTME: Exercises durable compare-and-pin transactions independently of cloud request availability.

package supervisor

import (
	"context"
	"sync"
	"testing"

	"github.com/qdis/bfb/internal/daemon"
)

func TestOwnershipCompetingPinsHaveOneWinnerAndCannotReplaceGroup(t *testing.T) {
	fixture := finalFixture(t)
	assignment, err := fixture.store.ByIntent(context.Background(), fixture.assignment.TerminalIntentId)
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan string, 16)
	var workers sync.WaitGroup
	for range 16 {
		workers.Go(func() {
			lockID := daemon.NewRequestID()
			if _, err := fixture.store.PinOwnership(context.Background(), assignment.IntentID, *assignment.Supervisor, lockID, nil, fixture.now); err == nil {
				results <- lockID
			}
		})
	}
	workers.Wait()
	close(results)
	if len(results) != 1 {
		t.Fatal("competing lock identities were not single-winner")
	}
	lockID := <-results
	child := ownedGateTestChild(t)
	for range 2 {
		if _, err := fixture.store.PinOwnership(context.Background(), assignment.IntentID, *assignment.Supervisor, lockID, &child, fixture.now); err != nil {
			t.Fatal(err)
		}
	}
	other := ownedGateTestChild(t)
	if _, err := fixture.store.PinOwnership(context.Background(), assignment.IntentID, *assignment.Supervisor, lockID, &other, fixture.now); err == nil {
		t.Fatal("another child replaced the original group")
	}
	if _, err := fixture.store.PinOwnership(context.Background(), assignment.IntentID, *assignment.Supervisor, lockID, nil, fixture.now); err != nil {
		t.Fatal(err)
	}
	stored, err := fixture.store.ByIntent(context.Background(), assignment.IntentID)
	if err != nil || stored.Group == nil || *stored.Group != child || stored.State != "group_ready" || stored.LockID != lockID {
		t.Fatal("authorization retry cleared group ownership", err)
	}
}
