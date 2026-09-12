// ABOUTME: Gates a fixed signed child on private inherited pipes before its locally compiled provider exec.
// ABOUTME: Binds a short-lived permit to the registered parent, exact child and durably recorded worktree lock.

package supervisor

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"github.com/qdis/bfb/internal/checkout"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
	"golang.org/x/sys/unix"
)

const gatePreparationLimit = 30 * time.Second
const gatePermitLimit = 5 * time.Second
const gateMessageLimit = 2048

func worktreeLocksPath(paths daemon.Paths) string { return filepath.Join(paths.Root, "worktree-locks") }

type gateReady struct {
	Version  int    `json:"version"`
	IntentID string `json:"intent_id"`
	Nonce    string `json:"nonce"`
}

type gatePermit struct {
	Ready        gateReady `json:"ready"`
	Child        Process   `json:"child"`
	LockID       string    `json:"lock_id"`
	AuthorizedAt string    `json:"authorized_at"`
	ExpiresAt    string    `json:"expires_at"`
}

func readGate(file *os.File, value any, deadline time.Time) error {
	if err := file.SetReadDeadline(deadline); err != nil {
		return failure("execution_assignment_invalid")
	}
	data, err := io.ReadAll(io.LimitReader(file, gateMessageLimit+1))
	if err != nil || len(data) == 0 || len(data) > gateMessageLimit || strictPrivateJSON(data, value) != nil {
		return failure("execution_assignment_invalid")
	}
	canonical, err := json.Marshal(value)
	if err != nil || !bytes.Equal(canonical, data) {
		return failure("execution_assignment_invalid")
	}
	return nil
}

func writeGate(file *os.File, value any, deadline time.Time) error {
	data, err := json.Marshal(value)
	if err != nil || len(data) > gateMessageLimit || file.SetWriteDeadline(deadline) != nil {
		return failure("execution_assignment_invalid")
	}
	if written, err := file.Write(data); err != nil || written != len(data) {
		return failure("execution_assignment_invalid")
	}
	return file.Close() // EOF is mandatory: a partial or extended frame is not a permit.
}

func inheritedGate(fd, access int) (*os.File, error) {
	var stat unix.Stat_t
	flags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
	if err != nil || flags&unix.O_ACCMODE != access || unix.Fstat(fd, &stat) != nil || stat.Mode&unix.S_IFMT != unix.S_IFIFO || stat.Uid != uint32(os.Getuid()) {
		return nil, failure("peer_denied")
	}
	unix.CloseOnExec(fd)
	// An inherited pipe is blocking after exec. Mark it nonblocking before
	// NewFile so Go can enforce preparation and permit read deadlines.
	if unix.SetNonblock(fd, true) != nil {
		return nil, failure("peer_denied")
	}
	return os.NewFile(uintptr(fd), "private-execution-gate"), nil
}

func gateParent(assignment generated.LocalExecutionAssignment, inspect func(daemon.Peer) (SupervisorIdentity, error)) (Process, error) {
	table, err := InspectProcesses()
	self := table[os.Getpid()]
	if err != nil || !validRecordedProcess(self) || self.Zombie || self.GroupID != self.PID || self.ParentPID != int(assignment.Supervisor.Pid) {
		return Process{}, failure("peer_denied")
	}
	parent, err := inspect(daemon.Peer{UID: os.Getuid(), PID: self.ParentPID})
	if err != nil || parent.wire() != assignment.Supervisor || parent.Process.Zombie {
		return Process{}, failure("peer_denied")
	}
	return self, nil
}

func (permit gatePermit) valid(ready gateReady, child Process, assignment generated.LocalExecutionAssignment, now time.Time) bool {
	authorized, first := time.Parse(time.RFC3339Nano, permit.AuthorizedAt)
	expires, second := time.Parse(time.RFC3339Nano, permit.ExpiresAt)
	deadline, third := launchDeadline(assignment, now)
	return permit.Ready == ready && ready.Version == 1 && ready.IntentID == assignment.TerminalIntentId && terminalIntent.MatchString(ready.Nonce) &&
		permit.Child == child && executionID.MatchString(permit.LockID) && first == nil && second == nil && third == nil &&
		!now.Before(authorized) && now.Before(expires) && expires.After(authorized) && expires.Sub(authorized) <= gatePermitLimit && !expires.After(deadline)
}

// The child independently verifies authenticated durable ownership and a live
// flock holder. A valid-looking pipe permit cannot substitute for either fact.
func verifyGateLock(paths daemon.Paths, assignment generated.LocalExecutionAssignment, permit gatePermit) error {
	directory, err := openExistingPrivateDirectory(worktreeLocksPath(paths))
	if err != nil {
		return failure("containment_unknown")
	}
	defer directory.file.Close()
	store := &LockStore{directory: directory}
	claim := assignment.Claim
	binding := LockBinding{ExecutionID: claim.Assignment.RunExecutionId, AssignmentGeneration: claim.Assignment.AssignmentGeneration, FencingGeneration: claim.FencingGeneration, PhysicalWorktreeHash: claim.Snapshot.PhysicalWorktreeHash}
	record, err := store.read(binding.PhysicalWorktreeHash)
	if err != nil || record.State != "owned" || record.Binding != binding || record.LockID != permit.LockID || record.Owner.PID != int(assignment.Supervisor.Pid) || record.Owner.StartIdentity != assignment.Supervisor.StartIdentity || record.Group == nil || record.Group.Leader != permit.Child {
		return failure("containment_unknown")
	}
	fence, err := directory.open(lockName(binding.PhysicalWorktreeHash, ".lock"), unix.O_RDONLY)
	if err != nil {
		return failure("containment_unknown")
	}
	defer fence.Close()
	if err := unix.Flock(int(fence.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != unix.EWOULDBLOCK {
		return failure("containment_unknown")
	}
	return nil
}

// RunExecChild is reachable only through the fixed local __exec entry point.
// Neither descriptor numbers nor an invocation are accepted in its arguments.
func RunExecChild(ctx context.Context, paths daemon.Paths, intent string, registry *provider.Registry) error {
	return runExecChild(ctx, paths, intent, registry, InspectHelper, syscall.Exec)
}

func runExecChild(ctx context.Context, paths daemon.Paths, intent string, registry *provider.Registry, inspect func(daemon.Peer) (SupervisorIdentity, error), execute func(string, []string, []string) error) error {
	if !terminalIntent.MatchString(intent) {
		return failure("invalid_request")
	}
	gate, err := inheritedGate(3, unix.O_RDONLY)
	if err != nil {
		return err
	}
	defer gate.Close()
	readyPipe, err := inheritedGate(4, unix.O_WRONLY)
	if err != nil {
		return err
	}
	defer readyPipe.Close()
	// Authenticate before opening private assignment or checkout state.
	if _, err := inspect(daemon.Peer{UID: os.Getuid(), PID: os.Getppid()}); err != nil {
		return failure("peer_denied")
	}
	files, err := ReadAssignmentFiles(paths.Root)
	if err != nil {
		return err
	}
	assignment, err := files.Read(intent)
	_ = files.Close()
	if err != nil {
		return err
	}
	child, err := gateParent(assignment, inspect)
	if err != nil {
		return err
	}
	deadline, err := launchDeadline(assignment, time.Now())
	if err != nil {
		return err
	}
	if local := time.Now().Add(gatePreparationLimit); local.Before(deadline) {
		deadline = local
	}
	ctx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	stop := context.AfterFunc(ctx, func() { _ = gate.Close(); _ = readyPipe.Close() })
	defer stop()
	execution, err := loadExecution(ctx, paths, assignment, registry, os.Environ())
	if err != nil {
		return err
	}
	defer execution.db.Close()
	nonce, err := newIntentID()
	if err != nil {
		return err
	}
	ready := gateReady{Version: 1, IntentID: intent, Nonce: nonce}
	if err := writeGate(readyPipe, ready, deadline); err != nil {
		return err
	}
	var permit gatePermit
	if err := readGate(gate, &permit, deadline); err != nil || !permit.valid(ready, child, assignment, time.Now()) {
		return failure("execution_assignment_invalid")
	}
	if err := execution.revalidate(ctx); err != nil {
		return err
	}
	if err := verifyGateLock(paths, assignment, permit); err != nil {
		return err
	}
	current, err := gateParent(assignment, inspect)
	if err != nil || current != child || !permit.valid(ready, current, assignment, time.Now()) || ctx.Err() != nil {
		return failure("peer_denied")
	}
	invocation := execution.plan.Invocation()
	environment, err := execution.preparation.Environment(assignment, invocation.Environment)
	if err != nil {
		return err
	}
	workingDirectory, err := checkout.OpenExecutionDirectory(execution.checkout.Location)
	if err != nil {
		return err
	}
	defer workingDirectory.Close()
	if execution.db.Close() != nil || gate.Close() != nil {
		return failure("storage_failed")
	}
	if workingDirectory.Chdir() != nil || workingDirectory.Close() != nil {
		return failure("checkout_identity_changed")
	}
	// No subprocess runs between this last source check and provider exec.
	if err := execution.registry.RevalidateSources(execution.plan, time.Now()); err != nil {
		return err
	}
	if !permit.valid(ready, child, assignment, time.Now()) {
		return failure("expired_intent")
	}
	if _, err := gateParent(assignment, inspect); err != nil {
		return err
	}
	if err := execute(invocation.Executable, append([]string{invocation.Executable}, invocation.Arguments...), environment); err != nil {
		return failure("provider_unavailable")
	}
	return nil
}

// GateCallbacks are local service dependencies, never RPC-supplied functions.
// Authorize must obtain a fresh successful C09 final authorization. RecordGroup
// must durably register the kernel-derived group before the permit is written.
type GateCallbacks struct {
	Authorize   func(context.Context, generated.LaunchFinalRequest) error
	RecordGroup func(context.Context, generated.LocalExecutionAssignment, string, Process) error
}

type gatedProcess struct {
	command *exec.Cmd
	leader  Process
	lock    *WorktreeLock
}

func finalRequest(assignment generated.LocalExecutionAssignment, lockID string) generated.LaunchFinalRequest {
	claim := assignment.Claim
	spec := claim.Specification
	return generated.LaunchFinalRequest{SchemaVersion: 1, LaunchId: spec.LaunchId, RunExecutionId: spec.RunExecutionId, AssignmentGeneration: spec.AssignmentGeneration, FencingGeneration: claim.FencingGeneration, ConfigSnapshotId: spec.ConfigSnapshotId, ConfigSnapshotHash: spec.ConfigSnapshotHash, RepositoryConfigHash: claim.Snapshot.RepositoryConfigHash, PhysicalWorktreeHash: claim.Snapshot.PhysicalWorktreeHash, Supervisor: assignment.Supervisor, LocalLockId: lockID}
}

// startGated returns the child whenever process creation succeeded, including
// on a later error. The supervisor must observe that child through group end
// before reaping it; closing a gate alone is not proof of process absence.
func startGated(ctx context.Context, execution *preparedExecution, lock *WorktreeLock, tty *os.File, callbacks GateCallbacks, childCommand func() *exec.Cmd, inspect func(daemon.Peer) (SupervisorIdentity, error)) (*gatedProcess, error) {
	if callbacks.Authorize == nil || callbacks.RecordGroup == nil || tty == nil {
		return nil, failure("invalid_request")
	}
	if err := execution.revalidate(ctx); err != nil {
		return nil, err
	}
	lock.mu.Lock()
	err := lock.check()
	record := lock.record
	lock.mu.Unlock()
	claim := execution.assignment.Claim
	binding := LockBinding{ExecutionID: claim.Assignment.RunExecutionId, AssignmentGeneration: claim.Assignment.AssignmentGeneration, FencingGeneration: claim.FencingGeneration, PhysicalWorktreeHash: claim.Snapshot.PhysicalWorktreeHash}
	if err != nil || record.Binding != binding || record.State != "reserved" || record.Group != nil || record.Owner.PID != int(execution.assignment.Supervisor.Pid) || record.Owner.StartIdentity != execution.assignment.Supervisor.StartIdentity {
		return nil, failure("containment_unknown")
	}
	request := finalRequest(execution.assignment, record.LockID)
	// Bind C09's release-proof identity before creating any owned group.
	if err := callbacks.Authorize(ctx, request); err != nil {
		return nil, err
	}
	gateRead, gateWrite, err := os.Pipe()
	if err != nil {
		return nil, failure("storage_failed")
	}
	defer gateRead.Close()
	defer gateWrite.Close()
	readyRead, readyWrite, err := os.Pipe()
	if err != nil {
		return nil, failure("storage_failed")
	}
	defer readyRead.Close()
	defer readyWrite.Close()
	command := childCommand()
	command.ExtraFiles = []*os.File{gateRead, readyWrite}
	command.Stdin, command.Stdout, command.Stderr = tty, tty, tty
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Foreground: true, Ctty: int(tty.Fd())}
	if err := command.Start(); err != nil {
		return nil, failure("execution_terminal_lost")
	}
	process := &gatedProcess{command: command, lock: lock}
	_ = gateRead.Close()
	_ = readyWrite.Close()
	deadline := time.Now().Add(gatePreparationLimit)
	if launch, err := launchDeadline(execution.assignment, time.Now()); err != nil {
		return process, err
	} else if launch.Before(deadline) {
		deadline = launch
	}
	// Cancellation closes the pipe and forbids exec, including while a read
	// waits for a child's preparation to finish.
	stop := context.AfterFunc(ctx, func() { _ = gateWrite.Close(); _ = readyRead.Close() })
	defer stop()
	identity, err := inspect(daemon.Peer{UID: os.Getuid(), PID: command.Process.Pid})
	if err != nil || identity.ExecutableHash != execution.assignment.Supervisor.ExecutableHash || identity.Process.ParentPID != os.Getpid() || identity.Process.GroupID != identity.Process.PID {
		return process, failure("peer_denied")
	}
	process.leader = identity.Process
	if err := lock.Attach(process.leader); err != nil {
		return process, err
	}
	// Record the waiting wrapper even if its preparation fails. Provider
	// containment observations begin only after its bounded probes have ended.
	var ready gateReady
	if err := readGate(readyRead, &ready, deadline); err != nil || ready.Version != 1 || ready.IntentID != execution.assignment.TerminalIntentId || !terminalIntent.MatchString(ready.Nonce) {
		return process, failure("execution_assignment_invalid")
	}
	if err := callbacks.RecordGroup(ctx, execution.assignment, record.LockID, process.leader); err != nil {
		return process, err
	}
	if err := execution.revalidate(ctx); err != nil {
		return process, err
	}
	if err := execution.registry.Revalidate(ctx, execution.plan, time.Now()); err != nil {
		return process, err
	}
	if err := callbacks.Authorize(ctx, request); err != nil {
		return process, err
	}
	current, err := inspect(daemon.Peer{UID: os.Getuid(), PID: process.leader.PID})
	if err != nil || current.Process != process.leader || current.ExecutableHash != identity.ExecutableHash || ctx.Err() != nil {
		return process, failure("peer_denied")
	}
	if observation, err := lock.Observe(); err != nil || observation.State != "live" {
		return process, failure("containment_unknown")
	}
	now := time.Now()
	expires := now.Add(gatePermitLimit)
	if deadline.Before(expires) {
		expires = deadline
	}
	permit := gatePermit{Ready: ready, Child: process.leader, LockID: record.LockID, AuthorizedAt: localTimestamp(now), ExpiresAt: localTimestamp(expires)}
	if !permit.valid(ready, process.leader, execution.assignment, now) {
		return process, failure("expired_intent")
	}
	return process, writeGate(gateWrite, permit, expires)
}
