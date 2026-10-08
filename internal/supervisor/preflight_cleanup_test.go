// ABOUTME: Exercises closed-gate preflight cleanup, immutable claim retries and fail-closed absence proofs.
// ABOUTME: Separately verifies abandoned native markers require explicit local recovery and successors remain untouched.

package supervisor

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/runner"
)

func preflightFixture(t *testing.T) (*IntentStore, *daemon.Store, LocalAssignment, LocalCommand, time.Time) {
	t.Helper()
	ctx := context.Background()
	store, local, claim, now := fixtureIntents(t)
	assignment := issueFixture(t, store, claim, now)
	if offered, err := store.Offer(ctx, assignment.IntentID); err != nil || !offered {
		t.Fatal(err)
	}
	owner := SupervisorIdentity{Process: fixtureProcess(2147483600, 1, 2147483600), ExecutableHash: provider.Hash(nil)}
	assignment, err := store.Register(ctx, assignment.IntentID, owner, now)
	if err != nil {
		t.Fatal(err)
	}
	command, err := store.Command(ctx, claim.Assignment.RunnerId, claim.Specification.LaunchId)
	if err != nil {
		t.Fatal(err)
	}
	return store, local, assignment, command, now
}

func absentPreflightInspector(t *testing.T) nativeInspector {
	t.Helper()
	return nativeInspector{
		processes: func() (ProcessTable, error) { return ProcessTable{}, nil },
		lock: func(LocalAssignment) (nativeLock, error) {
			t.Fatal("preflight cleanup inspected a physical marker")
			return nativeLock{}, nil
		},
		helper: func(daemon.Peer) (SupervisorIdentity, error) {
			t.Fatal("absent helper was inspected")
			return SupervisorIdentity{}, nil
		},
		image: func(LocalAssignment, Process) error { t.Fatal("unstarted provider image was inspected"); return nil },
	}
}

func TestPreflightCleanupExcludesRacingFirstAuthorization(t *testing.T) {
	ctx := context.Background()
	for range 16 {
		store, _, assignment, command, now := preflightFixture(t)
		start := make(chan struct{})
		var pinErr, cleanupErr error
		var cleaning LocalAssignment
		var workers sync.WaitGroup
		workers.Go(func() {
			<-start
			_, pinErr = store.PinOwnership(ctx, assignment.IntentID, *assignment.Supervisor, daemon.NewRequestID(), nil, now)
		})
		workers.Go(func() { <-start; cleaning, _, cleanupErr = store.beginPreflightCleanup(ctx, assignment, command) })
		close(start)
		workers.Wait()
		if (pinErr == nil) == (cleanupErr == nil) {
			t.Fatal("cleanup and first authorization did not have exactly one winner", pinErr, cleanupErr)
		}
		if cleanupErr == nil {
			if cleaning.State != "blocked" || cleaning.LockID != "" || cleaning.Group != nil || *cleaning.Supervisor != *assignment.Supervisor {
				t.Fatal("cleanup replaced original ownership", cleaning)
			}
			if _, err := store.PinOwnership(ctx, assignment.IntentID, *assignment.Supervisor, daemon.NewRequestID(), nil, now); err == nil {
				t.Fatal("closed preflight gate reopened")
			}
			if _, err := store.Register(ctx, assignment.IntentID, *assignment.Supervisor, now); err == nil {
				t.Fatal("blocked helper registered again")
			}
			if _, err := store.nextLeaseSequence(ctx, cleaning, 0); err == nil {
				t.Fatal("barrier without native absence reserved release sequence")
			}
		} else {
			if _, _, err := store.beginPreflightCleanup(ctx, assignment, command); err == nil {
				t.Fatal("pinned authorization was treated as preflight absence")
			}
		}
	}
}

func TestPreflightCleanupReleasesWithoutInitializingPhysicalState(t *testing.T) {
	ctx := context.Background()
	store, local, assignment, original, now := preflightFixture(t)
	inspector := absentPreflightInspector(t)
	released, sent := false, 0
	connection := &finalConnection{request: func(_ context.Context, _, path string, body []byte) ([]byte, error) {
		switch path {
		case "launch/reconcile":
			expected, _ := claimRequest(original)
			if string(expected) != string(body) {
				t.Fatal("cleanup replaced the original claim")
			}
			now = now.Add(time.Minute)
			state := "reserved"
			if released {
				state = "released"
			}
			return encodedFixture(t, receiptFixture(assignment.Claim, state)), nil
		case "leases/observe":
			sent++
			observation := decodedLease(t, body)
			cleaning, _ := store.ByIntent(ctx, assignment.IntentID)
			command, _ := store.Command(ctx, original.RunnerID, original.ID)
			if observation.Operation != "release" || observation.RecoveryLocal || observation.Sequence != 1 || observation.ObservedAt != localTimestamp(now) ||
				observation.Supervisor == nil || *observation.Supervisor != assignment.Supervisor.wire() || observation.SupervisorState != "gone" || observation.GroupState != "never_started" ||
				observation.LockState != "gone" || observation.DescendantsState != "none" || observation.OwnedGroupId != 0 || observation.OwnedGroupStartIdentity != "" ||
				observation.LocalLockId != command.CleanupLockID || command.CleanupLockID == "" || cleaning.LockID != "" || !hasPreflightProof(ctx, store.db, cleaning) {
				t.Fatal("release lacked fresh closed-gate evidence", observation)
			}
			released = true
			return []byte(`{"state":"released"}`), nil
		default:
			t.Fatal("cleanup performed an unexpected cloud effect", path)
			return nil, nil
		}
	}}
	service := leaseFixtureService(func() time.Time { return now }, connection)
	if err := service.maintainLease(ctx, store, inspector, assignment.IntentID); err != nil || sent != 1 {
		t.Fatal(err, sent)
	}
	current, _ := store.ByIntent(ctx, assignment.IntentID)
	command, _ := store.Command(ctx, original.RunnerID, original.ID)
	events, err := store.PendingObservations(ctx, 256)
	if err != nil || len(events) != 1 || events[0].Kind != "launch_blocked" || events[0].ProviderStart != "unobserved" || current.State != "blocked" || command.State != "complete" {
		t.Fatal("cleanup inferred work or lost its end fact", events, current.State, command.State, err)
	}
	if _, err := os.Stat(worktreeLocksPath(local.Paths)); !os.IsNotExist(err) {
		t.Fatal("cloud cleanup initialized physical lock state", err)
	}
	service.store, service.paths = store, local.Paths
	if err := service.RecoverLocal(ctx, assignment.IntentID); err == nil {
		t.Fatal("explicit recovery fabricated a missing physical marker")
	}
	if _, err := os.Stat(worktreeLocksPath(local.Paths)); !os.IsNotExist(err) {
		t.Fatal("local recovery initialized missing lock state", err)
	}
}

func TestPreflightCleanupRejectsNativeAndCloudContradictions(t *testing.T) {
	for _, fault := range []string{"owner_live", "owner_reused", "kernel", "slow", "clock_reversal", "started", "live", "unknown", "wrong_binding", "partial", "pinned_during_reconcile", "owner_reappears_after_barrier"} {
		t.Run(fault, func(t *testing.T) {
			ctx := context.Background()
			store, _, assignment, command, now := preflightFixture(t)
			inspector := absentPreflightInspector(t)
			inspections := 0
			inspector.processes = func() (ProcessTable, error) {
				inspections++
				switch fault {
				case "owner_live":
					return ProcessTable{assignment.Supervisor.Process.PID: assignment.Supervisor.Process}, nil
				case "owner_reused":
					owner := assignment.Supervisor.Process
					owner.StartIdentity = "9:9"
					return ProcessTable{owner.PID: owner}, nil
				case "kernel":
					return nil, errors.New("synthetic native failure")
				case "slow":
					now = now.Add(6 * time.Second)
				case "clock_reversal":
					now = now.Add(-time.Second)
				case "owner_reappears_after_barrier":
					if inspections == 2 {
						return ProcessTable{assignment.Supervisor.Process.PID: assignment.Supervisor.Process}, nil
					}
				}
				return ProcessTable{}, nil
			}
			connection := &finalConnection{request: func(_ context.Context, _, path string, _ []byte) ([]byte, error) {
				if path != "launch/reconcile" {
					t.Fatal("failed preflight evidence mutated cloud state", path)
				}
				receipt := receiptFixture(assignment.Claim, "reserved")
				switch fault {
				case "started":
					receipt.LaunchState = "started"
				case "live":
					receipt.ReservationState = "live"
				case "unknown":
					receipt.ReservationState = "containment_unknown"
				case "wrong_binding":
					receipt.RunExecutionId = daemon.NewRequestID()
				case "partial":
					return []byte(`{"reservation_state":"released"}`), nil
				case "pinned_during_reconcile":
					if _, err := store.PinOwnership(ctx, assignment.IntentID, *assignment.Supervisor, daemon.NewRequestID(), nil, now); err != nil {
						t.Fatal(err)
					}
				}
				return encodedFixture(t, receipt), nil
			}}
			if err := leaseFixtureService(func() time.Time { return now }, connection).maintainLease(ctx, store, inspector, assignment.IntentID); err == nil {
				t.Fatal("contradictory cleanup evidence accepted", fault)
			}
			current, _ := store.ByIntent(ctx, assignment.IntentID)
			pending, _ := store.Command(ctx, command.RunnerID, command.ID)
			history, err := readNativeHistory(ctx, store.db, current)
			if err != nil || history.PreflightStoppedAt != "" || pending.State == "complete" {
				t.Fatal("failed evidence produced a release checkpoint", history, err)
			}
		})
	}
}

func TestPreflightLostReleaseReplySettlesAfterRestartWithoutTouchingSuccessor(t *testing.T) {
	ctx := context.Background()
	store, local, assignment, command, now := preflightFixture(t)
	inspector := absentPreflightInspector(t)
	released, sent := false, 0
	connection := &finalConnection{request: func(_ context.Context, _, path string, _ []byte) ([]byte, error) {
		if path == "launch/reconcile" {
			state := "reserved"
			if released {
				state = "superseded"
			}
			return encodedFixture(t, receiptFixture(assignment.Claim, state)), nil
		}
		if path != "leases/observe" || released {
			t.Fatal("lost reply resent a settled release", path)
		}
		released, sent = true, sent+1
		return nil, errors.New("synthetic lost release acknowledgement")
	}}
	service := leaseFixtureService(func() time.Time { return now }, connection)
	if err := service.maintainLease(ctx, store, inspector, assignment.IntentID); err == nil {
		t.Fatal("lost reply accepted")
	}
	before, _ := store.Command(ctx, command.RunnerID, command.ID)
	locks, err := OpenLockStore(worktreeLocksPath(local.Paths))
	if err != nil {
		t.Fatal(err)
	}
	defer locks.Close()
	binding := assignment.lockBinding()
	binding.ExecutionID, binding.FencingGeneration = daemon.NewRequestID(), binding.FencingGeneration+1
	lock, err := locks.Acquire(binding)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	marker, err := os.ReadFile(filepath.Join(worktreeLocksPath(local.Paths), lockName(binding.PhysicalWorktreeHash, ".json")))
	if err != nil {
		t.Fatal(err)
	}
	if err := local.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := daemon.OpenStore(ctx, local.Paths)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	store = NewIntentStore(reopened.DB)
	service = leaseFixtureService(func() time.Time { return now }, connection)
	if err := service.maintainLease(ctx, store, inspector, assignment.IntentID); err != nil {
		t.Fatal(err)
	}
	after, _ := store.Command(ctx, command.RunnerID, command.ID)
	if sent != 1 || before.CleanupLockID != after.CleanupLockID || before.ClaimKey != after.ClaimKey || after.State != "complete" {
		t.Fatal("restart lost cleanup identity", before, after)
	}
	afterMarker, err := os.ReadFile(filepath.Join(worktreeLocksPath(local.Paths), lockName(binding.PhysicalWorktreeHash, ".json")))
	if err != nil || string(marker) != string(afterMarker) {
		t.Fatal("cloud cleanup changed successor marker", err)
	}
	service.store, service.paths = store, local.Paths
	if err := service.RecoverLocal(ctx, assignment.IntentID); err == nil {
		t.Fatal("local cleanup recovered another execution's lock")
	}
	if err := lock.check(); err != nil {
		t.Fatal("successor physical ownership was changed", err)
	}
	if err := lock.Release(); err != nil {
		t.Fatal(err)
	}
}

func TestPreflightEndCaptureFailureDoesNotBlockCloudReleaseOrLosePendingFact(t *testing.T) {
	ctx := context.Background()
	store, _, assignment, command, now := preflightFixture(t)
	inspector := absentPreflightInspector(t)
	if _, err := store.db.Exec("CREATE TRIGGER synthetic_event_full BEFORE INSERT ON execution_observations BEGIN SELECT RAISE(ABORT, 'synthetic capacity'); END"); err != nil {
		t.Fatal(err)
	}
	released, sent := false, 0
	connection := &finalConnection{request: func(_ context.Context, _, path string, _ []byte) ([]byte, error) {
		if path == "launch/reconcile" {
			state := "reserved"
			if released {
				state = "released"
			}
			return encodedFixture(t, receiptFixture(assignment.Claim, state)), nil
		}
		if path != "leases/observe" || released {
			t.Fatal("unexpected preflight request", path)
		}
		released, sent = true, sent+1
		return []byte(`{}`), nil
	}}
	service := leaseFixtureService(func() time.Time { return now }, connection)
	if err := service.maintainLease(ctx, store, inspector, assignment.IntentID); err == nil {
		t.Fatal("failed capture completed command")
	}
	pending, _ := store.Command(ctx, command.RunnerID, command.ID)
	if !released || pending.State == "complete" {
		t.Fatal("event capacity blocked release or lost pending command")
	}
	if _, err := store.db.Exec("DROP TRIGGER synthetic_event_full"); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute)
	if err := service.maintainLease(ctx, store, inspector, assignment.IntentID); err != nil {
		t.Fatal(err)
	}
	pending, _ = store.Command(ctx, command.RunnerID, command.ID)
	if pending.State != "complete" || sent != 1 {
		t.Fatal("end fact recovery resent release or stayed pending")
	}
}

func TestPreflightCleanupIDCannotReenterLaunchPreparation(t *testing.T) {
	ctx := context.Background()
	store, _, assignment, command, now := preflightFixture(t)
	_, cleaning, err := store.beginPreflightCleanup(ctx, assignment, command)
	if err != nil {
		t.Fatal(err)
	}
	connection := &finalConnection{request: func(context.Context, string, string, []byte) ([]byte, error) {
		t.Fatal("registered cleanup reentered the launch queue")
		return nil, nil
	}}
	service := NewService(ServiceOptions{Now: func() time.Time { return now }, Connection: func(string) (runner.RunnerConnection, error) { return connection, nil }})
	if err := service.processLaunch(ctx, store, nil, cleaning); err != nil {
		t.Fatal(err)
	}
}

func TestPreflightCrashPreservesRealReservationUntilExplicitLocalRecovery(t *testing.T) {
	ctx := context.Background()
	store, local, claim, now := fixtureIntents(t)
	assignment := issueFixture(t, store, claim, now)
	if offered, err := store.Offer(ctx, assignment.IntentID); err != nil || !offered {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(assignment.lockBinding())
	fixtureContext, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	child := exec.CommandContext(fixtureContext, os.Args[0], "-test.run=^TestPreflightNativeLockFixture$", "-test.timeout=20s")
	child.Env = append(os.Environ(), "BFB_L05_PREFLIGHT_FIXTURE="+worktreeLocksPath(local.Paths), "BFB_L05_PREFLIGHT_BINDING="+string(encoded))
	output, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	scanner := bufio.NewScanner(output)
	if !scanner.Scan() {
		t.Fatal("native preflight fixture did not acquire its lock")
	}
	var native LockRecord
	if json.Unmarshal(scanner.Bytes(), &native) != nil || !native.valid() || native.Owner.PID != child.Process.Pid || native.Binding != assignment.lockBinding() || native.State != "reserved" || native.Group != nil || native.SpawnPending {
		t.Fatal("invalid native preflight fixture receipt")
	}
	owner := SupervisorIdentity{Process: native.Owner, ExecutableHash: provider.Hash(nil)}
	assignment, err = store.Register(ctx, assignment.IntentID, owner, now)
	if err != nil {
		t.Fatal(err)
	}
	inspector := absentPreflightInspector(t)
	inspector.processes = InspectProcesses
	released, sent := false, 0
	connection := &finalConnection{request: func(_ context.Context, _, path string, _ []byte) ([]byte, error) {
		if path == "launch/reconcile" {
			state := "reserved"
			if released {
				state = "released"
			}
			return encodedFixture(t, receiptFixture(claim, state)), nil
		}
		if path != "leases/observe" || released {
			t.Fatal("unexpected cleanup effect", path)
		}
		released, sent = true, sent+1
		return []byte(`{}`), nil
	}}
	service := leaseFixtureService(func() time.Time { return now }, connection)
	service.store, service.paths = store, local.Paths
	if err := service.maintainLease(ctx, store, inspector, assignment.IntentID); err == nil || sent != 0 {
		t.Fatal("live native preflight was released", err)
	}
	if err := service.RecoverLocal(ctx, assignment.IntentID); err == nil {
		t.Fatal("live unpinned helper recovered")
	}
	if err := child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = child.Wait()
	locks, err := OpenLockStore(worktreeLocksPath(local.Paths))
	if err != nil {
		t.Fatal(err)
	}
	defer locks.Close()
	path := filepath.Join(worktreeLocksPath(local.Paths), lockName(native.Binding.PhysicalWorktreeHash, ".json"))
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := service.maintainLease(ctx, store, inspector, assignment.IntentID); err != nil || sent != 1 {
		t.Fatal("dead native preflight did not settle", err)
	}
	after, err := os.ReadFile(path)
	if err != nil || string(before) != string(after) {
		t.Fatal("cloud release changed abandoned physical marker", err)
	}
	successor := native.Binding
	successor.ExecutionID, successor.FencingGeneration = daemon.NewRequestID(), successor.FencingGeneration+1
	if _, err := locks.Acquire(successor); err == nil {
		t.Fatal("cloud release bypassed abandoned local occupancy")
	}
	if err := service.RecoverLocal(ctx, assignment.IntentID); err != nil {
		t.Fatal("explicit local recovery failed after native owner exit", err)
	}
	current, _ := store.ByIntent(ctx, assignment.IntentID)
	recovered, err := locks.read(native.Binding.PhysicalWorktreeHash)
	if err != nil || current.LockID != "" || current.State != "blocked" || recovered.LockID != native.LockID || recovered.Owner != native.Owner || recovered.State != "released" || !recovered.RecoveryLocal {
		t.Fatal("recovery replaced native identity or reopened the gate", recovered, err)
	}
	lock, err := locks.Acquire(successor)
	if err != nil {
		t.Fatal("explicit recovery did not restore checkout availability", err)
	}
	defer lock.Close()
	if err := lock.Release(); err != nil {
		t.Fatal(err)
	}
}

func TestPreflightNativeLockFixture(t *testing.T) {
	path := os.Getenv("BFB_L05_PREFLIGHT_FIXTURE")
	if path == "" {
		t.Skip("owned native subprocess fixture")
	}
	var binding LockBinding
	if json.Unmarshal([]byte(os.Getenv("BFB_L05_PREFLIGHT_BINDING")), &binding) != nil {
		t.Fatal("invalid fixture binding")
	}
	locks, err := OpenLockStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer locks.Close()
	lock, err := locks.Acquire(binding)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := json.NewEncoder(os.Stdout).Encode(lock.record); err != nil {
		t.Fatal(err)
	}
	select {}
}

func TestPreflightLocalRecoveryRejectsContradictoryOrMissingNativeProof(t *testing.T) {
	for _, fault := range []string{"owner", "binding", "spawn_pending", "group", "marker_missing", "fence_missing", "corrupt", "held"} {
		t.Run(fault, func(t *testing.T) {
			ctx := context.Background()
			store, local, assignment, command, now := preflightFixture(t)
			assignment, _, err := store.beginPreflightCleanup(ctx, assignment, command)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := store.rememberNative(ctx, assignment, nativeHistory{PreflightStoppedAt: localTimestamp(now)}); err != nil {
				t.Fatal(err)
			}
			locks, err := OpenLockStore(worktreeLocksPath(local.Paths))
			if err != nil {
				t.Fatal(err)
			}
			defer locks.Close()
			lock, err := locks.Acquire(assignment.lockBinding())
			if err != nil {
				t.Fatal(err)
			}
			defer lock.Close()
			if fault != "held" {
				if err := lock.Close(); err != nil {
					t.Fatal(err)
				}
			}
			record := lock.record
			record.Owner = assignment.Supervisor.Process
			switch fault {
			case "owner":
				record.Owner.StartIdentity = "9:9"
			case "binding":
				record.Binding.ExecutionID = daemon.NewRequestID()
			case "spawn_pending":
				record.SpawnPending = true
			case "group":
				record.Group, _ = NewGroup(fixtureProcess(2147483601, record.Owner.PID, 2147483601))
				record.State = "owned"
			}
			name := lockName(record.Binding.PhysicalWorktreeHash, ".json")
			if err := locks.directory.write(name, record); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(worktreeLocksPath(local.Paths), name)
			if fault == "marker_missing" || fault == "fence_missing" {
				if fault == "fence_missing" {
					path = filepath.Join(worktreeLocksPath(local.Paths), lockName(record.Binding.PhysicalWorktreeHash, ".lock"))
				}
				if err := os.Rename(path, path+".retained"); err != nil {
					t.Fatal(err)
				}
			}
			if fault == "corrupt" {
				// A valid HMAC over a semantically invalid fixture must still fail.
				record.Version = 2
				if err := locks.directory.write(name, record); err != nil {
					t.Fatal(err)
				}
			}
			service := NewService(ServiceOptions{})
			service.store, service.paths = store, local.Paths
			if err := service.RecoverLocal(ctx, assignment.IntentID); err == nil {
				t.Fatal("contradictory local proof recovered", fault)
			}
			if fault == "marker_missing" || fault == "fence_missing" {
				if _, err := os.Stat(path); !os.IsNotExist(err) {
					t.Fatal("local recovery recreated missing evidence", err)
				}
			} else if current, err := locks.read(record.Binding.PhysicalWorktreeHash); err == nil && (current.State == "released" || current.RecoveryLocal) {
				t.Fatal("failed recovery changed native marker", current)
			}
		})
	}
}
