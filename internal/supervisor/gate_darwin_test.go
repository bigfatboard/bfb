// ABOUTME: Runs the execution gate across actual child processes and native controlling PTYs.
// ABOUTME: Proves durable-group ordering, final-authority failures and pre-exec swaps without Terminal automation.

//go:build darwin && cgo

package supervisor

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/checkout"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers/fake"
	"golang.org/x/sys/unix"
)

// This inspector exists only in a compiled test. Signed identity is exercised
// separately by the native helper harness, never bypassed in the CLI.
func gateFixtureInspector(peer daemon.Peer) (SupervisorIdentity, error) {
	table, err := InspectProcesses()
	process := table[peer.PID]
	if err != nil || !validRecordedProcess(process) || process.Zombie || peer.UID != os.Getuid() {
		return SupervisorIdentity{}, failure("peer_denied")
	}
	return SupervisorIdentity{Process: process, ExecutableHash: provider.Hash([]byte("synthetic-helper-build"))}, nil
}

func TestNativeGatedPTY(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "bfb-fake-provider")
	if output, err := exec.Command("go", "build", "-o", binary, "../../cmd/bfb-fake-provider").CombinedOutput(); err != nil {
		t.Fatalf("fake build: %v %s", err, output)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []string{"success", "first_authorization", "final_authorization", "record_failure", "binary_swap", "configuration_swap", "artifact_swap", "working_directory_swap", "lock_abandoned", "child_parent_mismatch", "parent_loss"} {
		t.Run(scenario, func(t *testing.T) {
			stateRoot, err := os.MkdirTemp("/tmp", "bfb-gate-test-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.RemoveAll(stateRoot) })
			ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, "/usr/bin/script", "-q", "-F", filepath.Join(t.TempDir(), "synthetic-gate.txt"), self, "-test.run=^TestNativeGatedPTYFixture$", "-test.timeout=30s")
			for _, entry := range NormalEnvironment(os.Environ()) {
				if !strings.HasPrefix(entry, "TMPDIR=") {
					command.Env = append(command.Env, entry)
				}
			}
			command.Env = append(command.Env, "BFB_GATE_FIXTURE="+scenario, "BFB_GATE_FAKE="+binary, "BFB_GATE_STATE_ROOT="+stateRoot, "TMPDIR="+stateRoot)
			command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
			input, err := command.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			output, err := command.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			command.Stderr = command.Stdout
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { _ = input.Close(); _ = command.Process.Kill(); _ = command.Wait() }()
			lines := make(chan string, 128)
			go func() {
				defer close(lines)
				scanner := bufio.NewScanner(io.LimitReader(output, 32768))
				for scanner.Scan() {
					lines <- scanner.Text()
				}
			}()
			var trace strings.Builder
			var lostParent struct {
				Phase    string  `json:"phase"`
				Process  Process `json:"process"`
				Child    Process `json:"child"`
				Physical string  `json:"physical_worktree_hash"`
			}
			started, verified, restored := false, false, false
			for !restored {
				select {
				case <-ctx.Done():
					t.Fatalf("gate fixture timed out: %s", trace.String())
				case line, ok := <-lines:
					if !ok {
						if scenario == "parent_loss" && lostParent.Phase == "gate_parent_waiting" {
							verifyLostGateParent(t, stateRoot, lostParent.Physical, lostParent.Process, lostParent.Child)
							restored = true
							continue
						}
						t.Fatalf("gate fixture ended before verification: %s", trace.String())
					}
					if trace.Len() < 8192 {
						trace.WriteString(line + "\n")
					}
					var phase ptyPhase
					_ = json.Unmarshal([]byte(strings.TrimSpace(line)), &phase)
					if scenario == "parent_loss" && phase.Phase == "gate_parent_waiting" {
						if json.Unmarshal([]byte(strings.TrimSpace(line)), &lostParent) != nil {
							t.Fatal("invalid parent-loss trace")
						}
						killFixture(t, phase.Process)
					}
					if strings.Contains(line, "gated_exec_verified") {
						verified = true
					}
					if strings.Contains(line, `"kind":"session_started"`) {
						started = true
						if scenario == "success" {
							_, _ = input.Write([]byte{3})
						}
					}
					if strings.Contains(line, "gate_fixture_passed") {
						restored = true
					}
				}
			}
			if (scenario == "success") != started || started != verified {
				t.Fatalf("provider exec disposition mismatch: %s", trace.String())
			}
			_, markerErr := os.Stat(filepath.Join(stateRoot, "exec-observed"))
			if scenario == "success" && markerErr != nil || scenario != "success" && !os.IsNotExist(markerErr) {
				t.Fatal("provider exec canary disposition mismatch", markerErr)
			}
		})
	}
}

func verifyLostGateParent(t *testing.T, root, physical string, parent, child Process) {
	t.Helper()
	paths, err := daemon.StatePaths(root)
	if err != nil {
		t.Fatal(err)
	}
	directory, err := openExistingPrivateDirectory(worktreeLocksPath(paths))
	if err != nil {
		t.Fatal(err)
	}
	locks := &LockStore{directory: directory}
	defer locks.Close()
	record, err := locks.read(physical)
	if err != nil || record.State != "owned" || record.Owner != parent || record.Group == nil || record.Group.Leader != child {
		t.Fatal("parent loss did not retain durable group", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		table, err := InspectProcesses()
		if err != nil {
			t.Fatal(err)
		}
		owner, present := table[parent.PID]
		if (!present || owner.Zombie) && record.Group.ProveGone(table) {
			return
		}
		if !time.Now().Before(deadline) {
			t.Fatal("denied gate survived parent loss")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func gateFixture(t *testing.T) (*preparedExecution, *WorktreeLock, string) {
	t.Helper()
	store, local, claim, _ := fixtureIntentsAt(t, os.Getenv("BFB_GATE_STATE_ROOT"))
	root := t.TempDir()
	cwd := filepath.Join(root, "packages", "api")
	if err := os.MkdirAll(cwd, 0700); err != nil {
		t.Fatal(err)
	}
	for _, arguments := range [][]string{{"init", "--initial-branch=main"}, {"remote", "add", "origin", "https://github.com/synthetic/gate.git"}} {
		command := exec.Command("/usr/bin/git", arguments...)
		command.Dir, command.Env = root, []string{"PATH=/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null"}
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("fixture Git: %v %s", err, output)
		}
	}
	record, err := checkout.NewRegistry(local.DB).Link(context.Background(), checkout.LinkInput{WorkspaceID: claim.Assignment.WorkspaceId, RunnerID: claim.Assignment.RunnerId, ProjectID: claim.Assignment.ProjectId, Path: cwd, WorkspaceSubpath: "packages/api", RepositoryIdentity: "github.com/synthetic/gate", Label: "Synthetic gate"})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(os.Getenv("BFB_GATE_FAKE"))
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(t.TempDir(), "provider")
	if err := os.WriteFile(binary, raw, 0700); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(t.TempDir(), "provider.json")
	if err := os.WriteFile(config, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	registry, err := provider.NewRegistry([]provider.Descriptor{fake.Descriptor()})
	if err != nil {
		t.Fatal(err)
	}
	probe, err := registry.Probe(context.Background(), "fake", provider.Installation{Executable: binary, ConfigFiles: []provider.ConfigSource{{Name: "user", Path: config}}, IntegrationHash: provider.Hash(nil), Environment: NormalEnvironment(os.Environ())}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	claim.Assignment.CreatedAt = localTimestamp(now)
	claim.Specification.ExpiresAt = localTimestamp(now.Add(120 * time.Second))
	claim.LeaseExpiresAt = localTimestamp(now.Add(45 * time.Second))
	claim.Assignment.CheckoutId, claim.Specification.CheckoutId = record.Summary.CheckoutId, record.Summary.CheckoutId
	claim.Snapshot.PhysicalWorktreeHash = record.Summary.PhysicalWorktreeHash
	claim.Snapshot.RepositoryIdentityHash = provider.Hash([]byte(record.Summary.RepositoryIdentity))
	claim.Snapshot.RepositoryConfigHash = record.Summary.RepositoryConfigHash
	claim.Snapshot.ProviderVersion, claim.Snapshot.ProviderManifestId = probe.Version, probe.ManifestID
	policy := map[string]any{"allowed_providers": []string{"fake"}, "allow_agent_root_propose": false, "allow_pass_to_agent": true, "allow_run_overrides": false}
	claim.Snapshot.WorkspacePolicy, claim.Snapshot.ProjectPolicy, claim.Snapshot.RepositoryPolicy = policy, policy, policy
	claim.Specification.ExecutionConfig = generated.ExecutionConfig{Provider: "fake", Mode: "interactive", Model: "synthetic", Effort: "low", ApprovalPolicy: "never", FilesystemPolicy: "read_only", ContextInjection: "none", InitialTurnTransport: "provider_prompt", RequiredCapabilities: []string{"launch.interactive"}}
	claim.Snapshot.ExecutionConfig = claim.Specification.ExecutionConfig
	claim.Specification.ConfigSnapshotHash, err = snapshotHash(claim.Snapshot)
	if err != nil {
		t.Fatal(err)
	}
	identity, err := registry.IdentityHash(probe)
	if err != nil {
		t.Fatal(err)
	}
	draft, err := store.Issue(context.Background(), acceptFixture(t, store, claim, now), claim, identity, now)
	if err != nil {
		t.Fatal(err)
	}
	files, err := OpenAssignmentFiles(local.Paths.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer files.Close()
	if _, err := files.Prepare(draft, registry, probe, record.Location.GitRoot); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Offer(context.Background(), draft.IntentID); err != nil {
		t.Fatal(err)
	}
	supervisor, err := gateFixtureInspector(daemon.Peer{UID: os.Getuid(), PID: os.Getpid()})
	if err != nil {
		t.Fatal(err)
	}
	registered, err := store.Register(context.Background(), draft.IntentID, supervisor, now)
	if err != nil {
		t.Fatal(err)
	}
	wire, err := registered.wire()
	if err != nil {
		t.Fatal(err)
	}
	if err := files.Publish(wire); err != nil {
		t.Fatal(err)
	}
	execution, err := loadExecution(context.Background(), local.Paths, wire, registry, os.Environ())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = execution.db.Close() })
	locks, err := OpenLockStore(worktreeLocksPath(local.Paths))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = locks.Close() })
	lock, err := locks.Acquire(LockBinding{ExecutionID: claim.Assignment.RunExecutionId, AssignmentGeneration: claim.Assignment.AssignmentGeneration, FencingGeneration: claim.FencingGeneration, PhysicalWorktreeHash: claim.Snapshot.PhysicalWorktreeHash})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lock.Close() })
	return execution, lock, config
}

func TestNativeGatedPTYFixture(t *testing.T) {
	scenario := os.Getenv("BFB_GATE_FIXTURE")
	if scenario == "" {
		t.Skip("subprocess-only controlling PTY fixture")
	}
	terminal, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer terminal.Close()
	foreground, err := unix.IoctlGetInt(int(terminal.Fd()), unix.TIOCGPGRP)
	if err != nil || foreground != syscall.Getpgrp() {
		t.Fatal("fixture is not foreground", err)
	}
	execution, lock, configuration := gateFixture(t)
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	authorizations, recordings := 0, 0
	callbacks := GateCallbacks{
		Authorize: func(_ context.Context, request generated.LaunchFinalRequest) error {
			authorizations++
			if request.LocalLockId != lock.record.LockID || request.Supervisor != execution.assignment.Supervisor {
				t.Fatal("wrong final identity")
			}
			if scenario == "first_authorization" || scenario == "final_authorization" && authorizations == 2 {
				return failure("peer_denied")
			}
			return nil
		},
		RecordGroup: func(_ context.Context, assignment generated.LocalExecutionAssignment, lockID string, leader Process) error {
			recordings++
			durable, err := lock.store.read(lock.record.Binding.PhysicalWorktreeHash)
			if err != nil || durable.Group == nil || durable.Group.Leader != leader || durable.LockID != lockID || assignment.TerminalIntentId != execution.assignment.TerminalIntentId {
				t.Fatal("group not durable before service callback", err)
			}
			switch scenario {
			case "parent_loss":
				_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"phase": "gate_parent_waiting", "process": lock.record.Owner, "child": leader, "physical_worktree_hash": lock.record.Binding.PhysicalWorktreeHash})
				<-time.After(20 * time.Second) // Outer fixture kills this exact parent before permission.
				return failure("peer_denied")
			case "record_failure":
				return failure("storage_failed")
			case "binary_swap":
				if err := os.Rename(execution.preparation.Provider.Executable, execution.preparation.Provider.Executable+".original"); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(execution.preparation.Provider.Executable, []byte("#!/bin/sh\nexit 99\n"), 0700); err != nil {
					t.Fatal(err)
				}
			case "configuration_swap":
				if err := os.WriteFile(configuration, []byte(`{"changed":true}`), 0600); err != nil {
					t.Fatal(err)
				}
			case "artifact_swap":
				path := execution.preparation.Artifacts.Path
				if err := os.Rename(path, path+".original"); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			case "working_directory_swap":
				path := execution.checkout.Location.WorkingDirectory
				if err := os.Rename(path, path+".original"); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			case "lock_abandoned":
				if err := lock.Close(); err != nil {
					t.Fatal(err)
				}
			}
			return nil
		},
	}
	process, startErr := startGated(context.Background(), execution, lock, terminal, callbacks, func() *exec.Cmd {
		command := exec.Command(self, "-test.run=^TestNativeGatedChild$", "-test.timeout=25s")
		command.Env = append(os.Environ(), "BFB_GATE_CHILD=1", "BFB_GATE_ROOT="+execution.paths.Root, "BFB_GATE_INTENT="+execution.assignment.TerminalIntentId)
		return command
	}, gateFixtureInspector)
	if (scenario == "success") != (startErr == nil) {
		t.Fatal("unexpected start disposition", startErr)
	}
	if scenario == "first_authorization" {
		if process != nil || authorizations != 1 || recordings != 0 {
			t.Fatal("child created without first authorization")
		}
		if err := lock.Release(); err != nil {
			t.Fatal(err)
		}
		fmt.Println("gate_fixture_passed")
		return
	}
	expectedRecordings := 1
	if scenario == "child_parent_mismatch" {
		expectedRecordings = 0
	}
	if process == nil || process.leader.PID == 0 || recordings != expectedRecordings {
		t.Fatal("missing recorded child", startErr)
	}
	defer func() {
		table, err := InspectProcesses()
		if err == nil && process.leader.Same(table[process.leader.PID]) {
			_ = syscall.Kill(process.leader.PID, syscall.SIGKILL)
		}
		_ = process.command.Wait()
	}()
	deadline := time.Now().Add(10 * time.Second)
	for {
		table, err := InspectProcesses()
		if err != nil {
			t.Fatal(err)
		}
		if lock.record.Group.ProveGone(table) {
			break
		}
		if !time.Now().Before(deadline) {
			t.Fatal("gate child did not end")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if scenario != "lock_abandoned" {
		if err := lock.Release(); err != nil {
			t.Fatal(err)
		}
	}
	_ = process.command.Wait() // Group end and closed signal authority precede reaping.
	if restored, err := RestoreForeground(int(terminal.Fd()), process.leader.GroupID, foreground); err != nil || !restored {
		t.Fatal("foreground restoration failed", err)
	}
	if current, err := unix.IoctlGetInt(int(terminal.Fd()), unix.TIOCGPGRP); err != nil || current != foreground {
		t.Fatal("wrong restored foreground", err)
	}
	fmt.Println("gate_fixture_passed")
}

func TestNativeGatedChild(t *testing.T) {
	if os.Getenv("BFB_GATE_CHILD") == "" {
		t.Skip("subprocess-only gated child")
	}
	paths, err := daemon.StatePaths(os.Getenv("BFB_GATE_ROOT"))
	if err != nil {
		t.Fatal(err)
	}
	registry, err := provider.NewRegistry([]provider.Descriptor{fake.Descriptor()})
	if err != nil {
		t.Fatal(err)
	}
	inspect := gateFixtureInspector
	if os.Getenv("BFB_GATE_FIXTURE") == "child_parent_mismatch" {
		inspect = func(peer daemon.Peer) (SupervisorIdentity, error) {
			identity, err := gateFixtureInspector(peer)
			identity.ExecutableHash = provider.Hash([]byte("different-build"))
			return identity, err
		}
	}
	err = runExecChild(context.Background(), paths, os.Getenv("BFB_GATE_INTENT"), registry, inspect, func(path string, argv, environment []string) error {
		values := map[string]string{}
		for _, entry := range environment {
			name, value, _ := strings.Cut(entry, "=")
			if strings.HasPrefix(name, "BFB_") {
				values[name] = value
			}
		}
		if len(values) != 9 || values["BFB_RUN_EXECUTION_ID"] == "" || values["BFB_CORRELATION_TOKEN"] == "" {
			return failure("execution_assignment_invalid")
		}
		cwd, err := os.Getwd()
		if err != nil || !strings.HasSuffix(cwd, "/packages/api") || strings.HasPrefix(values["BFB_ARTIFACTS_DIR"], cwd) {
			return failure("execution_assignment_invalid")
		}
		if len(argv) < 3 || argv[len(argv)-2] != "--initial-prompt" || argv[len(argv)-1] != provider.InitialInstruction {
			return failure("provider_config_invalid")
		}
		if err := os.WriteFile(filepath.Join(paths.Root, "exec-observed"), []byte("synthetic provider exec attempted\n"), 0600); err != nil {
			return err
		}
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"phase": "gated_exec_verified", "scoped_environment_count": len(values), "cwd_subproject": true})
		return syscall.Exec(path, argv, environment)
	})
	if err != nil {
		fmt.Println("gate_child_blocked:", daemon.AsFailure(err).Code)
		os.Exit(2)
	}
	os.Exit(0)
}
