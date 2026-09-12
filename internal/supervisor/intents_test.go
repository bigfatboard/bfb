// ABOUTME: Proves durable launch-intent deduplication, scope binding and immutable supervisor registration.
// ABOUTME: Exercises real SQLite transactions with synthetic C09 claims and no Terminal side effects.

package supervisor

import (
	"context"
	"encoding/json"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/runner"
)

func fixtureIntents(t *testing.T) (*IntentStore, *daemon.Store, generated.LaunchClaimResult, time.Time) {
	t.Helper()
	root, err := os.MkdirTemp("/tmp", "bfb-intents-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	paths, err := daemon.StatePaths(root)
	if err != nil || paths.Prepare() != nil {
		t.Fatal("private fixture paths unavailable", err)
	}
	local, err := daemon.OpenStore(context.Background(), paths)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = local.Close() })
	repository, err := protocol.RepositoryRoot()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(protocol.FixturePath(repository, "valid/launch-claim-result.c09-synthetic.json"))
	if err != nil {
		t.Fatal(err)
	}
	var claim generated.LaunchClaimResult
	if err = json.Unmarshal(data, &claim); err != nil {
		t.Fatal(err)
	}
	// Independently computed with the owning C09 launchHash implementation.
	claim.Specification.ConfigSnapshotHash = "sha256:b8bb44429b23a19fa2e772020d1741738332e954a0eed297a06ac56a2dbcf480"
	now, _ := time.Parse(time.RFC3339Nano, "2026-09-12T12:00:03Z")
	return NewIntentStore(local.DB), local, claim, now
}

func acceptFixture(t *testing.T, store *IntentStore, claim generated.LaunchClaimResult, now time.Time) LocalCommand {
	t.Helper()
	enrollment := runner.Enrollment{RunnerID: claim.Assignment.RunnerId, WorkspaceID: claim.Assignment.WorkspaceId, State: "online"}
	reference := runner.CommandReference{ID: claim.Specification.LaunchId, Kind: "launch", ExpiresAt: claim.Specification.ExpiresAt}
	if err := store.Accept(context.Background(), enrollment, reference, now); err != nil {
		t.Fatal(err)
	}
	command, err := store.Command(context.Background(), enrollment.RunnerID, reference.ID)
	if err != nil {
		t.Fatal(err)
	}
	return command
}

func issueFixture(t *testing.T, store *IntentStore, claim generated.LaunchClaimResult, now time.Time) LocalAssignment {
	t.Helper()
	command := acceptFixture(t, store, claim, now)
	assignment, err := store.Issue(context.Background(), command, claim, provider.Hash(nil), now)
	if err != nil {
		t.Fatal(err)
	}
	return assignment
}

func TestClaimSnapshotHashMatchesCloudAndRejectsConfusedBindings(t *testing.T) {
	_, _, original, _ := fixtureIntents(t)
	computed, err := snapshotHash(original.Snapshot)
	if err != nil || computed != original.Specification.ConfigSnapshotHash {
		t.Fatal("Go snapshot hash differs from C09", err)
	}
	if err = validateClaim(original, original.Assignment.WorkspaceId, original.Assignment.RunnerId, original.Specification.LaunchId, original.Specification.ExpiresAt); err != nil {
		t.Fatal(err)
	}
	for _, fault := range []string{"workspace", "runner", "launch", "expiry", "snapshot_hash", "config", "generation", "run", "task", "project", "checkout", "profile", "ended", "extended_deadline", "added_shell_field"} {
		t.Run(fault, func(t *testing.T) {
			data, _ := json.Marshal(original)
			var claim generated.LaunchClaimResult
			_ = json.Unmarshal(data, &claim)
			spec, assignment, snapshot := &claim.Specification, &claim.Assignment, &claim.Snapshot
			other := "01K00000000000000000000099"
			switch fault {
			case "workspace":
				assignment.WorkspaceId = other
			case "runner":
				assignment.RunnerId = other
			case "launch":
				spec.LaunchId = other
			case "expiry":
				spec.ExpiresAt = "2026-09-12T12:01:59Z"
			case "snapshot_hash":
				spec.ConfigSnapshotHash = provider.Hash(nil)
			case "config":
				spec.ExecutionConfig.FilesystemPolicy = "workspace_write"
			case "generation":
				assignment.AssignmentGeneration++
			case "run":
				assignment.RunId = other
			case "task":
				assignment.TaskId = other
			case "project":
				assignment.ProjectId = other
			case "checkout":
				assignment.CheckoutId = other
			case "profile":
				snapshot.AgentProfileId = other
			case "ended":
				ended := "2026-09-12T12:00:01Z"
				assignment.EndedAt = &ended
			case "extended_deadline":
				assignment.CreatedAt = "2026-09-12T11:59:59Z"
			case "added_shell_field":
				snapshot.WorkspacePolicy["shell"] = "forbidden"
			}
			if validateClaim(claim, original.Assignment.WorkspaceId, original.Assignment.RunnerId, original.Specification.LaunchId, original.Specification.ExpiresAt) == nil {
				t.Fatal("inconsistent launch reached local intent issuance")
			}
		})
	}
}

func TestCommandAcceptanceKeepsOriginalClaimKeyAndBinding(t *testing.T) {
	store, _, claim, now := fixtureIntents(t)
	command := acceptFixture(t, store, claim, now)
	again := acceptFixture(t, store, claim, now.Add(time.Second))
	if command != again || command.ClaimKey == "" || command.ClaimStartedAt != localTimestamp(now) {
		t.Fatal("duplicate delivery changed the durable claim")
	}
	for _, fault := range []string{"workspace", "kind", "expiry"} {
		enrollment := runner.Enrollment{RunnerID: command.RunnerID, WorkspaceID: command.WorkspaceID}
		reference := runner.CommandReference{ID: command.ID, Kind: command.Kind, ExpiresAt: command.ExpiresAt}
		switch fault {
		case "workspace":
			enrollment.WorkspaceID = daemon.NewRequestID()
		case "kind":
			reference.Kind = "run_control"
		case "expiry":
			reference.ExpiresAt = "2026-09-12T12:02:01Z"
		}
		assertFailure(t, store.Accept(context.Background(), enrollment, reference, now), "execution_assignment_invalid")
	}
	wrong := command
	wrong.ClaimKey = daemon.NewRequestID()
	_, err := store.Issue(context.Background(), wrong, claim, provider.Hash(nil), now)
	assertFailure(t, err, "execution_assignment_invalid")
}

func TestConcurrentIssueAndOfferUseOneIntent(t *testing.T) {
	store, _, claim, now := fixtureIntents(t)
	command := acceptFixture(t, store, claim, now)
	const deliveries = 16
	results := make(chan LocalAssignment, deliveries)
	var workers sync.WaitGroup
	for range deliveries {
		workers.Go(func() {
			assignment, err := store.Issue(context.Background(), command, claim, provider.Hash(nil), now)
			if err != nil {
				t.Error(err)
				return
			}
			results <- assignment
		})
	}
	workers.Wait()
	close(results)
	if len(results) != deliveries {
		t.Fatal("issue results missing")
	}
	first := <-results
	for assignment := range results {
		if assignment.IntentID != first.IntentID || assignment.CorrelationToken != first.CorrelationToken {
			t.Fatal("duplicate claim minted another intent or correlation capability")
		}
	}
	winners := make(chan bool, deliveries)
	for range deliveries {
		workers.Go(func() {
			won, err := store.Offer(context.Background(), first.IntentID)
			if err != nil {
				t.Error(err)
			}
			if won {
				winners <- true
			}
		})
	}
	workers.Wait()
	if len(winners) != 1 {
		t.Fatal("Terminal open was not single-use")
	}
	if err := store.DeliveryUnknown(context.Background(), first.IntentID); err != nil {
		t.Fatal(err)
	}
	if won, err := store.Offer(context.Background(), first.IntentID); err != nil || won {
		t.Fatal("ambiguous delivery opened Terminal again", err)
	}
	var count int
	if err := store.db.QueryRow("SELECT count(*) FROM local_execution_assignments").Scan(&count); err != nil || count != 1 {
		t.Fatal("duplicate local assignment", err)
	}
}

func TestSupervisorRegistrationReconcilesOnlyTheSameProcess(t *testing.T) {
	store, local, claim, now := fixtureIntents(t)
	assignment := issueFixture(t, store, claim, now)
	identity := SupervisorIdentity{Process: fixtureProcess(1201, 1, 1201), ExecutableHash: provider.Hash(nil)}
	_, err := store.Register(context.Background(), assignment.IntentID, identity, now)
	assertFailure(t, err, "execution_intent_consumed")
	if won, err := store.Offer(context.Background(), assignment.IntentID); err != nil || !won {
		t.Fatal(err)
	}
	if err = store.DeliveryUnknown(context.Background(), assignment.IntentID); err != nil {
		t.Fatal(err)
	}
	registered, err := store.Register(context.Background(), assignment.IntentID, identity, now)
	if err != nil || registered.Supervisor == nil || *registered.Supervisor != identity || registered.State != "registered" {
		t.Fatal("native identity was not persisted before returning assignment", err)
	}
	if err = store.DeliveryUnknown(context.Background(), assignment.IntentID); err != nil {
		t.Fatal(err)
	}
	if err = local.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := daemon.OpenStore(context.Background(), local.Paths)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	store = NewIntentStore(restarted.DB)
	again, err := store.Register(context.Background(), assignment.IntentID, identity, now.Add(time.Second))
	if err != nil || again.State != "registered" || again.CorrelationToken != assignment.CorrelationToken || *again.Supervisor != identity {
		t.Fatal("same-process lost-response reconciliation failed", err)
	}
	for _, fault := range []string{"pid", "start", "executable", "uid"} {
		changed := identity
		switch fault {
		case "pid":
			changed.Process.PID++
		case "start":
			changed.Process.StartIdentity = "2000:1"
		case "executable":
			changed.ExecutableHash = provider.Hash([]byte("different executable"))
		case "uid":
			changed.Process.UID++
		}
		if _, err = store.Register(context.Background(), assignment.IntentID, changed, now); err == nil {
			t.Fatal("different supervisor took over consumed intent")
		}
	}
}

func TestCompetingHelpersHaveOneRegisteredSupervisor(t *testing.T) {
	store, _, claim, now := fixtureIntents(t)
	assignment := issueFixture(t, store, claim, now)
	if _, err := store.Offer(context.Background(), assignment.IntentID); err != nil {
		t.Fatal(err)
	}
	winners := make(chan LocalAssignment, 12)
	var workers sync.WaitGroup
	for index := range 12 {
		workers.Go(func() {
			identity := SupervisorIdentity{Process: fixtureProcess(1201+index, 1, 1201+index), ExecutableHash: provider.Hash(nil)}
			registered, err := store.Register(context.Background(), assignment.IntentID, identity, now)
			if err == nil {
				winners <- registered
			} else if daemon.AsFailure(err).Code != "execution_intent_consumed" {
				t.Error(err)
			}
		})
	}
	workers.Wait()
	if len(winners) != 1 {
		t.Fatal("competing helpers did not have exactly one winner")
	}
}

func TestExpiredIntentAndImmutableHistory(t *testing.T) {
	store, _, claim, now := fixtureIntents(t)
	assignment := issueFixture(t, store, claim, now)
	if _, err := store.Offer(context.Background(), assignment.IntentID); err != nil {
		t.Fatal(err)
	}
	identity := SupervisorIdentity{Process: fixtureProcess(1201, 1, 1201), ExecutableHash: provider.Hash(nil)}
	deadline, _ := time.Parse(time.RFC3339Nano, claim.Specification.ExpiresAt)
	_, err := store.Register(context.Background(), assignment.IntentID, identity, deadline)
	assertFailure(t, err, "expired_intent")
	_, err = store.Issue(context.Background(), acceptFixture(t, store, claim, now), claim, provider.Hash(nil), deadline)
	assertFailure(t, err, "expired_intent")
	_, err = store.Register(context.Background(), claim.Specification.LaunchId, identity, now)
	assertFailure(t, err, "peer_denied")
	for _, column := range []string{"execution_id", "assignment_generation", "workspace_id", "project_id", "task_id", "run_id", "runner_id", "checkout_id", "launch_id", "intent_id", "physical_worktree_hash", "fencing_generation", "provider_identity_hash", "correlation_token", "created_at", "expires_at"} {
		if _, err = store.db.Exec("UPDATE local_execution_assignments SET " + column + " = " + column); err == nil {
			t.Fatal("immutable assignment column could be rewritten", column)
		}
	}
	if _, err = store.Register(context.Background(), assignment.IntentID, identity, now); err != nil {
		t.Fatal(err)
	}
	if _, err = store.db.Exec("UPDATE local_execution_assignments SET supervisor_json = NULL"); err == nil {
		t.Fatal("registered supervisor could be cleared")
	}
	if _, err = store.db.Exec("UPDATE local_execution_assignments SET local_lock_id = ?, owned_group_json = ?, event_window_ends_at = ?", daemon.NewRequestID(), `{"synthetic":true}`, "2026-09-12T12:00:20Z"); err != nil {
		t.Fatal(err)
	}
	for _, column := range []string{"local_lock_id", "owned_group_json", "event_window_ends_at"} {
		if _, err = store.db.Exec("UPDATE local_execution_assignments SET " + column + " = NULL"); err == nil {
			t.Fatal("registered identity or event window could be cleared", column)
		}
	}
	if _, err = store.db.Exec("UPDATE local_execution_assignments SET event_window_ends_at = '2026-09-12T12:00:21Z'"); err == nil {
		t.Fatal("event creation window could be extended")
	}
	claim.Assignment.RunId = daemon.NewRequestID()
	claim.Specification.RunId = claim.Assignment.RunId
	data, _ := json.Marshal(claim)
	if _, err = store.db.Exec("UPDATE local_execution_assignments SET claim_json = ?", string(data)); err != nil {
		t.Fatal(err)
	}
	_, err = store.ByIntent(context.Background(), assignment.IntentID)
	assertFailure(t, err, "execution_assignment_invalid")
}
