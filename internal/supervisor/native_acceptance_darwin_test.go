// ABOUTME: Drives the signed daemon and fixed helpers through actual native execution with bounded synthetic claims.
// ABOUTME: Keeps the PTY diagnostic distinct from required Terminal acceptance and never overrides native identity checks.

//go:build darwin && cgo

package supervisor

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/appbridge"
	"github.com/qdis/bfb/internal/checkout"
	"github.com/qdis/bfb/internal/cli"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers/fake"
	"github.com/qdis/bfb/internal/runner"
)

// Only the explicitly compiled, signed test binary has these entry points.
// Production __launch/__exec still use the registry bound in cmd/bfb.
func TestMain(tests *testing.M) {
	arguments := os.Args[1:]
	if len(arguments) > 0 && (arguments[0] == "__launch" || arguments[0] == "--data-dir") {
		if arguments[0] == "__launch" {
			state, err := nativeAcceptanceState()
			if err != nil {
				os.Exit(2)
			}
			arguments = append([]string{"--data-dir", state}, arguments...)
		}
		providers, err := provider.NewRegistry([]provider.Descriptor{fake.Descriptor()})
		if err != nil {
			os.Exit(2)
		}
		commands := cli.NewRegistry()
		cli.RegisterExecution(commands,
			func(ctx context.Context, paths daemon.Paths, intent string) error {
				return RunHelper(ctx, paths, intent, providers)
			},
			func(ctx context.Context, paths daemon.Paths, intent string) error {
				return RunExecChild(ctx, paths, intent, providers)
			},
			RecoverExecution)
		os.Exit(commands.Execute(context.Background(), arguments, os.Stdin, os.Stdout))
	}
	os.Exit(tests.Run())
}

func nativeAcceptanceState() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(filepath.Join(filepath.Dir(executable), "..", "Resources", "native-test-state.json"))
	var state struct {
		Directory string `json:"directory"`
	}
	if err != nil || len(data) > 1024 || strictPrivateJSON(data, &state) != nil || !strings.HasPrefix(state.Directory, "/tmp/bfb-l04-") || filepath.Clean(state.Directory) != state.Directory || filepath.Base(state.Directory) != "state" {
		return "", failure("invalid_request")
	}
	return state.Directory, nil
}

type nativeAcceptanceCloud struct {
	mu                  sync.Mutex
	claim               generated.LaunchClaimResult
	command             LocalCommand
	sequence            int64
	reservation, launch string
	finals              int
	leases              []generated.CheckoutLeaseObservation
	controls            map[string]generated.RunControlResult
	controlKeys         map[string]string
}

func (cloud *nativeAcceptanceCloud) request(_ context.Context, method, path string, body []byte) ([]byte, error) {
	cloud.mu.Lock()
	defer cloud.mu.Unlock()
	if method != "POST" {
		return nil, failure("invalid_request")
	}
	encode := func(value any) ([]byte, error) { return json.Marshal(value) }
	decode := func(schema string, destination any) error {
		if !protocol.DecodeWireDocument(schema, body).OK || strictPrivateJSON(body, destination) != nil {
			return failure("invalid_request")
		}
		return nil
	}
	switch path {
	case "launch/claim", "launch/reconcile":
		want, err := claimRequest(cloud.command)
		if err != nil || string(want) != string(body) {
			return nil, failure("execution_assignment_invalid")
		}
		if path == "launch/claim" {
			return encode(map[string]any{"state": "claimed", "claim": cloud.claim})
		}
		receipt := receiptFixture(cloud.claim, cloud.reservation)
		receipt.LaunchState, receipt.ObservationSequence = cloud.launch, &cloud.sequence
		return encode(receipt)
	case "launch/authorize":
		var request generated.LaunchFinalRequest
		if err := decode("launch-final-request", &request); err != nil {
			return nil, err
		}
		claim := cloud.claim
		if request.LaunchId != claim.Specification.LaunchId || request.RunExecutionId != claim.Assignment.RunExecutionId || request.AssignmentGeneration != claim.Assignment.AssignmentGeneration || request.ConfigSnapshotHash != claim.Specification.ConfigSnapshotHash || cloud.reservation == "released" {
			return nil, failure("execution_authorization_failed")
		}
		cloud.finals++
		return encode(generated.FinalAuthorization{SchemaVersion: 1, LaunchId: request.LaunchId, RunExecutionId: request.RunExecutionId, AssignmentGeneration: request.AssignmentGeneration, Decision: "authorized", AuthorizedAt: localTimestamp(time.Now())})
	case "launch/reject":
		var request generated.LaunchRejectRequest
		if err := decode("launch-reject-request", &request); err != nil {
			return nil, err
		}
		if request.LaunchId != cloud.claim.Specification.LaunchId || request.RunExecutionId != cloud.claim.Assignment.RunExecutionId {
			return nil, failure("execution_assignment_invalid")
		}
		cloud.launch = "rejected"
		return encode(map[string]string{"state": "rejected"})
	case "leases/observe":
		var observation generated.CheckoutLeaseObservation
		if err := decode("checkout-lease-observation", &observation); err != nil {
			return nil, err
		}
		if observation.RunExecutionId != cloud.claim.Assignment.RunExecutionId || observation.AssignmentGeneration != cloud.claim.Assignment.AssignmentGeneration || observation.FencingGeneration != cloud.claim.FencingGeneration || observation.Sequence <= cloud.sequence {
			return nil, failure("execution_assignment_invalid")
		}
		cloud.sequence = observation.Sequence
		cloud.leases = append(cloud.leases, observation)
		switch observation.Operation {
		case "renew":
			cloud.reservation, cloud.launch = "live", "started"
		case "release", "recover":
			cloud.reservation = "released"
		case "unknown":
			cloud.reservation = "containment_unknown"
		default:
			return nil, failure("invalid_request")
		}
		return encode(map[string]string{"state": cloud.reservation})
	case "controls/read", "controls/claim", "controls/acknowledge":
		var id, key string
		var disposition string
		if path == "controls/read" {
			var request generated.RunControlReference
			if err := decode("run-control-reference", &request); err != nil {
				return nil, err
			}
			id = request.ControlId
		} else if path == "controls/claim" {
			var request generated.RunControlClaim
			if err := decode("run-control-claim", &request); err != nil {
				return nil, err
			}
			id, key = request.ControlId, request.IdempotencyKey
			bound, ok := cloud.controls[id]
			if !ok || request.RunExecutionId != bound.RunExecutionId || request.AssignmentGeneration != bound.AssignmentGeneration || request.Action != bound.Action {
				return nil, failure("execution_assignment_invalid")
			}
		} else {
			var request generated.RunControlDisposition
			if err := decode("run-control-disposition", &request); err != nil {
				return nil, err
			}
			id, key, disposition = request.ControlId, request.IdempotencyKey, request.Disposition
			bound, ok := cloud.controls[id]
			if !ok || request.RunExecutionId != bound.RunExecutionId || request.AssignmentGeneration != bound.AssignmentGeneration {
				return nil, failure("execution_assignment_invalid")
			}
		}
		control, ok := cloud.controls[id]
		if !ok || (key != "" && cloud.controlKeys[id] != "" && cloud.controlKeys[id] != key) {
			return nil, failure("execution_assignment_invalid")
		}
		if key != "" {
			cloud.controlKeys[id] = key
		}
		if path == "controls/claim" && !controlTerminal(control) {
			deadline, _ := time.Parse(time.RFC3339Nano, control.ExpiresAt)
			control.State = "claimed"
			if !time.Now().Before(deadline) {
				control.State, control.Disposition = "expired", new("expired")
			}
		}
		if disposition != "" {
			control.State, control.Disposition = "rejected", &disposition
			if disposition == "applied" {
				control.State = "applied"
			}
		}
		cloud.controls[id] = control
		return encode(control)
	default:
		return nil, failure("unknown_method")
	}
}

type nativeExecutionFixture struct {
	store                      *IntentStore
	local                      *daemon.Store
	service                    *Service
	cloud                      *nativeAcceptanceCloud
	bridge                     *appbridge.Bridge
	root, cwd, artifacts, head string
	opened                     chan error
}

func newNativeExecutionFixture(t *testing.T, state, binary, scenario, transport string) *nativeExecutionFixture {
	t.Helper()
	ctx := context.Background()
	store, local, claim, _ := fixtureIntentsAt(t, state)
	claim.Specification.LaunchId = daemon.NewRequestID()
	claim.Assignment.RunId = daemon.NewRequestID()
	claim.Specification.RunId = claim.Assignment.RunId
	claim.Assignment.RunExecutionId = daemon.NewRequestID()
	claim.Specification.RunExecutionId = claim.Assignment.RunExecutionId
	claim.Specification.ConfigSnapshotId = daemon.NewRequestID()
	root := t.TempDir()
	cwd := filepath.Join(root, "packages", "api")
	if err := os.MkdirAll(cwd, 0700); err != nil {
		t.Fatal(err)
	}
	git := func(arguments ...string) string {
		command := exec.Command("/usr/bin/git", arguments...)
		command.Dir, command.Env = root, []string{"PATH=/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null"}
		data, err := command.CombinedOutput()
		if err != nil {
			t.Fatal("synthetic Git setup failed", err)
		}
		return strings.TrimSpace(string(data))
	}
	git("init", "--initial-branch=main")
	git("remote", "add", "origin", "https://github.com/synthetic/native-supervision.git")
	git("-c", "user.name=Synthetic BFB", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Synthetic native acceptance")
	head := git("rev-parse", "HEAD")
	if err := os.WriteFile(filepath.Join(cwd, "synthetic-dirty.txt"), []byte("synthetic native fixture\n"), 0600); err != nil {
		t.Fatal(err)
	}
	record, err := checkout.NewRegistry(local.DB).Link(ctx, checkout.LinkInput{WorkspaceID: claim.Assignment.WorkspaceId, RunnerID: claim.Assignment.RunnerId, ProjectID: claim.Assignment.ProjectId, Path: cwd, WorkspaceSubpath: "packages/api", RepositoryIdentity: "github.com/synthetic/native-supervision", Label: "Synthetic native execution"})
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	installation := provider.Installation{Executable: filepath.Join(directory, "provider"), IntegrationHash: provider.Hash(nil), Environment: append(NormalEnvironment(os.Environ()), "BFB_INHERITED_CANARY=synthetic-not-authority"), ConfigFiles: []provider.ConfigSource{{Name: "user", Path: filepath.Join(directory, "scenario.json")}}}
	data, err := os.ReadFile(binary)
	if err != nil || os.WriteFile(installation.Executable, data, 0700) != nil {
		t.Fatal("native provider fixture unavailable", err)
	}
	data, _ = json.Marshal(map[string]string{"scenario": scenario})
	if err := os.WriteFile(installation.ConfigFiles[0].Path, data, 0600); err != nil {
		t.Fatal(err)
	}
	providers, err := provider.NewRegistry([]provider.Descriptor{fake.Descriptor()})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	probe, err := providers.Probe(ctx, "fake", installation, now)
	if err != nil || probe.Status != "healthy" {
		t.Fatal("native fixture probe failed", err)
	}
	claim.Assignment.CreatedAt, claim.Specification.ExpiresAt = localTimestamp(now), localTimestamp(now.Add(120*time.Second))
	claim.LeaseExpiresAt = localTimestamp(now.Add(45 * time.Second))
	claim.Assignment.CheckoutId, claim.Specification.CheckoutId = record.Summary.CheckoutId, record.Summary.CheckoutId
	claim.Snapshot.PhysicalWorktreeHash = record.Summary.PhysicalWorktreeHash
	claim.Snapshot.RepositoryIdentityHash = provider.Hash([]byte(record.Summary.RepositoryIdentity))
	claim.Snapshot.RepositoryConfigHash = record.Summary.RepositoryConfigHash
	claim.Snapshot.ProviderVersion, claim.Snapshot.ProviderManifestId = probe.Version, probe.ManifestID
	claim.Specification.ExecutionConfig = generated.ExecutionConfig{Provider: "fake", Mode: "interactive", Model: "synthetic", Effort: "low", ApprovalPolicy: "never", FilesystemPolicy: "read_only", ContextInjection: "none", InitialTurnTransport: "provider_prompt", RequiredCapabilities: []string{"launch.interactive"}}
	claim.Snapshot.ExecutionConfig = claim.Specification.ExecutionConfig
	claim.Specification.ConfigSnapshotHash, err = snapshotHash(claim.Snapshot)
	if err != nil {
		t.Fatal(err)
	}
	cloud := &nativeAcceptanceCloud{claim: claim, reservation: "reserved", launch: "claimed", controls: map[string]generated.RunControlResult{}, controlKeys: map[string]string{}}
	cloud.command = acceptFixture(t, store, claim, now)
	bridge := appbridge.New(appbridge.Options{})
	canonicalState, err := filepath.EvalSymlinks(local.Paths.Root)
	if err != nil {
		t.Fatal(err)
	}
	f := &nativeExecutionFixture{store: store, local: local, cloud: cloud, bridge: bridge, root: root, cwd: record.Location.WorkingDirectory, head: head, artifacts: filepath.Join(canonicalState, "run-artifacts", claim.Assignment.RunExecutionId), opened: make(chan error, 1)}
	open := bridge.OpenTerminal
	if transport == "pty" {
		open = func(_ context.Context, intent string) error {
			self, err := os.Executable()
			if err != nil {
				return err
			}
			log, err := os.OpenFile(filepath.Join(state, "signed-pty.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
			if err != nil {
				return err
			}
			command := exec.Command("/usr/bin/script", "-q", "-F", filepath.Join(state, "signed-pty-"+intent+".typescript"), self, "__launch", intent)
			command.Stdout, command.Stderr = log, log
			command.Env = append(NormalEnvironment(os.Environ()), "BFB_INHERITED_CANARY=synthetic-not-authority")
			input, err := command.StdinPipe()
			if err != nil {
				_ = log.Close()
				return err
			}
			if err := command.Start(); err != nil {
				_ = log.Close()
				_ = input.Close()
				return err
			}
			done := make(chan struct{})
			go func() { _ = command.Wait(); close(done) }()
			t.Cleanup(func() {
				_ = input.Close()
				select {
				case <-done:
				case <-time.After(3 * time.Second):
					_ = command.Process.Kill()
					<-done
				}
				_ = log.Close()
			})
			return nil
		}
	}
	f.service = NewService(ServiceOptions{Providers: providers,
		Installation: func(context.Context, string) (provider.Installation, error) { return installation, nil },
		Connection: func(id string) (runner.RunnerConnection, error) {
			if id != cloud.command.RunnerID {
				return nil, failure("invalid_request")
			}
			return &finalConnection{request: cloud.request}, nil
		},
		OpenTerminal: func(ctx context.Context, intent string) error { err := open(ctx, intent); f.opened <- err; return err }, FocusTerminal: bridge.FocusTerminal,
	})
	methods := daemon.NewRegistry()
	if err := appbridge.RegisterRPC(methods, bridge); err != nil {
		t.Fatal(err)
	}
	if err := RegisterRPC(methods, f.service); err != nil {
		t.Fatal(err)
	}
	if err := methods.Register("runner.list", func(context.Context, daemon.Request) (map[string]any, error) {
		return map[string]any{"enrollments": []any{}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	server, err := daemon.Start(ctx, local.Paths, methods)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Close)
	t.Cleanup(func() {
		var child Process
		data, err := os.ReadFile(filepath.Join(f.artifacts, "native-child.json"))
		if err == nil && json.Unmarshal(data, &child) == nil {
			stopNativeFixture(t, child)
		}
		assignment, _ := store.ByCommand(ctx, cloud.command)
		if assignment != nil && assignment.Supervisor != nil {
			stopNativeFixture(t, assignment.Supervisor.Process)
		}
	})
	return f
}

func stopNativeFixture(t *testing.T, process Process) {
	t.Helper()
	table, err := InspectProcesses()
	if err != nil || !process.Same(table[process.PID]) || table[process.PID].Zombie {
		return
	}
	if err := syscall.Kill(process.PID, syscall.SIGTERM); err != nil {
		t.Error("owned native fixture cleanup failed", err)
		return
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		table, err = InspectProcesses()
		if err != nil || !process.Same(table[process.PID]) || table[process.PID].Zombie {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	if table, err = InspectProcesses(); err == nil && process.Same(table[process.PID]) && !table[process.PID].Zombie {
		_ = syscall.Kill(process.PID, syscall.SIGKILL)
	}
}

func awaitNative(t *testing.T, limit time.Duration, label string, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if check() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("native acceptance timed out:", label)
}

func (f *nativeExecutionFixture) live(t *testing.T) LocalAssignment {
	t.Helper()
	select {
	case err := <-f.opened:
		if err != nil {
			t.Fatal("native terminal delivery failed", daemon.AsFailure(err).Code)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("native terminal offer timed out")
	}
	var assignment LocalAssignment
	awaitNative(t, 20*time.Second, "verified provider image", func() bool {
		current, err := f.store.ByCommand(context.Background(), f.cloud.command)
		if err != nil || current == nil || current.Group == nil {
			return false
		}
		checkpoint, err := f.store.observationCheckpoint(context.Background(), current.IntentID)
		if err != nil || checkpoint.ProviderObserved == "" {
			return false
		}
		assignment = *current
		return true
	})
	var audit struct {
		Process           Process `json:"process"`
		CWD, Branch, Head string
		Dirty             bool
		Scoped            map[string]string
		EnvironmentNames  []string `json:"environment_names"`
		Arguments         []string
		Resumed           bool
	}
	awaitNative(t, 5*time.Second, "provider execution audit", func() bool {
		data, err := os.ReadFile(filepath.Join(f.artifacts, "native-start.json"))
		return err == nil && json.Unmarshal(data, &audit) == nil
	})
	if audit.Process != *assignment.Group || audit.CWD != f.cwd || audit.Branch != "main" || audit.Head != f.head || !audit.Dirty || audit.Resumed || !slices.Contains(audit.EnvironmentNames, "PATH") {
		t.Fatal("actual native process or checkout facts differ from the assigned launch")
	}
	files, err := ReadAssignmentFiles(f.local.Paths.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer files.Close()
	wire, err := files.Read(assignment.IntentID)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"BFB_WORKSPACE_ID": wire.Claim.Assignment.WorkspaceId, "BFB_PROJECT_ID": wire.Claim.Assignment.ProjectId, "BFB_TASK_ID": wire.Claim.Assignment.TaskId, "BFB_RUN_ID": wire.Claim.Assignment.RunId, "BFB_RUN_EXECUTION_ID": wire.Claim.Assignment.RunExecutionId, "BFB_ASSIGNMENT_GENERATION": "1", "BFB_CHECKOUT_ID": wire.Claim.Assignment.CheckoutId, "BFB_CORRELATION_TOKEN": wire.CorrelationToken, "BFB_ARTIFACTS_DIR": f.artifacts}
	if !reflect.DeepEqual(audit.Scoped, want) || !outsideCheckout(audit.Scoped["BFB_ARTIFACTS_DIR"], f.root) {
		t.Fatal("native provider received the wrong scoped environment or artifact location")
	}
	invocation, err := (fake.Adapter{}).Launch(provider.LaunchInput{Config: wire.Claim.Specification.ExecutionConfig, WorkingDirectory: f.cwd})
	if err != nil || !reflect.DeepEqual(audit.Arguments, invocation.Arguments) {
		t.Fatal("provider argv was not the compiled fixed launch")
	}
	return assignment
}

func (f *nativeExecutionFixture) control(t *testing.T, assignment LocalAssignment, action string) LocalCommand {
	t.Helper()
	ctx := context.Background()
	reference := runner.CommandReference{ID: daemon.NewRequestID(), Kind: "run_control", ExpiresAt: localTimestamp(time.Now().Add(60 * time.Second))}
	f.cloud.mu.Lock()
	f.cloud.controls[reference.ID] = generated.RunControlResult{SchemaVersion: 1, ControlId: reference.ID, RunExecutionId: assignment.Claim.Assignment.RunExecutionId, AssignmentGeneration: assignment.Claim.Assignment.AssignmentGeneration, RunnerId: assignment.Claim.Assignment.RunnerId, Action: action, State: "pending", ExpiresAt: reference.ExpiresAt}
	f.cloud.mu.Unlock()
	enrollment := runner.Enrollment{WorkspaceID: assignment.Claim.Assignment.WorkspaceId, RunnerID: assignment.Claim.Assignment.RunnerId}
	for range 3 {
		if err := f.service.Accept(ctx, enrollment, reference); err != nil {
			t.Fatal(err)
		}
	}
	command, err := f.store.Command(ctx, enrollment.RunnerID, reference.ID)
	if err != nil {
		t.Fatal(err)
	}
	awaitNative(t, 20*time.Second, "one applied "+action, func() bool {
		effect, err := f.store.control(ctx, command)
		if err != nil || effect == nil {
			return false
		}
		if effect.State == "rejected" || effect.State == "delivery_unknown" {
			t.Fatalf("native %s disposition: %s", action, effect.State)
		}
		return effect.State == "applied"
	})
	return command
}

func TestSignedExecutionIntegration(t *testing.T) {
	transport := os.Getenv("BFB_SIGNED_EXECUTION_TEST")
	if transport == "" {
		t.Skip("requires the separately built signed native harness")
	}
	if transport != "terminal" && transport != "pty" {
		t.Fatal("invalid native acceptance transport")
	}
	state, err := nativeAcceptanceState()
	if err != nil {
		t.Fatal("native signed app state unavailable", err)
	}
	if _, err := InspectHelper(daemon.Peer{UID: os.Getuid(), PID: os.Getpid()}); err != nil {
		t.Fatal("native harness is not the trusted signed helper", err)
	}
	t.Run("pid_reuse_guard", TestSignalCannotUseAReusedPIDIdentity)
	for _, scenario := range []string{"interactive", "child", "escape"} {
		t.Run(scenario, func(t *testing.T) {
			f := newNativeExecutionFixture(t, state, os.Getenv("BFB_SIGNED_EXECUTION_PROVIDER"), scenario, transport)
			assignment := f.live(t)
			switch scenario {
			case "interactive":
				if transport == "terminal" {
					f.control(t, assignment, "focus_existing")
				}
				f.control(t, assignment, "interrupt")
				var interrupted struct{ Signal int }
				awaitNative(t, 5*time.Second, "provider received SIGINT", func() bool {
					data, err := os.ReadFile(filepath.Join(f.artifacts, "native-signal-1.json"))
					return err == nil && json.Unmarshal(data, &interrupted) == nil && interrupted.Signal == int(syscall.SIGINT)
				})
				if _, err := os.Stat(filepath.Join(f.artifacts, "native-signal-2.json")); !os.IsNotExist(err) {
					t.Fatal("duplicate control produced another provider signal")
				}
			case "child":
				child := f.spawnChild(t, assignment, false)
				parentExit := time.Now()
				table, err := InspectProcesses()
				if err != nil || !assignment.Group.Same(table[assignment.Group.PID]) {
					t.Fatal("native parent fault target changed")
				}
				if err := syscall.Kill(assignment.Group.PID, syscall.SIGKILL); err != nil {
					t.Fatal(err)
				}
				awaitNative(t, 20*time.Second, "heartbeat after provider parent exit", func() bool {
					locked, err := readNativeLock(f.local.Paths, assignment)
					table, processErr := InspectProcesses()
					if err != nil || processErr != nil || !locked.Held || locked.Record.State != "owned" || !child.Same(table[child.PID]) || table[child.PID].Zombie {
						t.Fatal("live owned child lost its lock or native identity")
					}
					// The unreaped zombie leader still reserves the original group ID.
					if !assignment.Group.Same(table[assignment.Group.PID]) || !table[assignment.Group.PID].Zombie {
						return false
					}
					events, err := f.store.PendingObservations(context.Background(), 256)
					if err != nil {
						t.Fatal(err)
					}
					for _, event := range events {
						at, _ := time.Parse(time.RFC3339Nano, event.OccurredAt)
						if event.RunExecutionId == assignment.Claim.Assignment.RunExecutionId && event.Kind == "heartbeat" && at.After(parentExit) {
							return true
						}
					}
					return false
				})
				f.control(t, assignment, "terminate")
			case "escape":
				child := f.spawnChild(t, assignment, true)
				awaitNative(t, 20*time.Second, "persistent cloud containment uncertainty", func() bool {
					f.cloud.mu.Lock()
					defer f.cloud.mu.Unlock()
					return f.cloud.reservation == "containment_unknown"
				})
				f.recover(t, assignment, "checkout_occupied")
				stopNativeFixture(t, *assignment.Group)
				table, err := InspectProcesses()
				if err != nil || !child.Same(table[child.PID]) || table[child.PID].Zombie {
					t.Fatal("escaped child was signalled by native supervision")
				}
				f.recover(t, assignment, "checkout_occupied")
				stopNativeFixture(t, child)
				awaitNative(t, 10*time.Second, "ended helper with retained escape marker", func() bool {
					locked, err := readNativeLock(f.local.Paths, assignment)
					table, processErr := InspectProcesses()
					return err == nil && processErr == nil && !locked.Held && locked.Record.State == "containment_unknown" && !assignment.Supervisor.Process.Same(table[assignment.Supervisor.Process.PID])
				})
				f.recover(t, assignment, "")
				history, err := readNativeHistory(context.Background(), f.store.db, assignment)
				if err != nil || !history.Uncertain || history.Group == nil || !history.Group.HadEscape || history.Group.Observed[child.PID] != child || history.ReleasedGroupHash != nativeGroupHash(history.Group) {
					t.Fatal("signed local recovery discarded escape history")
				}
			}
			f.released(t, assignment)
			f.cloud.mu.Lock()
			finals := f.cloud.finals
			f.cloud.mu.Unlock()
			if finals < 2 {
				t.Fatal("native launch bypassed repeated final online authorization")
			}
		})
	}
	if !t.Failed() {
		fmt.Println("L05_SIGNED_EXECUTION_OK transport=" + transport + " exact checkout; scoped environment; observed provider image; fixed helpers; bound duplicate controls; surviving child heartbeat; sticky escape; signed local recovery; whole-group release")
	}
}

func (f *nativeExecutionFixture) spawnChild(t *testing.T, assignment LocalAssignment, escape bool) Process {
	t.Helper()
	if err := os.WriteFile(filepath.Join(f.artifacts, "native-spawn-child"), []byte("synthetic local fault\n"), 0600); err != nil {
		t.Fatal(err)
	}
	var child Process
	awaitNative(t, 10*time.Second, "retained native descendant", func() bool {
		data, err := os.ReadFile(filepath.Join(f.artifacts, "native-child.json"))
		if err != nil || json.Unmarshal(data, &child) != nil {
			return false
		}
		if child.ParentPID != assignment.Group.PID || (child.GroupID != assignment.Group.GroupID) != escape {
			t.Fatal("native descendant fault was not the requested scenario")
		}
		history, err := readNativeHistory(context.Background(), f.store.db, assignment)
		return err == nil && history.Group != nil && history.Group.Observed[child.PID] == child && (!escape || history.Uncertain && history.Group.HadEscape)
	})
	return child
}

func (f *nativeExecutionFixture) recover(t *testing.T, assignment LocalAssignment, code string) {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, self, "--data-dir", f.local.Paths.Root, "--json", "execution", "recover", assignment.IntentID)
	data, err := command.Output()
	var reply generated.LocalRpcEnvelope
	if json.Unmarshal(data, &reply) != nil || len(reply.Payload) != 0 {
		t.Fatal("signed recovery reply was invalid")
	}
	if code == "" {
		if err != nil || reply.Error != nil {
			t.Fatal("signed absent-execution recovery failed")
		}
	} else if err == nil || reply.Error == nil || reply.Error.Code != code {
		actual := "accepted"
		if reply.Error != nil {
			actual = reply.Error.Code
		}
		t.Fatal("signed recovery did not retain unresolved occupancy", "want", code, "actual", actual)
	}
}

func (f *nativeExecutionFixture) released(t *testing.T, assignment LocalAssignment) {
	t.Helper()
	awaitNative(t, 20*time.Second, "verified native and cloud release", func() bool {
		locked, err := readNativeLock(f.local.Paths, assignment)
		if err != nil || locked.Held || locked.Record.State != "released" {
			return false
		}
		command, err := f.store.Command(context.Background(), f.cloud.command.RunnerID, f.cloud.command.ID)
		if err != nil || command.State != "complete" {
			return false
		}
		f.cloud.mu.Lock()
		defer f.cloud.mu.Unlock()
		return f.cloud.reservation == "released"
	})
	if _, err := os.Stat(filepath.Join(f.artifacts, "native-timeout.json")); !os.IsNotExist(err) {
		t.Fatal("native provider timeout substituted for the intended control")
	}
}
