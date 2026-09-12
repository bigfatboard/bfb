// ABOUTME: Fault-tests single-child resume against real SQLite, checkout preparation and owned native processes.
// ABOUTME: Keeps synthetic cloud/signing observations explicit and does not certify Terminal integration.

package supervisor

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"slices"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers/fake"
	"github.com/qdis/bfb/internal/runner"
)

// A separate owned parent makes its native identity genuinely absent when the
// fixture is stopped. The provider is a direct child in its own process group.
func TestResumeSourceProcessFixture(t *testing.T) {
	binary := os.Getenv("BFB_RESUME_SOURCE_FIXTURE")
	if binary == "" {
		return
	}
	child := exec.Command(binary, "--mode", "interactive")
	child.Env = []string{}
	child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdout, err := child.StdoutPipe()
	if err != nil || child.Start() != nil {
		t.Fatal("synthetic child did not start", err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	reader := bufio.NewReader(stdout)
	line, err := reader.ReadBytes('\n')
	var event provider.Candidate
	if err != nil || json.Unmarshal(line, &event) != nil || event.Kind != "session_started" {
		t.Fatal("synthetic child readiness missing", err)
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]int{"child": child.Process.Pid})
	_, _ = io.Copy(io.Discard, os.Stdin)
	_ = child.Process.Signal(syscall.SIGTERM)
	_, _ = io.Copy(io.Discard, reader)
	if child.Wait() != nil {
		t.Fatal("synthetic child did not stop cleanly")
	}
}

func startResumeSource(t *testing.T, binary string) (SupervisorIdentity, Process, func()) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestResumeSourceProcessFixture$")
	command.Env = []string{"BFB_RESUME_SOURCE_FIXTURE=" + binary}
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	command.Cancel = func() error { return stdin.Close() }
	command.WaitDelay = 5 * time.Second
	stdout, err := command.StdoutPipe()
	if err != nil || command.Start() != nil {
		t.Fatal("source helper did not start", err)
	}
	var stopOnce sync.Once
	var ownedChild Process
	stop := func() {
		stopOnce.Do(func() {
			_ = stdin.Close()
			if err := command.Wait(); err != nil {
				t.Error("source helper did not exit cleanly", err)
			}
			cancel()
			if table, err := InspectProcesses(); err == nil && ownedChild.Same(table[ownedChild.PID]) && !table[ownedChild.PID].Zombie {
				// This is only the fixture's recorded child, never an arbitrary
				// surviving group discovered after a test failure.
				killFixture(t, ownedChild)
				t.Error("source helper left its owned child alive")
			}
		})
	}
	t.Cleanup(stop)
	var ready struct{ Child int }
	if json.NewDecoder(stdout).Decode(&ready) != nil {
		t.Fatal("source fixture readiness missing")
	}
	table, err := InspectProcesses()
	owner, child := table[command.Process.Pid], table[ready.Child]
	if err != nil || !validRecordedProcess(owner) || child.ParentPID != owner.PID || child.GroupID != child.PID {
		t.Fatal("source fixture native ownership missing", err)
	}
	ownedChild = child
	return SupervisorIdentity{Process: owner, ExecutableHash: provider.Hash(nil)}, child, stop
}

type resumeFixture struct {
	f             *launchQueueFixture
	source        LocalAssignment
	command       LocalCommand
	receipt       generated.RunControlResult
	connection    *finalConnection
	claims, acks  int
	cloudStarted  bool
	cloudReleased bool
	loseClaim     bool
	loseAck       bool
	claimHook     func()
}

func fixtureResume(t *testing.T, binary string, settleSource bool) *resumeFixture {
	t.Helper()
	ctx := context.Background()
	f := fixtureLaunchQueue(t, binary)
	if err := f.process(); err != nil {
		t.Fatal(err)
	}
	assignment, err := f.store.ByCommand(ctx, f.command)
	if err != nil || assignment == nil {
		t.Fatal(err)
	}
	owner, child, stop := startResumeSource(t, f.installation.Executable)
	if _, err = f.store.Register(ctx, assignment.IntentID, owner, f.now); err != nil {
		t.Fatal(err)
	}
	lock := daemon.NewRequestID()
	if _, err = f.store.PinOwnership(ctx, assignment.IntentID, owner, lock, nil, f.now); err != nil {
		t.Fatal(err)
	}
	source, err := f.store.PinOwnership(ctx, assignment.IntentID, owner, lock, &child, f.now)
	if err != nil {
		t.Fatal(err)
	}
	group, err := NewGroup(child)
	if err != nil {
		t.Fatal(err)
	}
	// Signing, native lock publication and provider observation are injected
	// fixture boundaries; source PID/start/group and their absence are real.
	captureFixture(t, f.store, source, processCapture{State: "live", ProviderImage: true}, f.now, "execution_attached")
	stop()
	f.now = time.Now()
	if _, err = f.store.rememberNative(ctx, source, nativeHistory{Group: group, LocalReleasedAt: localTimestamp(f.now), ReleasedGroupHash: nativeGroupHash(group)}); err != nil {
		t.Fatal(err)
	}
	captureFixture(t, f.store, source, processCapture{State: "gone"}, f.now, "execution_ended")
	if settleSource {
		if err = f.store.completeRegistered(ctx, source); err != nil {
			t.Fatal(err)
		}
	}
	source, err = f.store.ByIntent(ctx, source.IntentID)
	if err != nil {
		t.Fatal(err)
	}
	reference := runner.CommandReference{ID: daemon.NewRequestID(), Kind: "run_control", ExpiresAt: localTimestamp(f.now.Add(120 * time.Second))}
	if err = f.store.Accept(ctx, runner.Enrollment{WorkspaceID: f.command.WorkspaceID, RunnerID: f.command.RunnerID}, reference, f.now); err != nil {
		t.Fatal(err)
	}
	command, err := f.store.Command(ctx, f.command.RunnerID, reference.ID)
	if err != nil {
		t.Fatal(err)
	}
	childClaim := f.claim
	childClaim.Assignment.RunExecutionId = daemon.NewRequestID()
	childClaim.Assignment.AssignmentGeneration++
	childClaim.Assignment.CreatedAt = localTimestamp(f.now)
	childClaim.FencingGeneration++
	childClaim.LeaseExpiresAt = localTimestamp(f.now.Add(45 * time.Second))
	childClaim.Specification.RunExecutionId = childClaim.Assignment.RunExecutionId
	childClaim.Specification.AssignmentGeneration = childClaim.Assignment.AssignmentGeneration
	childClaim.Specification.LaunchId = daemon.NewRequestID()
	childClaim.Specification.ExpiresAt = command.ExpiresAt
	childClaim.Specification.ResumeSession = map[string]any{"provider_session_id": daemon.NewRequestID(), "observed_session_id": "synthetic-session"}
	f.claim, f.opens = childClaim, 0
	r := &resumeFixture{f: f, source: source, command: command, receipt: generated.RunControlResult{
		SchemaVersion: 1, ControlId: command.ID, RunExecutionId: source.Claim.Assignment.RunExecutionId, AssignmentGeneration: source.Claim.Assignment.AssignmentGeneration,
		RunnerId: command.RunnerID, Action: "resume", State: "pending", ExpiresAt: command.ExpiresAt,
	}}
	r.connection = &finalConnection{request: func(_ context.Context, method, path string, body []byte) ([]byte, error) {
		if method != "POST" {
			t.Fatal("unexpected method")
		}
		switch path {
		case "controls/read":
			var reference generated.RunControlReference
			if json.Unmarshal(body, &reference) != nil || reference.ControlId != command.ID {
				t.Fatal("control read retargeted")
			}
			return encodedFixture(t, r.receipt), nil
		case "controls/claim":
			r.claims++
			var request generated.RunControlClaim
			if json.Unmarshal(body, &request) != nil || request.ControlId != command.ID || request.IdempotencyKey != command.ClaimKey || request.Action != "resume" || request.RunExecutionId != r.source.Claim.Assignment.RunExecutionId || request.AssignmentGeneration != r.source.Claim.Assignment.AssignmentGeneration {
				t.Fatal("resume changed original claim")
			}
			r.receipt.State, r.receipt.ResumeLaunchId = "claimed", &f.claim.Specification.LaunchId
			if r.claimHook != nil {
				r.claimHook()
			}
			if r.loseClaim {
				r.loseClaim = false
				return nil, errors.New("synthetic lost control claim reply")
			}
			return encodedFixture(t, r.receipt), nil
		case "launch/claim", "launch/reconcile":
			childCommand, err := f.store.Command(ctx, command.RunnerID, f.claim.Specification.LaunchId)
			expected, _ := claimRequest(childCommand)
			if err != nil || string(body) != string(expected) {
				t.Fatal("child claim was not stable", err)
			}
			if path == "launch/claim" {
				return encodedFixture(t, map[string]any{"state": "claimed", "claim": f.claim}), nil
			}
			state := "reserved"
			if r.cloudStarted {
				state = "live"
			}
			if r.cloudReleased {
				state = "released"
			}
			receipt := receiptFixture(f.claim, state)
			if r.cloudStarted {
				receipt.LaunchState = "started"
			} else if r.cloudReleased {
				receipt.LaunchState = "rejected"
			}
			return encodedFixture(t, receipt), nil
		case "launch/reject":
			return []byte(`{"state":"rejected"}`), nil
		case "leases/observe":
			var observation generated.CheckoutLeaseObservation
			if json.Unmarshal(body, &observation) != nil || observation.Operation != "release" || observation.Supervisor != nil {
				t.Fatal("unexpected cleanup observation")
			}
			r.cloudReleased = true
			return []byte(`{"state":"released"}`), nil
		case "controls/acknowledge":
			r.acks++
			var request generated.RunControlDisposition
			if json.Unmarshal(body, &request) != nil || request.ControlId != command.ID || request.IdempotencyKey != command.ClaimKey || request.RunExecutionId != r.source.Claim.Assignment.RunExecutionId || request.AssignmentGeneration != r.source.Claim.Assignment.AssignmentGeneration {
				t.Fatal("control result lost original binding")
			}
			r.receipt.State, r.receipt.Disposition = "rejected", &request.Disposition
			if request.Disposition == "applied" {
				if !r.cloudStarted {
					t.Fatal("resume applied before child started")
				}
				r.receipt.State = "applied"
			}
			if r.loseAck {
				r.loseAck = false
				return nil, errors.New("synthetic lost control acknowledgement")
			}
			return encodedFixture(t, r.receipt), nil
		default:
			t.Fatal("unexpected resume request", path)
			return nil, errors.New("unexpected request")
		}
	}}
	f.service.options.Connection = func(string) (runner.RunnerConnection, error) { return r.connection, nil }
	return r
}

func (r *resumeFixture) process() error {
	return r.f.service.processControl(context.Background(), r.f.store, r.command)
}

func (r *resumeFixture) childCommand(t *testing.T) LocalCommand {
	t.Helper()
	command, err := r.f.store.Command(context.Background(), r.command.RunnerID, r.f.claim.Specification.LaunchId)
	if err != nil {
		t.Fatal(err)
	}
	return command
}

func (r *resumeFixture) processChild(t *testing.T) error {
	t.Helper()
	return r.f.service.processLaunch(context.Background(), r.f.store, r.f.files, r.childCommand(t))
}

func TestResumeDispatchesOneBoundChildAndReconstructsExactPlan(t *testing.T) {
	r := fixtureResume(t, fixtureQueueBinary(t), true)
	ctx := context.Background()
	if err := r.process(); err != nil || r.claims != 1 || r.f.opens != 0 {
		t.Fatal("resume did not bind its child without a native effect", err)
	}
	for range 3 {
		if err := r.process(); err != nil {
			t.Fatal(err)
		}
	}
	if err := r.processChild(t); err != nil || r.f.opens != 1 {
		t.Fatal("bound child was not offered once", err)
	}
	child, err := r.f.store.ByCommand(ctx, r.childCommand(t))
	if err != nil || child == nil || child.IntentID == r.source.IntentID || child.Claim.Assignment.AssignmentGeneration <= r.source.Claim.Assignment.AssignmentGeneration {
		t.Fatal("resume reused its old execution", err)
	}
	for range 3 {
		if err := r.processChild(t); err != nil {
			t.Fatal(err)
		}
	}
	if r.f.opens != 1 || r.claims != 1 || r.acks != 0 {
		t.Fatal("resume repeated delivery or inferred success")
	}
	table, err := InspectProcesses()
	if err != nil {
		t.Fatal(err)
	}
	registered, err := r.f.store.Register(ctx, child.IntentID, SupervisorIdentity{Process: table[os.Getpid()], ExecutableHash: provider.Hash(nil)}, r.f.now)
	if err != nil {
		t.Fatal(err)
	}
	wire, err := registered.wire()
	if err != nil {
		t.Fatal(err)
	}
	execution, err := loadExecution(ctx, r.f.local.Paths, wire, r.f.service.options.Providers, r.f.installation.Environment)
	if err != nil {
		t.Fatal("helper failed to reconstruct resume plan", err)
	}
	defer execution.db.Close()
	args := execution.plan.Invocation().Arguments
	if !slices.Equal(args[len(args)-2:], []string{"--resume", "synthetic-session"}) || slices.Contains(args, "--session") || len(execution.plan.Invocation().Stdin) != 0 {
		t.Fatal("helper fell back to a fresh interactive session")
	}
	if err := execution.revalidate(ctx); err != nil {
		t.Fatal("unchanged resumed source did not revalidate", err)
	}
	if err := r.f.store.finishControl(ctx, mustResumeEffect(t, r), "delivery_unknown"); err != nil {
		t.Fatal(err)
	}
	if err := execution.revalidate(ctx); err == nil {
		t.Fatal("closed resume effect retained pre-exec permission")
	}
}

func mustResumeEffect(t *testing.T, r *resumeFixture) controlEffect {
	t.Helper()
	effect, err := r.f.store.control(context.Background(), r.command)
	if err != nil || effect == nil {
		t.Fatal(err)
	}
	return *effect
}

func TestResumeChildMayArriveBeforeLostControlReplyWithoutCleanupOrFreshStart(t *testing.T) {
	r := fixtureResume(t, fixtureQueueBinary(t), true)
	ctx := context.Background()
	r.loseClaim = true
	if err := r.process(); err == nil {
		t.Fatal("lost control claim reply was accepted")
	}
	if err := r.f.store.Accept(ctx, runner.Enrollment{WorkspaceID: r.command.WorkspaceID, RunnerID: r.command.RunnerID},
		runner.CommandReference{ID: r.f.claim.Specification.LaunchId, Kind: "launch", ExpiresAt: r.command.ExpiresAt}, r.f.now); err != nil {
		t.Fatal(err)
	}
	if err := r.processChild(t); err == nil || r.f.opens != 0 || r.childCommand(t).CleanupLockID != "" || r.cloudReleased {
		t.Fatal("early child was launched or irreversibly cleaned up", err)
	}
	if err := r.f.local.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := daemon.OpenStore(ctx, r.f.local.Paths)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	r.f.store = NewIntentStore(reopened.DB)
	if err := r.f.store.recoverControls(ctx); err != nil {
		t.Fatal(err)
	}
	if err := r.process(); err != nil || r.claims != 2 {
		t.Fatal("original control claim did not recover", err)
	}
	if err := r.processChild(t); err != nil || r.f.opens != 1 {
		t.Fatal("recovered child did not proceed exactly once", err)
	}
	if err := r.f.store.recoverControls(ctx); err != nil {
		t.Fatal(err)
	}
	if err := r.process(); err != nil || r.claims != 2 || r.f.opens != 1 || mustResumeEffect(t, r).State != "applying" {
		t.Fatal("restart replayed or invented a completed resume", err)
	}
}

func TestResumeBindingAndCapabilityChangesCannotReachTerminal(t *testing.T) {
	r := fixtureResume(t, fixtureQueueBinary(t), true)
	if err := r.process(); err != nil {
		t.Fatal(err)
	}
	original := r.f.claim
	for name, mutate := range map[string]func(*generated.LaunchClaimResult){
		"execution": func(v *generated.LaunchClaimResult) {
			v.Assignment.RunExecutionId, v.Specification.RunExecutionId = r.source.Claim.Assignment.RunExecutionId, r.source.Claim.Assignment.RunExecutionId
		},
		"generation": func(v *generated.LaunchClaimResult) {
			v.Assignment.AssignmentGeneration, v.Specification.AssignmentGeneration = r.source.Claim.Assignment.AssignmentGeneration, r.source.Claim.Assignment.AssignmentGeneration
		},
		"fence": func(v *generated.LaunchClaimResult) { v.FencingGeneration = r.source.Claim.FencingGeneration },
		"run": func(v *generated.LaunchClaimResult) {
			v.Assignment.RunId, v.Specification.RunId = daemon.NewRequestID(), daemon.NewRequestID()
		},
		"snapshot": func(v *generated.LaunchClaimResult) { v.Specification.ConfigSnapshotId = daemon.NewRequestID() },
		"expiry": func(v *generated.LaunchClaimResult) {
			v.Specification.ExpiresAt = localTimestamp(r.f.now.Add(time.Minute))
		},
		"session": func(v *generated.LaunchClaimResult) {
			v.Specification.ResumeSession = map[string]any{"provider_session_id": "unknown", "observed_session_id": "--last"}
		},
		"missing_session": func(v *generated.LaunchClaimResult) { v.Specification.ResumeSession = nil },
	} {
		t.Run(name, func(t *testing.T) {
			claim := original
			mutate(&claim)
			if _, err := resumeForClaim(context.Background(), r.f.store.db, claim, r.f.now); err == nil {
				t.Fatal("changed resume binding accepted")
			}
		})
	}
	// The source snapshot still has its certified identity; removing the new
	// capability from the locally probed manifest cannot silently use Launch.
	r.f.service.options.Providers, _ = provider.NewRegistry([]provider.Descriptor{func() provider.Descriptor {
		descriptor := fake.Descriptor()
		descriptor.Manifest.Capabilities = slices.DeleteFunc(descriptor.Manifest.Capabilities, func(v string) bool { return v == "session.resume.interactive" })
		return descriptor
	}()})
	if err := r.processChild(t); err == nil || r.f.opens != 0 {
		t.Fatal("changed resume manifest reached Terminal", err)
	}
}

func attachResumeChild(t *testing.T, r *resumeFixture) (LocalAssignment, func()) {
	t.Helper()
	ctx := context.Background()
	if err := r.processChild(t); err != nil {
		t.Fatal(err)
	}
	child, err := r.f.store.ByCommand(ctx, r.childCommand(t))
	if err != nil || child == nil {
		t.Fatal(err)
	}
	owner, process, stop := startResumeSource(t, r.f.installation.Executable)
	if _, err = r.f.store.Register(ctx, child.IntentID, owner, r.f.now); err != nil {
		t.Fatal(err)
	}
	lock := daemon.NewRequestID()
	if _, err = r.f.store.PinOwnership(ctx, child.IntentID, owner, lock, nil, r.f.now); err != nil {
		t.Fatal(err)
	}
	assignment, err := r.f.store.PinOwnership(ctx, child.IntentID, owner, lock, &process, r.f.now)
	if err != nil {
		t.Fatal(err)
	}
	captureFixture(t, r.f.store, assignment, processCapture{State: "live", ProviderImage: true}, r.f.now, "execution_attached")
	return assignment, stop
}

func TestResumeAcknowledgesOnlyObservedAndCanonicalChildStart(t *testing.T) {
	r := fixtureResume(t, fixtureQueueBinary(t), true)
	if err := r.process(); err != nil {
		t.Fatal(err)
	}
	r.cloudStarted = true
	if err := r.process(); err != nil || mustResumeEffect(t, r).State != "applying" || r.acks != 0 {
		t.Fatal("cloud-only start invented a local effect", err)
	}
	child, stop := attachResumeChild(t, r)
	r.cloudStarted = false
	if err := r.process(); err != nil || mustResumeEffect(t, r).State != "applying" || r.acks != 0 {
		t.Fatal("local-only start invented a canonical acknowledgement", err)
	}
	r.cloudStarted = true
	if err := r.process(); err != nil || mustResumeEffect(t, r).State != "applied" || r.acks != 0 {
		t.Fatal("observed child was not recorded before acknowledgement", err)
	}
	stop()
	r.f.now = time.Now()
	captureFixture(t, r.f.store, child, processCapture{State: "gone"}, r.f.now, "execution_ended")
	r.loseAck = true
	if err := r.process(); err == nil {
		t.Fatal("lost acknowledgement treated as delivered")
	}
	for range 3 {
		if err := r.process(); err != nil {
			t.Fatal(err)
		}
	}
	command, err := r.f.store.Command(context.Background(), r.command.RunnerID, r.command.ID)
	if err != nil || command.State != "complete" || r.acks != 1 || r.claims != 1 || r.f.opens != 1 || mustResumeEffect(t, r).State != "applied" {
		t.Fatal("late/lost acknowledgement replayed a resume", err)
	}
}

func TestResumeRestartBetweenBindingAndChildAcceptance(t *testing.T) {
	r := fixtureResume(t, fixtureQueueBinary(t), true)
	if _, err := r.f.store.db.Exec(`CREATE TRIGGER synthetic_resume_inbox_full BEFORE INSERT ON execution_commands
WHEN NEW.command_kind = 'launch' BEGIN SELECT RAISE(ABORT,'synthetic inbox full'); END`); err != nil {
		t.Fatal(err)
	}
	if err := r.process(); err == nil || mustResumeEffect(t, r).State != "applying" || r.f.opens != 0 || r.claims != 1 {
		t.Fatal("child acceptance failure lost its durable binding", err)
	}
	started := mustResumeEffect(t, r)
	if _, err := r.f.store.db.Exec("DROP TRIGGER synthetic_resume_inbox_full"); err != nil {
		t.Fatal(err)
	}
	if err := r.f.local.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := daemon.OpenStore(context.Background(), r.f.local.Paths)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	r.f.store = NewIntentStore(reopened.DB)
	if err := r.f.store.recoverControls(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := r.process(); err != nil || mustResumeEffect(t, r) != started || r.claims != 1 {
		t.Fatal("restart reclaimed or replaced a resume", err)
	}
	if err := r.processChild(t); err != nil || r.f.opens != 1 {
		t.Fatal("same child did not resume after acceptance recovered", err)
	}
}

func TestResumeSourceAndAuthorizationFaultsNeverDispatchAChild(t *testing.T) {
	binary := fixtureQueueBinary(t)
	for _, fault := range []string{"source_not_settled", "missing_release_proof", "incomplete_history", "live_retained_child", "live_reused_pid", "post_claim_child", "slow_claim", "backward_claim", "expired_claim", "authorization_lost"} {
		t.Run(fault, func(t *testing.T) {
			r := fixtureResume(t, binary, fault != "source_not_settled")
			ctx := context.Background()
			addLive := func(reuse, staleRelease bool) {
				_, live := fixtureSleep(t)
				history, err := readNativeHistory(ctx, r.f.store.db, r.source)
				if err != nil {
					t.Fatal(err)
				}
				if reuse {
					live.StartIdentity = "1:1"
				}
				history.Group.Observed[live.PID] = live
				history.Group.Unknown, history.Group.HadEscape, history.Uncertain = true, true, true
				// Inject either an enlarged history or a stale claimed release.
				// Fresh kernel inspection must reject a live PID in either case.
				if staleRelease {
					history.ReleasedGroupHash = nativeGroupHash(history.Group)
				}
				if _, err = r.f.store.rememberNative(ctx, r.source, history); err != nil {
					t.Fatal(err)
				}
			}
			switch fault {
			case "missing_release_proof":
				history, _ := readNativeHistory(ctx, r.f.store.db, r.source)
				history.ReleasedGroupHash = ""
				data, _ := json.Marshal(history)
				if _, err := r.f.store.db.Exec("UPDATE execution_native_history SET history_json = ? WHERE execution_id = ?", string(data), r.source.Claim.Assignment.RunExecutionId); err != nil {
					t.Fatal(err)
				}
			case "incomplete_history":
				history, _ := readNativeHistory(ctx, r.f.store.db, r.source)
				history.Group.Unknown, history.Group.Incomplete, history.Uncertain = true, true, true
				if _, err := r.f.store.rememberNative(ctx, r.source, history); err != nil {
					t.Fatal(err)
				}
			case "live_retained_child":
				addLive(false, true)
			case "live_reused_pid":
				addLive(true, true)
			case "post_claim_child":
				r.claimHook = func() { addLive(false, false) }
			case "slow_claim":
				r.claimHook = func() { r.f.now = r.f.now.Add(6 * time.Second) }
			case "backward_claim":
				r.claimHook = func() { r.f.now = r.f.now.Add(-time.Second) }
			case "expired_claim":
				r.claimHook = func() {
					r.receipt.State, r.receipt.Disposition, r.receipt.ResumeLaunchId = "expired", new("expired"), nil
				}
			case "authorization_lost":
				r.claimHook = func() {
					r.receipt.State, r.receipt.Disposition, r.receipt.ResumeLaunchId = "rejected", new("authorization_lost"), nil
				}
			}
			err := r.process()
			terminal := fault == "expired_claim" || fault == "authorization_lost"
			if (err == nil) != terminal || r.f.opens != 0 || mustResumeEffect(t, r).State != "prepared" {
				t.Fatal("invalid resume dispatched a local effect", err)
			}
			var children int
			if r.f.store.db.QueryRow("SELECT count(*) FROM execution_commands WHERE command_id = ?", r.f.claim.Specification.LaunchId).Scan(&children) != nil || children != 0 {
				t.Fatal("invalid resume enqueued a child")
			}
		})
	}
}

func TestResumeConcurrentBeginHasOneWinner(t *testing.T) {
	r := fixtureResume(t, fixtureQueueBinary(t), true)
	ctx := context.Background()
	r.receipt.State, r.receipt.ResumeLaunchId = "claimed", &r.f.claim.Specification.LaunchId
	effect, err := r.f.store.rememberControl(ctx, r.command, r.receipt)
	if err != nil {
		t.Fatal(err)
	}
	source, err := readResumeSource(ctx, r.f.store.db, effect, r.f.now)
	if err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	winners := make(chan controlEffect, 8)
	for range 8 {
		workers.Go(func() {
			if applied, err := r.f.store.beginResumeControl(ctx, r.command, effect, source, r.f.now); err == nil {
				winners <- applied
			}
		})
	}
	workers.Wait()
	if len(winners) != 1 || mustResumeEffect(t, r).State != "applying" || r.f.opens != 0 {
		t.Fatal("concurrent resume began more than one delivery")
	}
}
