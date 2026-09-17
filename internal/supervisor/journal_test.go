// ABOUTME: Proves the L06 journal reads immutable L05 assignments without changing supervision.
// ABOUTME: Journals one real hook through the backend to bind the observed session.

package supervisor

import (
	"context"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/journal"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers/fake"
)

func TestJournalBackendReadsImmutableAssignment(t *testing.T) {
	ctx := context.Background()
	store, local, claim, now := fixtureIntents(t)
	assignment := issueFixture(t, store, claim, now)
	backend := JournalBackend{Intents: store}
	var _ journal.Assignments = backend
	var _ journal.Observers = backend

	view, err := backend.ByExecution(ctx, claim.Assignment.RunExecutionId, int64(claim.Assignment.AssignmentGeneration))
	if err != nil {
		t.Fatal(err)
	}
	if view.ExecutionID != claim.Assignment.RunExecutionId || view.Generation != int64(claim.Assignment.AssignmentGeneration) ||
		view.RunnerID != claim.Assignment.RunnerId || view.WorkspaceID != claim.Assignment.WorkspaceId ||
		view.Provider != "fake" || view.Token == "" || view.CreatedAt == "" || view.IntentID != assignment.IntentID {
		t.Fatalf("backend view diverges from the immutable assignment: %+v", view)
	}
	byIntent, err := backend.ByIntent(ctx, assignment.IntentID)
	if err != nil || byIntent != view {
		t.Fatalf("intent view diverges: %+v %v", byIntent, err)
	}
	if _, err := backend.ByExecution(ctx, "01K00000000000000000000099", 1); journal.Code(err) != "unknown_assignment" {
		t.Fatalf("unknown execution resolved: %v", err)
	}
	pending, err := backend.PendingObservations(ctx, 256)
	if err != nil || len(pending) != 0 {
		t.Fatalf("fresh assignment has observations: %v %v", pending, err)
	}

	// One real hook through the production backend binds the observed session
	// without duplicating assignment state in the journal package.
	registry, err := provider.NewRegistry([]provider.Descriptor{fake.Descriptor()})
	if err != nil {
		t.Fatal(err)
	}
	journalStore := journal.NewStore(local.DB)
	captured := now.Add(time.Minute)
	receipt, err := journalStore.Ingest(ctx, backend, registry, journal.HookInput{
		Provider: "fake", Raw: []byte(`{"kind":"session_started","session_id":"sess-l05-backend"}`),
		ExecutionID: claim.Assignment.RunExecutionId, Generation: int64(claim.Assignment.AssignmentGeneration),
		Token: view.Token, CapturedAt: captured,
	}, captured)
	if err != nil || receipt.Status != "accepted" {
		t.Fatalf("backend hook: %+v %v", receipt, err)
	}
	binding, err := journalStore.BoundSession(ctx, claim.Assignment.RunExecutionId, int64(claim.Assignment.AssignmentGeneration))
	if err != nil || binding.SessionID != "sess-l05-backend" || binding.Provider != "fake" {
		t.Fatalf("backend binding: %+v %v", binding, err)
	}
}
