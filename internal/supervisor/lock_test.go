// ABOUTME: Exercises native worktree contention, durable crash markers and explicit local recovery.
// ABOUTME: Uses isolated private state and owned synthetic processes without changing real checkouts.

package supervisor

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
)

func fixtureBinding() LockBinding {
	return LockBinding{ExecutionID: daemon.NewRequestID(), AssignmentGeneration: 1, FencingGeneration: 1, PhysicalWorktreeHash: "sha256:" + strings.Repeat("a", 64)}
}

func fixtureLockStore(t *testing.T) *LockStore {
	t.Helper()
	store, err := OpenLockStore(filepath.Join(t.TempDir(), "execution"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func assertFailure(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil || daemon.AsFailure(err).Code != code {
		t.Fatalf("expected %s, got %v", code, err)
	}
}

func TestPhysicalLockHasOneConcurrentOwnerAcrossExecutions(t *testing.T) {
	store := fixtureLockStore(t)
	binding := fixtureBinding()
	const contenders = 24
	owners := make(chan *WorktreeLock, contenders)
	failures := make(chan error, contenders)
	var workers sync.WaitGroup
	for range contenders {
		workers.Go(func() {
			// A different execution/fence cannot bypass the shared physical key.
			contender := binding
			contender.ExecutionID = daemon.NewRequestID()
			contender.FencingGeneration = 9
			lock, err := store.Acquire(contender)
			if err != nil {
				failures <- err
			} else {
				owners <- lock
			}
		})
	}
	workers.Wait()
	close(owners)
	close(failures)
	if len(owners) != 1 || len(failures) != contenders-1 {
		t.Fatalf("owners %d, conflicts %d", len(owners), len(failures))
	}
	for err := range failures {
		assertFailure(t, err, "checkout_occupied")
	}
	lock := <-owners
	defer lock.Close()
	before, err := lock.file.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if err = lock.Release(); err != nil {
		t.Fatal(err)
	}
	if _, err = store.Acquire(lock.record.Binding); err == nil {
		t.Fatal("released execution reacquired its lock")
	}
	other, err := OpenLockStore(store.directory.file.Name())
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	lock, err = other.Acquire(binding)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	after, err := lock.file.Stat()
	if err != nil || !os.SameFile(before, after) {
		t.Fatal("physical lock inode was replaced")
	}
	if err = lock.Release(); err != nil {
		t.Fatal(err)
	}
}

func TestCloseDoesNotReleaseAndLocalRecoveryCannotIgnoreLiveOwner(t *testing.T) {
	store := fixtureLockStore(t)
	binding := fixtureBinding()
	lock, err := store.Acquire(binding)
	if err != nil {
		t.Fatal(err)
	}
	assertFailure(t, store.RecoverLocal(binding), "checkout_occupied")
	if err = lock.Close(); err != nil {
		t.Fatal(err)
	}
	_, err = store.Acquire(fixtureBinding())
	assertFailure(t, err, "containment_unknown")
	assertFailure(t, store.RecoverLocal(binding), "containment_unknown")
	record, err := store.read(binding.PhysicalWorktreeHash)
	if err != nil || record.State != "reserved" || record.RecoveryLocal {
		t.Fatal("abandoned reservation was released")
	}
}

func fixtureSleep(t *testing.T) (*exec.Cmd, Process) {
	t.Helper()
	command := exec.Command("/bin/sleep", "20")
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = command.Process.Kill(); _ = command.Wait() })
	table, err := InspectProcesses()
	if err != nil || !validRecordedProcess(table[command.Process.Pid]) {
		t.Fatal("missing fixture identity")
	}
	return command, table[command.Process.Pid]
}

func awaitAbsent(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		table, err := InspectProcesses()
		process, exists := table[pid]
		if err != nil {
			t.Fatal(err)
		}
		if !exists || process.Zombie {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("owned fixture did not exit")
}

func TestLockRequiresWholeGroupAbsenceBeforeRelease(t *testing.T) {
	store := fixtureLockStore(t)
	lock, err := store.Acquire(fixtureBinding())
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := lock.beginSpawn(); err != nil {
		t.Fatal(err)
	}
	_, leader := fixtureSleep(t)
	wrong := leader
	wrong.StartIdentity = "1:1"
	assertFailure(t, lock.Attach(wrong), "containment_unknown")
	if err = lock.Attach(leader); err != nil {
		t.Fatal(err)
	}
	assertFailure(t, lock.Attach(leader), "containment_unknown")
	assertFailure(t, lock.Release(), "containment_unknown")
	if observed, err := lock.Observe(); err != nil || observed.State != "live" || len(observed.Live) != 1 {
		t.Fatal("owned child not observed", err)
	}
	assertFailure(t, lock.Signal(syscall.SIGUSR1), "invalid_request")
	if err = lock.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	awaitAbsent(t, leader.PID)
	if err = lock.Release(); err != nil {
		t.Fatal(err)
	}
	record, err := store.read(lock.record.Binding.PhysicalWorktreeHash)
	if err != nil || record.State != "released" || record.Group == nil || record.RecoveryLocal {
		t.Fatal("ordinary release did not retain group identity")
	}
	// fixtureSleep reaps only after this test, reserving the leader throughout.
}

func TestCrashMarkerRetainsSurvivingOwnedProcess(t *testing.T) {
	testCrashMarker(t, false)
}

func TestCrashBetweenSpawnAndIdentityCannotRelease(t *testing.T) {
	testCrashMarker(t, true)
}

func testCrashMarker(t *testing.T, unrecorded bool) {
	t.Helper()
	store := fixtureLockStore(t)
	binding := fixtureBinding()
	encoded, _ := json.Marshal(binding)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestLockCrashFixture$", "-test.timeout=20s")
	command.Env = append(os.Environ(), "BFB_L05_LOCK_FIXTURE="+store.directory.file.Name(), "BFB_L05_LOCK_BINDING="+string(encoded))
	if unrecorded {
		command.Env = append(command.Env, "BFB_L05_LOCK_UNRECORDED=1")
	}
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = command.Process.Kill(); _ = command.Wait() }()
	scanner := bufio.NewScanner(output)
	if !scanner.Scan() {
		t.Fatal("crash fixture did not attach")
	}
	var leader Process
	if json.Unmarshal(scanner.Bytes(), &leader) != nil || !validRecordedProcess(leader) {
		t.Fatal("invalid fixture receipt")
	}
	t.Cleanup(func() {
		table, inspectErr := InspectProcesses()
		if inspectErr == nil && leader.Same(table[leader.PID]) && !table[leader.PID].Zombie {
			_ = syscall.Kill(leader.PID, syscall.SIGKILL)
		}
	})
	assertFailure(t, store.RecoverLocal(binding), "checkout_occupied")
	if err = command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = command.Wait()
	_, err = store.Acquire(fixtureBinding())
	assertFailure(t, err, "containment_unknown")
	assertFailure(t, store.RecoverLocal(binding), "containment_unknown")
	table, err := InspectProcesses()
	if err != nil || !leader.Same(table[leader.PID]) || table[leader.PID].Zombie {
		t.Fatal("fixture child did not outlive supervisor")
	}
	// The test created this exact process. Recovery itself never sends a signal.
	if err = syscall.Kill(leader.PID, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	awaitAbsent(t, leader.PID)
	if unrecorded {
		// Without a recorded start/ancestry, recovery cannot establish that
		// all potentially created descendants were observed and are gone.
		assertFailure(t, store.RecoverLocal(binding), "containment_unknown")
		return
	}
	wrong := binding
	wrong.AssignmentGeneration++
	assertFailure(t, store.RecoverLocal(wrong), "containment_unknown")
	if err = store.RecoverLocal(binding); err != nil {
		t.Fatal(err)
	}
	record, err := store.read(binding.PhysicalWorktreeHash)
	if err != nil || record.State != "released" || !record.RecoveryLocal || record.Group == nil {
		t.Fatal("missing explicit recovery proof")
	}
	lock, err := store.Acquire(fixtureBinding())
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err = lock.Release(); err != nil {
		t.Fatal(err)
	}
}

func TestLockCrashFixture(t *testing.T) {
	path := os.Getenv("BFB_L05_LOCK_FIXTURE")
	if path == "" {
		t.Skip("owned subprocess fixture")
	}
	var binding LockBinding
	if json.Unmarshal([]byte(os.Getenv("BFB_L05_LOCK_BINDING")), &binding) != nil {
		t.Fatal("invalid fixture binding")
	}
	store, err := OpenLockStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	lock, err := store.Acquire(binding)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := lock.beginSpawn(); err != nil {
		t.Fatal(err)
	}
	_, leader := fixtureSleep(t)
	if os.Getenv("BFB_L05_LOCK_UNRECORDED") == "" {
		if err = lock.Attach(leader); err != nil {
			t.Fatal(err)
		}
	}
	if err = json.NewEncoder(os.Stdout).Encode(leader); err != nil {
		t.Fatal(err)
	}
	select {}
}

func TestRecoveryRejectsReusedIdentitiesAndIncompleteHistory(t *testing.T) {
	for _, fault := range []string{"owner_reused", "child_reused", "unobserved_group_member", "incomplete", "missing_leader", "unknown_cleared"} {
		t.Run(fault, func(t *testing.T) {
			store := fixtureLockStore(t)
			binding := fixtureBinding()
			lock, err := store.Acquire(binding)
			if err != nil {
				t.Fatal(err)
			}
			if err = lock.Close(); err != nil {
				t.Fatal(err)
			}
			_, child := fixtureSleep(t)
			// These signed corruption cases test semantic validation after HMAC.
			record := lock.record
			record.Owner = fixtureProcess(2147483600, 1, 2147483600)
			leader := fixtureProcess(2147483601, record.Owner.PID, 2147483601)
			record.Group, _ = NewGroup(leader)
			record.Group.Unknown, record.State = true, "containment_unknown"
			switch fault {
			case "owner_reused":
				record.Owner.PID, record.Owner.StartIdentity = os.Getpid(), "1:1"
				record.Group.Leader.ParentPID = os.Getpid()
				record.Group.Observed[leader.PID] = record.Group.Leader
			case "child_reused":
				child.StartIdentity = "1:1"
				record.Group.Observed[child.PID] = child
			case "unobserved_group_member":
				record.Group.Leader.PID, record.Group.Leader.GroupID = child.GroupID, child.GroupID
				record.Group.Observed = map[int]Process{child.GroupID: record.Group.Leader}
			case "incomplete":
				record.Group.Incomplete = true
			case "missing_leader":
				record.Group.Observed = map[int]Process{}
			case "unknown_cleared":
				record.State = "owned"
			}
			if err = store.directory.write(lockName(binding.PhysicalWorktreeHash, ".json"), record); err != nil {
				t.Fatal(err)
			}
			assertFailure(t, store.RecoverLocal(binding), "containment_unknown")
			_, err = store.Acquire(fixtureBinding())
			assertFailure(t, err, "containment_unknown")
		})
	}
}

func TestSpawnBarrierRequiresARecordedChildOrProvenStartFailure(t *testing.T) {
	store := fixtureLockStore(t)
	lock, err := store.Acquire(fixtureBinding())
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	assertFailure(t, lock.cancelSpawn(), "containment_unknown")
	if err := lock.beginSpawn(); err != nil {
		t.Fatal(err)
	}
	record, err := store.read(lock.record.Binding.PhysicalWorktreeHash)
	if err != nil || !record.SpawnPending || record.Group != nil {
		t.Fatal("spawn barrier not durable", err)
	}
	assertFailure(t, lock.Release(), "containment_unknown")
	assertFailure(t, lock.beginSpawn(), "containment_unknown")
	if observed, err := lock.Observe(); err == nil || observed.State != "containment_unknown" {
		t.Fatal("pending spawn reported as never started")
	}
	if err := lock.cancelSpawn(); err != nil {
		t.Fatal(err)
	}
	if observed, err := lock.Observe(); err != nil || observed.State != "never_started" {
		t.Fatal("failed native start did not clear pending marker", err)
	}
	if err := lock.Release(); err != nil {
		t.Fatal(err)
	}
	for _, state := range []string{"owned", "released", "containment_unknown"} {
		record.State = state
		if record.valid() {
			t.Fatal("pending spawn accepted with contradictory state", state)
		}
	}
}
