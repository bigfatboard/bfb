// ABOUTME: Proves durable cleanup wins or loses atomically against launch issuance and native registration.
// ABOUTME: Verifies restart recovery, bounded queue reads and permanent suppression of cleaned-up commands.

package supervisor

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/runner"
)

func TestUnstartedCleanupSurvivesRestartAndCannotReopen(t *testing.T) {
	ctx := context.Background()
	store, local, claim, now := fixtureIntents(t)
	command := acceptFixture(t, store, claim, now)
	if err := store.CompleteUnstarted(ctx, command); err == nil {
		t.Fatal("completion accepted without cleanup barrier")
	}
	cleaning, err := store.BeginUnstartedCleanup(ctx, command)
	if err != nil || cleaning.CleanupLockID == command.ClaimKey || cleaning.CleanupLockID == claim.Specification.LaunchId {
		t.Fatal("cleanup identity not independently pinned", err)
	}
	if _, err = store.Issue(ctx, command, claim, provider.Hash(nil), now); err == nil {
		t.Fatal("stale command issued after cleanup began")
	}
	if err = local.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := daemon.OpenStore(ctx, local.Paths)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	store = NewIntentStore(reopened.DB)
	commands, err := store.Pending(ctx)
	if err != nil || len(commands) != 1 || commands[0] != cleaning {
		t.Fatal("restart lost original pending identity", err)
	}
	again, err := store.BeginUnstartedCleanup(ctx, cleaning)
	if err != nil || again != cleaning {
		t.Fatal("retry replaced cleanup identity", err)
	}
	if err = store.CompleteUnstarted(ctx, cleaning); err != nil {
		t.Fatal(err)
	}
	redelivered := acceptFixture(t, store, claim, now.Add(time.Hour))
	if redelivered.State != "complete" || redelivered.CleanupLockID != cleaning.CleanupLockID || redelivered.ClaimKey != command.ClaimKey {
		t.Fatal("redelivery reopened completed command")
	}
	if err = store.Wait(ctx, redelivered, failure("daemon_offline")); err != nil {
		t.Fatal(err)
	}
	commands, err = store.Pending(ctx)
	if err != nil || len(commands) != 0 {
		t.Fatal("complete command returned to queue", err)
	}
	for _, statement := range []string{
		"UPDATE execution_commands SET cleanup_lock_id = NULL",
		"UPDATE execution_commands SET cleanup_lock_id = '01K00000000000000000000099'",
		"UPDATE execution_commands SET state = 'queued'",
	} {
		if _, err = store.db.Exec(statement); err == nil {
			t.Fatal("database allowed cleanup identity or completion rollback")
		}
	}
}

func TestUnstartedCleanupBlocksLateHelperInEveryUndeliveredState(t *testing.T) {
	for _, state := range []string{"intent_ready", "offered", "delivery_unknown"} {
		t.Run(state, func(t *testing.T) {
			ctx := context.Background()
			store, _, claim, now := fixtureIntents(t)
			assignment := issueFixture(t, store, claim, now)
			command, _ := store.Command(ctx, claim.Assignment.RunnerId, claim.Specification.LaunchId)
			if state != "intent_ready" {
				if _, err := store.Offer(ctx, assignment.IntentID); err != nil {
					t.Fatal(err)
				}
			}
			if state == "delivery_unknown" {
				if err := store.DeliveryUnknown(ctx, assignment.IntentID); err != nil {
					t.Fatal(err)
				}
			}
			cleaning, err := store.BeginUnstartedCleanup(ctx, command)
			if err != nil {
				t.Fatal(err)
			}
			owner := SupervisorIdentity{Process: fixtureProcess(1201, 1, 1201), ExecutableHash: provider.Hash(nil)}
			if _, err = store.Register(ctx, assignment.IntentID, owner, now); err == nil {
				t.Fatal("late helper registered after absence proof")
			}
			if offered, err := store.Offer(ctx, assignment.IntentID); err != nil || offered {
				t.Fatal("cleaned-up intent offered again", err)
			}
			current, err := store.ByCommand(ctx, cleaning)
			if err != nil || current == nil || current.State != "blocked" || current.Supervisor != nil {
				t.Fatal("cleanup did not retain blocked identity", err)
			}
			if err = store.CompleteUnstarted(ctx, cleaning); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestCleanupRacesRegistrationWithoutFalseAbsence(t *testing.T) {
	ctx := context.Background()
	for range 16 {
		store, _, claim, now := fixtureIntents(t)
		assignment := issueFixture(t, store, claim, now)
		command, _ := store.Command(ctx, claim.Assignment.RunnerId, claim.Specification.LaunchId)
		if _, err := store.Offer(ctx, assignment.IntentID); err != nil {
			t.Fatal(err)
		}
		owner := SupervisorIdentity{Process: fixtureProcess(1201, 1, 1201), ExecutableHash: provider.Hash(nil)}
		start := make(chan struct{})
		var cleanupErr, registrationErr error
		var cleaning LocalCommand
		var workers sync.WaitGroup
		workers.Go(func() { <-start; cleaning, cleanupErr = store.BeginUnstartedCleanup(ctx, command) })
		workers.Go(func() { <-start; _, registrationErr = store.Register(ctx, assignment.IntentID, owner, now) })
		close(start)
		workers.Wait()
		if (cleanupErr == nil) == (registrationErr == nil) {
			t.Fatal("cleanup and registration did not have exactly one winner", cleanupErr, registrationErr)
		}
		current, err := store.ByIntent(ctx, assignment.IntentID)
		if err != nil {
			t.Fatal(err)
		}
		if registrationErr == nil {
			if current.Supervisor == nil || current.State != "registered" {
				t.Fatal("cleanup changed registered ownership")
			}
			if _, err = store.BeginUnstartedCleanup(ctx, command); err == nil {
				t.Fatal("registered owner treated as never started")
			}
		} else if current.Supervisor != nil || current.State != "blocked" || store.CompleteUnstarted(ctx, cleaning) != nil {
			t.Fatal("cleanup did not safely suppress registration")
		}
	}
}

func TestCleanupRacesIssuanceWithoutLeavingExecutableIntent(t *testing.T) {
	ctx := context.Background()
	for range 16 {
		store, _, claim, now := fixtureIntents(t)
		command := acceptFixture(t, store, claim, now)
		start := make(chan struct{})
		var cleanupErr error
		var cleaning LocalCommand
		var workers sync.WaitGroup
		workers.Go(func() { <-start; cleaning, cleanupErr = store.BeginUnstartedCleanup(ctx, command) })
		workers.Go(func() { <-start; _, _ = store.Issue(ctx, command, claim, provider.Hash(nil), now) })
		close(start)
		workers.Wait()
		if cleanupErr != nil {
			t.Fatal(cleanupErr)
		}
		assignment, err := store.ByCommand(ctx, cleaning)
		if err != nil || assignment != nil && (assignment.State != "blocked" || assignment.Supervisor != nil) {
			t.Fatal("issuance crossed durable cleanup barrier", err)
		}
		if err = store.CompleteUnstarted(ctx, cleaning); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPendingQueueDoesNotHoldDatabaseCursorOrIncludeControls(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	store, _, claim, now := fixtureIntents(t)
	command := acceptFixture(t, store, claim, now)
	enrollment := runner.Enrollment{RunnerID: command.RunnerID, WorkspaceID: command.WorkspaceID}
	if err := store.Accept(ctx, enrollment, runner.CommandReference{ID: daemon.NewRequestID(), Kind: "run_control", ExpiresAt: command.ExpiresAt}, now); err != nil {
		t.Fatal(err)
	}
	commands, err := store.Pending(ctx)
	if err != nil || len(commands) != 1 || commands[0] != command {
		t.Fatal("incorrect launch queue", err)
	}
	if assignment, err := store.ByCommand(ctx, command); err != nil || assignment != nil {
		t.Fatal("pending read retained single-connection cursor", err)
	}
}
