// ABOUTME: Tests the agent-work ownership barrier against live marker and retained native uncertainty.
// ABOUTME: Uses the real assignment/history store with injected kernel boundaries, not Terminal acceptance.

package supervisor

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
)

func agentOwnershipFixture(t *testing.T) (*Service, *nativeFixture, nativeInspector, LocalAssignment) {
	t.Helper()
	store, local, assignment, now := observationFixture(t)
	files, err := OpenAssignmentFiles(local.Paths.Root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = files.Close() })
	service := NewService(ServiceOptions{Now: func() time.Time { return now }})
	service.store, service.files, service.paths = store, files, local.Paths
	close(service.ready)
	facts, inspector := inspectionFixture(t, assignment)
	return service, facts, inspector, assignment
}

func TestAgentOwnershipAllowsLiveBootstrapWithoutInventingActivity(t *testing.T) {
	for _, prior := range []string{"absent", "waiting"} {
		t.Run(prior, func(t *testing.T) {
			testAgentOwnershipBootstrap(t, prior == "waiting")
		})
	}
}

func testAgentOwnershipBootstrap(t *testing.T, waitingHistory bool) {
	t.Helper()
	service, _, inspector, assignment := agentOwnershipFixture(t)
	ctx := context.Background()
	if waitingHistory {
		// L05 can persist a nil Group before pinning the actual provider leader.
		if _, err := service.store.rememberNative(ctx, assignment, nativeHistory{}); err != nil {
			t.Fatal(err)
		}
	}
	before, err := service.store.observationCheckpoint(ctx, assignment.IntentID)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.checkAgentOwnership(ctx, assignment.Claim.Assignment.RunExecutionId, assignment.Claim.Assignment.AssignmentGeneration, inspector); err != nil {
		t.Fatal(err)
	}
	after, err := service.store.observationCheckpoint(ctx, assignment.IntentID)
	if err != nil || before != after || after.ProviderObserved != "" {
		t.Fatal("agent admission invented a process/provider event", before, after, err)
	}
	history, err := readNativeHistory(ctx, service.store.db, assignment)
	if err != nil || history.Uncertain || history.Group == nil || history.Group.Leader != *assignment.Group {
		t.Fatal("fresh ownership evidence was not retained", history, err)
	}
}

func TestAgentOwnershipRejectsNativeUncertainty(t *testing.T) {
	for _, fault := range []string{"marker_unknown", "spawn_pending", "free_lock", "missing_lock", "signature", "owner_gone", "process_table", "escaped_child", "incomplete", "retained_uncertainty", "retained_release"} {
		t.Run(fault, func(t *testing.T) {
			service, native, inspector, assignment := agentOwnershipFixture(t)
			ctx := context.Background()
			switch fault {
			case "marker_unknown":
				native.locked.Record.State = "containment_unknown"
			case "spawn_pending":
				native.locked.Record.SpawnPending = true
			case "free_lock":
				native.locked.Held = false
			case "missing_lock":
				native.lockErr = errors.New("synthetic missing lock")
			case "signature":
				native.helperErr = failure("peer_denied")
			case "owner_gone":
				delete(native.table, assignment.Supervisor.Process.PID)
			case "process_table":
				native.processErr = errors.New("synthetic process read failure")
			case "escaped_child":
				child := fixtureProcess(1203, assignment.Group.PID, 1203)
				native.table[child.PID] = child
			case "incomplete":
				native.locked.Record.Group.Incomplete = true
			case "retained_uncertainty", "retained_release":
				history := nativeHistory{Group: native.locked.Record.Group, Uncertain: fault == "retained_uncertainty"}
				if fault == "retained_release" {
					history.LocalReleasedAt = localTimestamp(service.options.Now())
				}
				if _, err := service.store.rememberNative(ctx, assignment, history); err != nil {
					t.Fatal(err)
				}
			}
			if err := service.checkAgentOwnership(ctx, assignment.Claim.Assignment.RunExecutionId, assignment.Claim.Assignment.AssignmentGeneration, inspector); daemon.AsFailure(err).Code != "containment_unknown" {
				t.Fatal("uncertain ownership was accepted", fault, err)
			}
		})
	}
}

func TestAgentOwnershipRetainsMarkerOnlyDenialWithoutEventCapacity(t *testing.T) {
	service, native, inspector, assignment := agentOwnershipFixture(t)
	ctx := context.Background()
	if _, err := service.store.db.Exec(`CREATE TRIGGER synthetic_event_full BEFORE INSERT ON execution_observations BEGIN SELECT RAISE(ABORT,'synthetic full'); END`); err != nil {
		t.Fatal(err)
	}
	native.locked.Record.State = "containment_unknown"
	if err := service.checkAgentOwnership(ctx, assignment.Claim.Assignment.RunExecutionId, assignment.Claim.Assignment.AssignmentGeneration, inspector); daemon.AsFailure(err).Code != "containment_unknown" {
		t.Fatal(err)
	}
	history, err := readNativeHistory(ctx, service.store.db, assignment)
	if err != nil || !history.Uncertain {
		t.Fatal("marker-only uncertainty was lost", history, err)
	}
	native.locked.Record.State = "owned"
	if err := service.checkAgentOwnership(ctx, assignment.Claim.Assignment.RunExecutionId, assignment.Claim.Assignment.AssignmentGeneration, inspector); daemon.AsFailure(err).Code != "containment_unknown" {
		t.Fatal("fresh apparently good marker erased retained denial", err)
	}
	var count int
	if err := service.store.db.QueryRow("SELECT COUNT(*) FROM execution_observations").Scan(&count); err != nil || count != 0 {
		t.Fatal("admission fabricated activity", count, err)
	}
}

func TestAgentOwnershipRejectsAssignmentAndStorageFaults(t *testing.T) {
	for _, fault := range []string{"wrong_execution", "wrong_generation", "zero_generation", "inactive", "ended_during_inspection", "history_write", "closed_storage"} {
		t.Run(fault, func(t *testing.T) {
			service, native, inspector, assignment := agentOwnershipFixture(t)
			execution, generation := assignment.Claim.Assignment.RunExecutionId, assignment.Claim.Assignment.AssignmentGeneration
			want := "execution_assignment_invalid"
			switch fault {
			case "wrong_execution":
				execution = daemon.NewRequestID()
			case "wrong_generation":
				generation++
			case "zero_generation":
				generation = 0
			case "inactive":
				if _, err := service.store.db.Exec("UPDATE local_execution_assignments SET state = 'blocked'"); err != nil {
					t.Fatal(err)
				}
			case "ended_during_inspection":
				reads := 0
				inspector.processes = func() (ProcessTable, error) {
					reads++
					if reads == 2 {
						if _, err := service.store.db.Exec("UPDATE local_execution_assignments SET state = 'blocked'"); err != nil {
							t.Fatal(err)
						}
					}
					return native.table, nil
				}
			case "history_write":
				want = "storage_failed"
				if _, err := service.store.db.Exec(`CREATE TRIGGER synthetic_history_full BEFORE INSERT ON execution_native_history BEGIN SELECT RAISE(ABORT,'synthetic full'); END`); err != nil {
					t.Fatal(err)
				}
			case "closed_storage":
				want = "storage_failed"
				if err := service.store.db.Close(); err != nil {
					t.Fatal(err)
				}
			}
			if err := service.checkAgentOwnership(context.Background(), execution, generation, inspector); daemon.AsFailure(err).Code != want {
				t.Fatal("assignment/storage fault was not denied", fault, want, err)
			}
		})
	}
}

func TestAgentOwnershipUnavailableServiceFailsClosed(t *testing.T) {
	service := NewService(ServiceOptions{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := service.CheckAgentOwnership(ctx, daemon.NewRequestID(), 1); daemon.AsFailure(err).Code != "daemon_offline" {
		t.Fatal("unstarted service did not fail closed", err)
	}
	close(service.ready)
	if err := service.CheckAgentOwnership(context.Background(), daemon.NewRequestID(), 1); daemon.AsFailure(err).Code != "daemon_offline" {
		t.Fatal("stopped service did not fail closed", err)
	}
}
