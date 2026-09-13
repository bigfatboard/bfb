// ABOUTME: Exercises native-inspection decisions with controlled process, lock and signed-helper boundaries.
// ABOUTME: Proves waiting, startup, descendant retention and fail-closed recovery without claiming Terminal acceptance.

package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/provider"
)

type nativeFixture struct {
	assignment LocalAssignment
	table      ProcessTable
	locked     nativeLock
	image      bool
	imageCalls int
	helperErr  error
	lockErr    error
	processErr error
}

func inspectionFixture(t *testing.T, assignment LocalAssignment) (*nativeFixture, nativeInspector) {
	t.Helper()
	group, err := NewGroup(*assignment.Group)
	if err != nil {
		t.Fatal(err)
	}
	f := &nativeFixture{assignment: assignment, table: ProcessTable{assignment.Supervisor.Process.PID: assignment.Supervisor.Process, assignment.Group.PID: *assignment.Group}, locked: nativeLock{
		Record: LockRecord{Version: 1, LockID: assignment.LockID, Binding: assignment.lockBinding(), Owner: assignment.Supervisor.Process, Group: group, State: "owned"}, Held: true,
	}}
	inspector := nativeInspector{
		processes: func() (ProcessTable, error) { return f.table, f.processErr },
		helper: func(peer daemon.Peer) (SupervisorIdentity, error) {
			if peer.PID != assignment.Supervisor.Process.PID || peer.UID != os.Getuid() {
				t.Fatal("inspector selected another peer")
			}
			return *assignment.Supervisor, f.helperErr
		},
		lock: func(current LocalAssignment) (nativeLock, error) {
			if !sameObservedAssignment(current, f.assignment) {
				t.Fatal("inspector changed assignment")
			}
			return f.locked, f.lockErr
		},
		image: func(current LocalAssignment, process Process) error {
			f.imageCalls++
			if process != *assignment.Group || !sameObservedAssignment(current, assignment) {
				t.Fatal("inspector selected another image")
			}
			if !f.image {
				return failure("provider_unavailable")
			}
			return nil
		},
	}
	return f, inspector
}

func TestNativeInspectionSeparatesWaitingAndObservedStartup(t *testing.T) {
	_, _, assignment, _ := observationFixture(t)
	f, inspector := inspectionFixture(t, assignment)
	waiting := assignment
	waiting.Group, waiting.State = nil, "registered"
	f.assignment = waiting
	f.locked.Record.State, f.locked.Record.Group, f.locked.Record.SpawnPending = "reserved", nil, true
	if facts := inspector.inspect(waiting, nativeHistory{}, false); facts.Capture.State != "" || facts.History.Uncertain || f.imageCalls != 0 {
		t.Fatal("waiting spawn was treated as activity or uncertainty", facts)
	}
	waiting.LockID = ""
	if facts := inspector.inspect(waiting, nativeHistory{}, false); facts.Capture.State != "" || facts.History.Uncertain {
		t.Fatal("registered pre-acquisition helper was marked unknown", facts)
	}
	f, inspector = inspectionFixture(t, assignment)
	if facts := inspector.inspect(assignment, nativeHistory{}, false); facts.Capture.State != "live" || facts.Capture.ProviderImage || facts.History.Uncertain {
		t.Fatal("waiting wrapper asserted provider startup", facts)
	}
	f.image = true
	if facts := inspector.inspect(assignment, nativeHistory{}, false); !facts.Capture.ProviderImage || facts.Capture.State != "live" {
		t.Fatal("verified provider image was not observed", facts)
	}
	f.imageCalls = 0
	if facts := inspector.inspect(assignment, nativeHistory{}, true); facts.Capture.State != "live" || facts.Capture.ProviderImage || f.imageCalls != 0 {
		t.Fatal("historical startup required a new image/probe or fabricated a new startup", facts)
	}
}

func TestNativeInspectionPreservesOwnedChildAfterProviderParentExit(t *testing.T) {
	_, _, assignment, _ := observationFixture(t)
	f, inspector := inspectionFixture(t, assignment)
	child := fixtureProcess(1203, assignment.Group.PID, assignment.Group.GroupID)
	f.table[child.PID] = child
	first := inspector.inspect(assignment, nativeHistory{}, true)
	if first.Capture.State != "live" || len(first.History.Group.Observed) != 2 {
		t.Fatal("descendant not retained", first)
	}
	leader := *assignment.Group
	leader.Zombie = true
	f.table[leader.PID] = leader
	child.ParentPID = 1
	f.table[child.PID] = child
	if facts := inspector.inspect(assignment, first.History, true); facts.Capture.State != "live" || facts.History.Uncertain {
		t.Fatal("parent exit ended a surviving owned child's heartbeat", facts)
	}
	delete(f.table, child.PID)
	if facts := inspector.inspect(assignment, first.History, true); facts.Capture.State != "gone" || facts.SupervisorState != "verified" || facts.LockState != "held" {
		t.Fatal("whole-group end was confused with supervisor/lock release", facts)
	}
	delete(f.table, assignment.Supervisor.Process.PID)
	f.locked.Held, f.locked.Record.State = false, "released"
	if facts := inspector.inspect(assignment, first.History, true); facts.Capture.State != "gone" || facts.SupervisorState != "gone" || facts.LockState != "gone" || facts.History.Uncertain {
		t.Fatal("verified ordinary release lost its original identities", facts)
	}
}

func TestNativeInspectionFaultsCannotProduceLiveEvidence(t *testing.T) {
	for _, fault := range []string{"lock_missing", "table_failed", "signature", "owner_reuse", "group_reuse", "free_flock", "owner_gone", "escape", "unknown_marker", "unrecorded_member"} {
		t.Run(fault, func(t *testing.T) {
			_, _, assignment, _ := observationFixture(t)
			f, inspector := inspectionFixture(t, assignment)
			f.image = true
			switch fault {
			case "lock_missing":
				f.lockErr = errors.New("synthetic missing marker")
			case "table_failed":
				f.processErr = errors.New("synthetic inspection failure")
			case "signature":
				f.helperErr = failure("peer_denied")
			case "owner_reuse":
				owner := f.table[assignment.Supervisor.Process.PID]
				owner.StartIdentity = "9:9"
				f.table[owner.PID] = owner
			case "group_reuse":
				leader := f.table[assignment.Group.PID]
				leader.StartIdentity = "9:9"
				f.table[leader.PID] = leader
			case "free_flock":
				f.locked.Held = false
			case "owner_gone":
				delete(f.table, assignment.Supervisor.Process.PID)
			case "escape":
				f.table[1203] = fixtureProcess(1203, assignment.Group.PID, 1203)
			case "unknown_marker":
				f.locked.Record.State = "containment_unknown"
			case "unrecorded_member":
				f.table[1203] = fixtureProcess(1203, 1, assignment.Group.GroupID)
			}
			facts := inspector.inspect(assignment, nativeHistory{}, false)
			if facts.Capture.State != "unknown" || !facts.History.Uncertain || facts.Capture.ProviderImage {
				t.Fatal("failed native evidence was live", facts)
			}
		})
	}
}

func TestNativeInspectionRepeatsChecksAfterImageIO(t *testing.T) {
	for _, fault := range []string{"owner_exit", "owner_reuse", "escape", "release"} {
		t.Run(fault, func(t *testing.T) {
			_, _, assignment, _ := observationFixture(t)
			f, inspector := inspectionFixture(t, assignment)
			inspector.image = func(LocalAssignment, Process) error {
				switch fault {
				case "owner_exit":
					delete(f.table, assignment.Supervisor.Process.PID)
				case "owner_reuse":
					owner := assignment.Supervisor.Process
					owner.StartIdentity = "9:9"
					f.table[owner.PID] = owner
				case "escape":
					f.table[1203] = fixtureProcess(1203, assignment.Group.PID, 1203)
				case "release":
					f.locked.Held, f.locked.Record.State = false, "released"
				}
				return nil
			}
			facts := inspector.inspect(assignment, nativeHistory{}, false)
			if facts.Capture.State == "live" || facts.Capture.ProviderImage {
				t.Fatal("stale native evidence survived blocking image inspection", facts)
			}
		})
	}
}

func TestNativeReleaseProofCoversOnlyItsCompleteObservedHistory(t *testing.T) {
	ctx := context.Background()
	store, _, assignment, now := observationFixture(t)
	f, inspector := inspectionFixture(t, assignment)
	f.image = true
	service := NewService(ServiceOptions{Now: func() time.Time { return now }})
	if _, err := service.observeNative(ctx, store, inspector, assignment); err != nil {
		t.Fatal(err)
	}
	delete(f.table, assignment.Supervisor.Process.PID)
	delete(f.table, assignment.Group.PID)
	f.locked.Held, f.locked.Record.State = false, "released"
	now = now.Add(time.Second)
	if _, err := service.observeNative(ctx, store, inspector, assignment); err != nil {
		t.Fatal(err)
	}
	history, err := readNativeHistory(ctx, store.db, assignment)
	if err != nil || history.LocalReleasedAt == "" || history.ReleasedGroupHash != nativeGroupHash(history.Group) {
		t.Fatal("native release did not certify its retained history", err)
	}
	originalHash, originalTime := history.ReleasedGroupHash, history.LocalReleasedAt
	escaped := fixtureProcess(1800, 1, 1800)
	history.Group.Observed[escaped.PID] = escaped
	history.Group.Unknown, history.Group.HadEscape, history.Uncertain = true, true, true
	if _, err = store.rememberNative(ctx, assignment, history); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Second)
	// The newly retained process is absent, but the old helper marker does
	// not cover this unknown history and cannot grant automatic recovery.
	if _, _, err := service.inspectNative(ctx, store, inspector, assignment); err != nil {
		t.Fatal(err)
	}
	history, err = readNativeHistory(ctx, store.db, assignment)
	if err != nil || history.ReleasedGroupHash != originalHash || history.ReleasedGroupHash == nativeGroupHash(history.Group) || history.LocalReleasedAt != originalTime {
		t.Fatal("old release proof expanded to uninspected history", err)
	}
	// Model the already independently tested explicit local recovery marker.
	// Reinspection may certify it, without erasing historical uncertainty.
	f.locked.Record.RecoveryLocal, f.locked.Record.Group = true, mergeGroups(history.Group, nil)
	if _, _, err := service.inspectNative(ctx, store, inspector, assignment); err != nil {
		t.Fatal(err)
	}
	history, err = readNativeHistory(ctx, store.db, assignment)
	if err != nil || !history.Uncertain || !history.Group.HadEscape || history.ReleasedGroupHash != nativeGroupHash(history.Group) || history.ReleasedGroupHash == originalHash || history.LocalReleasedAt != originalTime {
		t.Fatal("recovered release did not certify precisely its retained history", err)
	}
}

func TestDaemonObservationRetainsEscapeAcrossCapacityFailureAndRestart(t *testing.T) {
	ctx := context.Background()
	store, local, assignment, now := observationFixture(t)
	f, inspector := inspectionFixture(t, assignment)
	escaped := fixtureProcess(1203, assignment.Group.PID, 1203)
	f.table[escaped.PID] = escaped
	service := NewService(ServiceOptions{Now: func() time.Time { return now }})
	if _, err := store.db.Exec(`CREATE TRIGGER synthetic_event_full BEFORE INSERT ON execution_observations BEGIN SELECT RAISE(ABORT,'synthetic full'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := service.observeNative(ctx, store, inspector, assignment); err == nil {
		t.Fatal("event capture failure ignored")
	}
	history, err := readNativeHistory(ctx, store.db, assignment)
	if err != nil || !history.Uncertain || !history.Group.HadEscape || history.Group.Observed[escaped.PID] != escaped {
		t.Fatal("failed event insert discarded observed escape", history, err)
	}
	if _, err := store.PinOwnership(ctx, assignment.IntentID, *assignment.Supervisor, assignment.LockID, assignment.Group, now); err == nil {
		t.Fatal("full event sink permitted new authorization after native uncertainty")
	}
	if _, err := store.db.Exec("DROP TRIGGER synthetic_event_full"); err != nil {
		t.Fatal(err)
	}
	if err := local.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := daemon.OpenStore(ctx, local.Paths)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	store = NewIntentStore(reopened.DB)
	delete(f.table, assignment.Supervisor.Process.PID)
	delete(f.table, assignment.Group.PID)
	escaped.ParentPID = 1
	f.table[escaped.PID] = escaped
	f.locked.Held, f.locked.Record.State = false, "released"
	facts, err := service.observeNative(ctx, store, inspector, assignment)
	if err != nil || facts.Capture.State != "unknown" || facts.History.Group.ProveGone(f.table) {
		t.Fatal("restart and helper release forgot live escaped descendant", facts, err)
	}
	delete(f.table, escaped.PID)
	now = now.Add(time.Second)
	if facts, err = service.observeNative(ctx, store, inspector, assignment); err != nil || facts.Capture.State != "gone" || !facts.History.Uncertain {
		t.Fatal("absence cleared unknown history", facts, err)
	}
	events, err := store.PendingObservations(ctx, 256)
	if err != nil || len(events) != 2 || events[0].Kind != "execution_detached" || events[1].Kind != "execution_ended" {
		t.Fatal("native event sequence was fabricated", events, err)
	}
	current, err := store.ByIntent(ctx, assignment.IntentID)
	if err != nil || current.State != "containment_unknown" {
		t.Fatal("ordinary absence cleared persistent uncertainty", err)
	}
}

func TestNativeHistoryConcurrentMergeCannotForgetProcesses(t *testing.T) {
	store, _, assignment, _ := observationFixture(t)
	var workers sync.WaitGroup
	for index := range 24 {
		workers.Go(func() {
			group, _ := NewGroup(*assignment.Group)
			child := fixtureProcess(1300+index, assignment.Group.PID, assignment.Group.GroupID)
			group.Observed[child.PID] = child
			if _, err := store.rememberNative(context.Background(), assignment, nativeHistory{Group: group, Uncertain: index == 0}); err != nil {
				t.Error(err)
			}
		})
	}
	workers.Wait()
	history, err := readNativeHistory(context.Background(), store.db, assignment)
	if err != nil || !history.Uncertain || len(history.Group.Observed) != 25 {
		t.Fatal("concurrent history update lost identities", history, err)
	}
	for _, fault := range []string{"binding", "invalid_group", "extra_field"} {
		t.Run(fault, func(t *testing.T) {
			bad := assignment
			fresh := nativeHistory{Group: mergeGroups(nil, history.Group)}
			switch fault {
			case "binding":
				bad.LockID = daemon.NewRequestID()
			case "invalid_group":
				fresh.Group.Leader.PID++
			case "extra_field":
				data, _ := json.Marshal(history)
				var fields map[string]any
				_ = json.Unmarshal(data, &fields)
				fields["result"] = "complete"
				data, _ = json.Marshal(fields)
				if _, err := store.db.Exec("UPDATE execution_native_history SET history_json = ?", string(data)); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := store.rememberNative(context.Background(), bad, fresh); err == nil {
				t.Fatal("invalid native history accepted")
			}
		})
	}
}

func TestNativeGroupMergeIsBoundedAndDoesNotMutateInput(t *testing.T) {
	leader := fixtureProcess(1202, 1201, 1202)
	first, _ := NewGroup(leader)
	second, _ := NewGroup(leader)
	for index := range maxObservedProcesses - 1 {
		child := fixtureProcess(2000+index, leader.PID, leader.GroupID)
		first.Observed[child.PID] = child
	}
	second.Observed[5000] = fixtureProcess(5000, leader.PID, leader.GroupID)
	merged := mergeGroups(first, second)
	if len(merged.Observed) != maxObservedProcesses || !merged.Unknown || !merged.Incomplete || first.Unknown || first.Incomplete || merged.ProveGone(ProcessTable{}) {
		t.Fatal("bounded merge silently lost recovery evidence")
	}
}

func TestNativeLockInspectionReadsHeldAndReleasedWithoutRepair(t *testing.T) {
	ctx := context.Background()
	store, local, claim, now := fixtureIntents(t)
	assignment := issueFixture(t, store, claim, now)
	if ok, err := store.Offer(ctx, assignment.IntentID); err != nil || !ok {
		t.Fatal(err)
	}
	table, err := InspectProcesses()
	if err != nil {
		t.Fatal(err)
	}
	owner := SupervisorIdentity{Process: table[os.Getpid()], ExecutableHash: provider.Hash(nil)}
	assignment, err = store.Register(ctx, assignment.IntentID, owner, now)
	if err != nil {
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
	assignment, err = store.PinOwnership(ctx, assignment.IntentID, owner, lock.record.LockID, nil, now)
	if err != nil {
		t.Fatal(err)
	}
	if facts, err := readNativeLock(local.Paths, assignment); err != nil || !facts.Held || facts.Record.State != "reserved" {
		t.Fatal("real held reservation unavailable", facts, err)
	}
	if err := lock.beginSpawn(); err != nil {
		t.Fatal(err)
	}
	if facts, err := readNativeLock(local.Paths, assignment); err != nil || !facts.Record.SpawnPending {
		t.Fatal("inspection hid pending spawn", err)
	}
	command, leader := fixtureSleep(t)
	if err := lock.Attach(leader); err != nil {
		t.Fatal(err)
	}
	assignment, err = store.PinOwnership(ctx, assignment.IntentID, owner, lock.record.LockID, &leader, now)
	if err != nil {
		t.Fatal(err)
	}
	inspector := nativeInspector{processes: InspectProcesses,
		helper: func(daemon.Peer) (SupervisorIdentity, error) { return owner, nil },
		lock:   func(a LocalAssignment) (nativeLock, error) { return readNativeLock(local.Paths, a) },
		image:  func(LocalAssignment, Process) error { return failure("provider_unavailable") },
	}
	if facts := inspector.inspect(assignment, nativeHistory{}, true); facts.Capture.State != "live" || facts.History.Uncertain {
		t.Fatal("actual owned process was not live", facts)
	}
	if err := command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	awaitAbsent(t, leader.PID)
	if facts := inspector.inspect(assignment, nativeHistory{}, true); facts.Capture.State != "gone" || facts.LockState != "held" {
		t.Fatal("actual group end was not observed under held fence", facts)
	}
	if err := lock.Release(); err != nil {
		t.Fatal(err)
	}
	if facts, err := readNativeLock(local.Paths, assignment); err != nil || facts.Held || facts.Record.State != "released" || facts.Record.Group.Leader != leader {
		t.Fatal("real released marker lost original group", facts, err)
	}
	path := filepath.Join(worktreeLocksPath(local.Paths), lockName(assignment.lockBinding().PhysicalWorktreeHash, ".json"))
	if err := os.Rename(path, path+".retained"); err != nil {
		t.Fatal(err)
	}
	if _, err := readNativeLock(local.Paths, assignment); err == nil {
		t.Fatal("missing authenticated marker treated as free")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("reader repaired missing marker")
	}
	missing, err := daemon.StatePaths(filepath.Join(local.Paths.Root, "absent-state"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := readNativeLock(missing, assignment); err == nil {
		t.Fatal("reader accepted absent private state")
	}
	if _, err := os.Stat(missing.Root); !os.IsNotExist(err) {
		t.Fatal("reader initialized absent private state")
	}
}

func TestLocalRecoveryIncludesDaemonOnlyDescendantsEvenAfterHelperRelease(t *testing.T) {
	for _, state := range []string{"owned", "released"} {
		t.Run(state, func(t *testing.T) {
			ctx := context.Background()
			store, local, claim, now := fixtureIntents(t)
			assignment := issueFixture(t, store, claim, now)
			if ok, err := store.Offer(ctx, assignment.IntentID); err != nil || !ok {
				t.Fatal(err)
			}
			// Synthetic authenticated history isolates recovery's merge boundary.
			// The additional process is real; recovery must never kill it.
			owner := SupervisorIdentity{Process: fixtureProcess(2147483600, 1, 2147483600), ExecutableHash: provider.Hash(nil)}
			assignment, err := store.Register(ctx, assignment.IntentID, owner, now)
			if err != nil {
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
			if err := lock.Close(); err != nil {
				t.Fatal(err)
			}
			leader := fixtureProcess(2147483601, owner.Process.PID, 2147483601)
			assignment, err = store.PinOwnership(ctx, assignment.IntentID, owner, lock.record.LockID, nil, now)
			if err != nil {
				t.Fatal(err)
			}
			assignment, err = store.PinOwnership(ctx, assignment.IntentID, owner, lock.record.LockID, &leader, now)
			if err != nil {
				t.Fatal(err)
			}
			record := lock.record
			record.Owner, record.State = owner.Process, state
			record.Group, _ = NewGroup(leader)
			if err := locks.directory.write(lockName(record.Binding.PhysicalWorktreeHash, ".json"), record); err != nil {
				t.Fatal(err)
			}
			command, descendant := fixtureSleep(t)
			group := mergeGroups(nil, record.Group)
			group.Observed[descendant.PID] = descendant
			group.Unknown, group.HadEscape = true, true
			if _, err := store.rememberNative(ctx, assignment, nativeHistory{Group: group, Uncertain: true}); err != nil {
				t.Fatal(err)
			}
			service := NewService(ServiceOptions{})
			service.store, service.paths = store, local.Paths
			assertFailure(t, service.RecoverLocal(ctx, assignment.IntentID), "containment_unknown")
			table, err := InspectProcesses()
			if err != nil || !descendant.Same(table[descendant.PID]) || table[descendant.PID].Zombie {
				t.Fatal("recovery killed an ambiguous process")
			}
			if err := command.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			awaitAbsent(t, descendant.PID)
			if err := service.RecoverLocal(ctx, assignment.IntentID); err != nil {
				t.Fatal("explicit absent-process recovery failed", err)
			}
			recovered, err := locks.read(record.Binding.PhysicalWorktreeHash)
			if err != nil || !recovered.RecoveryLocal || recovered.State != "released" || !recovered.Group.HadEscape || recovered.Group.Observed[descendant.PID] != descendant {
				t.Fatal("recovery discarded daemon-observed history", recovered, err)
			}
			history, err := readNativeHistory(ctx, store.db, assignment)
			if err != nil || history.LocalReleasedAt == "" || history.ReleasedGroupHash != nativeGroupHash(history.Group) || !history.Uncertain || !history.Group.HadEscape || history.Group.Observed[descendant.PID] != descendant {
				t.Fatal("local recovery did not certify the retained release history", history, err)
			}
			if events, err := store.PendingObservations(ctx, 256); err != nil || len(events) != 0 {
				t.Fatal("local recovery fabricated process events", events, err)
			}
		})
	}
}

func TestDaemonNativeCaptureUsesCurrentEvidenceWithoutBackfill(t *testing.T) {
	ctx := context.Background()
	store, _, assignment, now := observationFixture(t)
	f, inspector := inspectionFixture(t, assignment)
	service := NewService(ServiceOptions{Now: func() time.Time { return now }})
	if _, err := service.observeNative(ctx, store, inspector, assignment); err != nil {
		t.Fatal(err)
	}
	if events, err := store.PendingObservations(ctx, 256); err != nil || len(events) != 0 {
		t.Fatal("waiting wrapper created an event")
	}
	f.image = true
	for _, offset := range []time.Duration{time.Second, 10 * time.Second, 10 * time.Second, time.Hour} {
		now = now.Add(offset)
		if _, err := service.observeNative(ctx, store, inspector, assignment); err != nil {
			t.Fatal(err)
		}
	}
	if events, err := store.PendingObservations(ctx, 256); err != nil || len(events) != 3 || events[0].Kind != "execution_attached" || events[1].Kind != "heartbeat" || events[2].Kind != "heartbeat" || events[2].OccurredAt != localTimestamp(now) {
		t.Fatal("native inspection backfilled or duplicated a heartbeat", events, err)
	}
	if f.imageCalls != 2 {
		t.Fatal("heartbeat reprobed startup image", f.imageCalls)
	}
}

func TestLocalRecoveryCannotRecreateMissingFence(t *testing.T) {
	locks := fixtureLockStore(t)
	lock, err := locks.Acquire(fixtureBinding())
	if err != nil {
		t.Fatal(err)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(locks.directory.file.Name(), lockName(lock.record.Binding.PhysicalWorktreeHash, ".lock"))
	if err := os.Rename(path, path+".retained"); err != nil {
		t.Fatal(err)
	}
	if err := locks.recoverLocal(lock.record.Binding, nil); err == nil {
		t.Fatal("missing native fence was recoverable")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("recovery recreated the missing native fence")
	}
}
