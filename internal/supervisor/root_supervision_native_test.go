// ABOUTME: Exercises root-only signals and real kernel MCP ancestry with isolated synthetic subprocesses.
// ABOUTME: Proves detached survival and durable occupancy without provider execution or Terminal automation.

package supervisor

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/localmcp"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
)

type rootNativeReceipt struct {
	Detached Process
	Peer     Process
}

func TestRootSupervisionNativeSignalAndMCPAuthority(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
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
	if err != nil || lock.configureSupervision(provider.RootSupervision) != nil {
		t.Fatal("root mode was not bound before spawn", err)
	}
	defer lock.Close()
	if _, err := store.PinOwnership(ctx, assignment.IntentID, owner, lock.record.LockID, nil, now); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(ctx, executable, "-test.run=^TestRootSupervisionProcessFixture$", "-test.timeout=12s")
	command.Env = append(os.Environ(), "BFB_ROOT_PROCESS_FIXTURE=1")
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	output, err := command.StdoutPipe()
	if err != nil || command.Start() != nil {
		t.Fatal("synthetic root start failed", err)
	}
	defer func() { _ = command.Process.Kill(); _ = command.Wait() }()
	var receipt rootNativeReceipt
	if err := json.NewDecoder(output).Decode(&receipt); err != nil {
		t.Fatal(err)
	}
	for _, process := range []Process{receipt.Detached, receipt.Peer} {
		process := process
		t.Cleanup(func() {
			table, err := InspectProcesses()
			if err == nil && process.Same(table[process.PID]) {
				_ = syscall.Kill(process.PID, syscall.SIGKILL)
			}
		})
	}
	table, err = InspectProcesses()
	root := table[command.Process.Pid]
	if err != nil || root.ParentPID != os.Getpid() || receipt.Detached.GroupID == root.GroupID || receipt.Peer.GroupID != root.GroupID {
		t.Fatal("fixture did not form distinct groups", root, receipt, err)
	}
	if err := lock.Attach(root); err != nil {
		t.Fatal(err)
	}
	assignment, err = store.PinOwnership(ctx, assignment.IntentID, owner, lock.record.LockID, &root, now)
	if err != nil {
		t.Fatal(err)
	}
	files, err := OpenAssignmentFiles(local.Paths.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer files.Close()
	service := NewService(ServiceOptions{Now: func() time.Time { return now }, InspectHelper: func(peer daemon.Peer) (SupervisorIdentity, error) {
		if peer.PID != owner.Process.PID || peer.UID != owner.Process.UID {
			return SupervisorIdentity{}, failure("peer_denied")
		}
		return owner, nil // Synthetic signature seam; kernel/marker/flock are real.
	}})
	service.store, service.files, service.paths = store, files, local.Paths
	close(service.ready)
	inspector := service.nativeInspector(local.Paths, files)
	if err := service.checkAgentOwnership(ctx, claim.Assignment.RunExecutionId, claim.Assignment.AssignmentGeneration, inspector); err != nil {
		t.Fatal("detached hook closed live root ownership", err)
	}
	input := generated.AgentLocalRequest{Correlation: assignment.CorrelationToken, Request: generated.AgentWorkRequest{SchemaVersion: 1, RunExecutionId: claim.Assignment.RunExecutionId, AssignmentGeneration: claim.Assignment.AssignmentGeneration, RequestId: "synthetic-root-peer"}}
	request := daemon.Request{Store: local, Peer: daemon.Peer{UID: os.Getuid(), PID: receipt.Peer.PID}}
	if _, _, err := localmcp.VerifyDaemonCaller(ctx, request, input); err != nil {
		t.Fatal("actual root descendant MCP peer denied", err)
	}
	for _, pid := range []int{os.Getpid(), receipt.Detached.PID} {
		request.Peer.PID = pid
		if _, _, err := localmcp.VerifyDaemonCaller(ctx, request, input); localmcp.CodeOf(err) != "peer_denied" {
			t.Fatal("foreign or detached peer received root authority", pid, err)
		}
	}
	request.Peer.PID = receipt.Peer.PID
	if err := lock.Signal(syscall.SIGTERM); err != nil {
		t.Fatal("verified original-group signal denied", err)
	}
	if err := command.Wait(); err != nil {
		t.Fatal("synthetic root did not receive TERM", err)
	}
	table, err = InspectProcesses()
	if err != nil || !receipt.Detached.Same(table[receipt.Detached.PID]) || table[receipt.Detached.PID].Zombie || !receipt.Peer.Same(table[receipt.Peer.PID]) || table[receipt.Peer.PID].Zombie {
		t.Fatal("root signal reached detached group or fixture peer unexpectedly", err)
	}
	if _, _, err := localmcp.VerifyDaemonCaller(ctx, request, input); err == nil {
		t.Fatal("live peer outlived original root authority")
	}
	if err := service.checkAgentOwnership(ctx, claim.Assignment.RunExecutionId, claim.Assignment.AssignmentGeneration, inspector); daemon.AsFailure(err).Code != "containment_unknown" {
		t.Fatal("root exit retained agent ownership", err)
	}
	assertFailure(t, lock.Release(), "containment_unknown")
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenLockStore(worktreeLocksPath(local.Paths))
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	record, err := reopened.read(assignment.lockBinding().PhysicalWorktreeHash)
	if err != nil || record.SupervisionMode != provider.RootSupervision || record.State == "released" {
		t.Fatal("restart discarded root lifetime fence", record, err)
	}
	assertFailure(t, reopened.recoverLocal(assignment.lockBinding(), record.Group), "containment_unknown")
	_, err = reopened.Acquire(assignment.lockBinding())
	assertFailure(t, err, "containment_unknown")
}

func TestRootSupervisionProcessFixture(t *testing.T) {
	if os.Getenv("BFB_ROOT_PROCESS_FIXTURE") != "1" {
		t.Skip("subprocess-only fixture")
	}
	interrupts := make(chan os.Signal, 1)
	signal.Notify(interrupts, syscall.SIGTERM)
	defer signal.Stop(interrupts)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	var receipt rootNativeReceipt
	for _, detached := range []bool{true, false} {
		child := exec.Command(executable, "-test.run=^TestRootSupervisionPeerFixture$", "-test.timeout=30s")
		child.Env = append(os.Environ(), "BFB_ROOT_PEER_FIXTURE=1")
		child.SysProcAttr = &syscall.SysProcAttr{Setpgid: detached}
		output, err := child.StdoutPipe()
		if err != nil || child.Start() != nil {
			t.Fatal("synthetic child start failed", err)
		}
		var process Process
		if err := json.NewDecoder(output).Decode(&process); err != nil {
			t.Fatal(err)
		}
		if detached {
			receipt.Detached = process
		} else {
			receipt.Peer = process
		}
	}
	if err := json.NewEncoder(os.Stdout).Encode(receipt); err != nil {
		t.Fatal(err)
	}
	<-interrupts
}

func TestRootSupervisionPeerFixture(t *testing.T) {
	if os.Getenv("BFB_ROOT_PEER_FIXTURE") != "1" {
		t.Skip("subprocess-only fixture")
	}
	signal.Ignore(syscall.SIGTERM)
	table, err := InspectProcesses()
	if err != nil || json.NewEncoder(os.Stdout).Encode(table[os.Getpid()]) != nil {
		t.Fatal("synthetic peer identity unavailable", err)
	}
	time.Sleep(20 * time.Second)
}

func TestRootSupervisionGateSealsModeBeforeProviderAcknowledgement(t *testing.T) {
	for _, failHistory := range []bool{false, true} {
		t.Run(map[bool]string{false: "sealed", true: "storage_denied"}[failHistory], func(t *testing.T) {
			fixture := finalFixture(t)
			if err := fixture.lock.configureSupervision(provider.RootSupervision); err != nil {
				t.Fatal(err)
			}
			if _, err := fixture.call("execution.authorize", fixture.payload()); err != nil {
				t.Fatal(err)
			}
			child := ownedGateTestChild(t)
			if err := fixture.lock.Attach(child); err != nil {
				t.Fatal(err)
			}
			if failHistory {
				if _, err := fixture.store.db.Exec(`CREATE TRIGGER synthetic_mode_storage BEFORE INSERT ON execution_native_history BEGIN SELECT RAISE(ABORT,'synthetic unavailable'); END`); err != nil {
					t.Fatal(err)
				}
			}
			payload := fixture.payload()
			payload["process_group_id"] = child.GroupID
			_, err := fixture.call("execution.group", payload)
			if failHistory {
				if daemon.AsFailure(err).Code != "storage_failed" {
					t.Fatal("unsealed mode acknowledged provider gate", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			record, err := (localmcp.DaemonAssignments{DB: fixture.local.DB}).Lookup(context.Background(), fixture.assignment.Claim.Assignment.RunExecutionId, fixture.assignment.Claim.Assignment.AssignmentGeneration)
			if err != nil || !record.RootSupervision || !record.Active {
				t.Fatal("acknowledged exec gate left first MCP caller in strict mode", record, err)
			}
		})
	}
}
