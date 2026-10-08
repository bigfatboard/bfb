// ABOUTME: Exercises strict run-control binding and one-way effect delivery using real SQLite transactions.
// ABOUTME: Proves replay, target changes, expiry and restart cannot authorize a second local effect.

package supervisor

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/runner"
)

type controlFixture struct {
	store      *IntentStore
	local      *daemon.Store
	assignment LocalAssignment
	command    LocalCommand
	receipt    generated.RunControlResult
	now        time.Time
}

func fixtureControl(t *testing.T, action string) *controlFixture {
	t.Helper()
	ctx := context.Background()
	store, local, claim, now := fixtureIntents(t)
	assignment := issueFixture(t, store, claim, now)
	if _, err := store.Offer(ctx, assignment.IntentID); err != nil {
		t.Fatal(err)
	}
	owner := SupervisorIdentity{Process: fixtureProcess(1200, 1, 1200), ExecutableHash: provider.Hash(nil)}
	if _, err := store.Register(ctx, assignment.IntentID, owner, now); err != nil {
		t.Fatal(err)
	}
	group := fixtureProcess(1201, owner.Process.PID, 1201)
	lockID := daemon.NewRequestID()
	if _, err := store.PinOwnership(ctx, assignment.IntentID, owner, lockID, nil, now); err != nil {
		t.Fatal(err)
	}
	assignment, err := store.PinOwnership(ctx, assignment.IntentID, owner, lockID, &group, now)
	if err != nil {
		t.Fatal(err)
	}
	// Run controls remain possible after the original launch deadline. Their
	// separate short-lived expiry, not a launch retry, bounds the local effect.
	now = now.Add(time.Hour)
	reference := runner.CommandReference{ID: daemon.NewRequestID(), Kind: "run_control", ExpiresAt: localTimestamp(now.Add(120 * time.Second))}
	if err := store.Accept(ctx, runner.Enrollment{RunnerID: claim.Assignment.RunnerId, WorkspaceID: claim.Assignment.WorkspaceId}, reference, now); err != nil {
		t.Fatal(err)
	}
	command, err := store.Command(ctx, claim.Assignment.RunnerId, reference.ID)
	if err != nil {
		t.Fatal(err)
	}
	receipt := generated.RunControlResult{SchemaVersion: 1, ControlId: command.ID, RunExecutionId: claim.Assignment.RunExecutionId,
		AssignmentGeneration: claim.Assignment.AssignmentGeneration, RunnerId: command.RunnerID, Action: action, State: "pending", ExpiresAt: command.ExpiresAt}
	return &controlFixture{store: store, local: local, assignment: assignment, command: command, receipt: receipt, now: now}
}

func (f *controlFixture) prepare(t *testing.T) controlEffect {
	t.Helper()
	effect, err := f.store.rememberControl(context.Background(), f.command, f.receipt)
	if err != nil {
		t.Fatal(err)
	}
	return effect
}

func (f *controlFixture) begin(t *testing.T) controlEffect {
	t.Helper()
	effect := f.prepare(t)
	started, err := f.store.beginControl(context.Background(), f.command, effect, f.assignment, f.now)
	if err != nil {
		t.Fatal(err)
	}
	return started
}

func TestControlReceiptRejectsMalformedAndCoupledStateFaults(t *testing.T) {
	f := fixtureControl(t, "interrupt")
	valid, _ := json.Marshal(f.receipt)
	for _, action := range []string{"focus_existing", "resume", "interrupt", "terminate", "cancel"} {
		receipt := f.receipt
		receipt.Action = action
		if _, err := controlOutcome(encodedFixture(t, receipt), f.command); err != nil {
			t.Fatal("valid pending action", action, err)
		}
	}
	for _, fault := range []string{"duplicate", "unknown", "oversized", "trailing", "partial", "wrong_id", "wrong_runner", "expiry", "signal", "generation", "pending_disposition", "claimed_disposition", "applied_null", "rejected_applied", "expired_wrong", "resume_on_signal", "resume_pending", "resume_claim_missing", "resume_applied_missing", "resume_is_control"} {
		t.Run(fault, func(t *testing.T) {
			var document map[string]any
			_ = json.Unmarshal(valid, &document)
			switch fault {
			case "unknown":
				document["pid"] = 1201
			case "partial":
				delete(document, "disposition")
			case "wrong_id":
				document["control_id"] = daemon.NewRequestID()
			case "wrong_runner":
				document["runner_id"] = daemon.NewRequestID()
			case "expiry":
				document["expires_at"] = localTimestamp(f.now.Add(time.Hour))
			case "signal":
				document["action"] = "SIGKILL"
			case "generation":
				document["assignment_generation"] = 0
			case "pending_disposition":
				document["disposition"] = "applied"
			case "claimed_disposition":
				document["state"], document["disposition"] = "claimed", "already_applied"
			case "applied_null":
				document["state"] = "applied"
			case "rejected_applied":
				document["state"], document["disposition"] = "rejected", "applied"
			case "expired_wrong":
				document["state"], document["disposition"] = "expired", "local_rejected"
			case "resume_on_signal":
				document["state"], document["resume_launch_id"] = "claimed", daemon.NewRequestID()
			case "resume_pending":
				document["action"], document["resume_launch_id"] = "resume", daemon.NewRequestID()
			case "resume_claim_missing":
				document["action"], document["state"] = "resume", "claimed"
			case "resume_applied_missing":
				document["action"], document["state"], document["disposition"] = "resume", "applied", "applied"
			case "resume_is_control":
				document["action"], document["state"], document["resume_launch_id"] = "resume", "claimed", f.command.ID
			}
			data, _ := json.Marshal(document)
			switch fault {
			case "duplicate":
				data = []byte(strings.Replace(string(data), `"schema_version":1`, `"schema_version":1,"schema_version":1`, 1))
			case "oversized":
				data = append(data, []byte(strings.Repeat(" ", 8192))...)
			case "trailing":
				data = append(data, []byte(" {}")...)
			}
			if _, err := controlOutcome(data, f.command); err == nil {
				t.Fatal("confused receipt accepted")
			}
		})
	}
}

func TestControlBindingIsImmutableBeforeAndAfterClaim(t *testing.T) {
	for _, fault := range []string{"execution", "generation", "action", "workspace", "runner", "claim", "accepted_at", "expiry", "launch_kind", "cleanup"} {
		t.Run(fault, func(t *testing.T) {
			f := fixtureControl(t, "interrupt")
			original := f.prepare(t)
			command, receipt := f.command, f.receipt
			switch fault {
			case "execution":
				receipt.RunExecutionId = daemon.NewRequestID()
			case "generation":
				receipt.AssignmentGeneration++
			case "action":
				receipt.Action = "terminate"
			case "workspace":
				command.WorkspaceID = daemon.NewRequestID()
			case "runner":
				command.RunnerID, receipt.RunnerId = daemon.NewRequestID(), daemon.NewRequestID()
			case "claim":
				command.ClaimKey = daemon.NewRequestID()
			case "accepted_at":
				command.ClaimStartedAt = localTimestamp(f.now.Add(time.Second))
			case "expiry":
				command.ExpiresAt = localTimestamp(f.now.Add(time.Minute))
				receipt.ExpiresAt = command.ExpiresAt
			case "launch_kind":
				command.Kind = "launch"
			case "cleanup":
				command.CleanupLockID = daemon.NewRequestID()
			}
			if _, err := f.store.rememberControl(context.Background(), command, receipt); err == nil {
				t.Fatal("immutable control retargeted")
			}
			current, err := f.store.control(context.Background(), f.command)
			if err != nil || current == nil || *current != original {
				t.Fatal("failed binding changed original", err)
			}
		})
	}
}

func TestControlResumeChildIsPinnedOnceWithoutStartingNativeEffect(t *testing.T) {
	f := fixtureControl(t, "resume")
	prepared := f.prepare(t)
	child := daemon.NewRequestID()
	f.receipt.State, f.receipt.ResumeLaunchId = "claimed", &child
	pinned := f.prepare(t)
	if pinned.ResumeLaunchID != child || pinned.ClaimKey != prepared.ClaimKey || pinned.State != "prepared" {
		t.Fatal("resume claim did not retain original binding")
	}
	if _, err := f.store.beginControl(context.Background(), f.command, pinned, f.assignment, f.now); err == nil {
		t.Fatal("resume treated as a signal for the previous execution")
	}
	other := daemon.NewRequestID()
	for _, replacement := range []*string{nil, &other} {
		receipt := f.receipt
		receipt.State, receipt.Disposition, receipt.ResumeLaunchId = "rejected", new("local_rejected"), replacement
		if _, err := f.store.rememberControl(context.Background(), f.command, receipt); err == nil {
			t.Fatal("resume identity cleared or replaced")
		}
	}
}

func TestControlConcurrentDeliveryHasOneWinnerAndCannotReopen(t *testing.T) {
	f := fixtureControl(t, "interrupt")
	prepared := f.prepare(t)
	start := make(chan struct{})
	winners := make(chan controlEffect, 16)
	var workers sync.WaitGroup
	for range 16 {
		workers.Go(func() {
			<-start
			if effect, err := f.store.beginControl(context.Background(), f.command, prepared, f.assignment, f.now); err == nil {
				winners <- effect
			}
		})
	}
	close(start)
	workers.Wait()
	if len(winners) != 1 {
		t.Fatal("delivery did not have exactly one winner")
	}
	started := <-winners
	if started.StartedAt != localTimestamp(f.now) || started.State != "applying" {
		t.Fatal("delivery preceded durable checkpoint")
	}
	if err := f.store.finishControl(context.Background(), prepared, "applied"); err == nil {
		t.Fatal("undelivered effect acknowledged")
	}
	for range 2 {
		if err := f.store.finishControl(context.Background(), started, "applied"); err != nil {
			t.Fatal("same acknowledgement not idempotent", err)
		}
	}
	for _, disposition := range []string{"local_rejected", "delivery_unknown", "already_applied", "SIGKILL"} {
		if err := f.store.finishControl(context.Background(), started, disposition); err == nil {
			t.Fatal("completed effect changed disposition")
		}
	}
	for _, statement := range []string{
		"UPDATE execution_control_effects SET state = 'prepared'",
		"UPDATE execution_control_effects SET effect_started_at = NULL",
		"UPDATE execution_control_effects SET action = 'terminate'",
		"UPDATE execution_control_effects SET claim_key = 'replacement'",
		"UPDATE execution_control_effects SET execution_id = 'replacement'",
		"UPDATE execution_control_effects SET expires_at = '2027-01-01T00:00:00Z'",
	} {
		if _, err := f.store.db.Exec(statement); err == nil {
			t.Fatal("database reopened or replaced a delivered control")
		}
	}
}

func TestControlDeliveryRechecksDeadlineAssignmentAndContainment(t *testing.T) {
	for _, fault := range []string{"expired", "clock_backwards", "owner", "group", "lock", "ended", "uncertain", "completed_command"} {
		t.Run(fault, func(t *testing.T) {
			f := fixtureControl(t, "terminate")
			prepared := f.prepare(t)
			observed, now := f.assignment, f.now
			switch fault {
			case "expired":
				now = now.Add(120 * time.Second)
			case "clock_backwards":
				now = now.Add(-time.Microsecond)
			case "owner":
				owner := *observed.Supervisor
				owner.Process.StartIdentity = "2000:42"
				observed.Supervisor = &owner
			case "group":
				group := *observed.Group
				group.StartIdentity = "2000:42"
				observed.Group = &group
			case "lock":
				observed.LockID = daemon.NewRequestID()
			case "ended":
				if _, err := f.store.db.Exec("UPDATE local_execution_assignments SET state = 'ended'"); err != nil {
					t.Fatal(err)
				}
			case "uncertain":
				if _, err := f.store.rememberNative(context.Background(), observed, nativeHistory{Uncertain: true}); err != nil {
					t.Fatal(err)
				}
			case "completed_command":
				f.receipt.State, f.receipt.Disposition = "expired", new("expired")
				if err := f.store.completeControl(context.Background(), f.command, f.receipt); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := f.store.beginControl(context.Background(), f.command, prepared, observed, now); err == nil {
				t.Fatal("stale delivery crossed local barrier")
			}
			current, err := f.store.control(context.Background(), f.command)
			if err != nil || current == nil || *current != prepared {
				t.Fatal("rejected delivery changed local effect", err)
			}
		})
	}
}

func TestControlRestartRetainsUncertaintyAndOriginalClaim(t *testing.T) {
	f := fixtureControl(t, "interrupt")
	started := f.begin(t)
	if err := f.local.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := daemon.OpenStore(context.Background(), f.local.Paths)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	service := NewService(ServiceOptions{})
	stop, err := service.Start(context.Background(), reopened)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	store := NewIntentStore(reopened.DB)
	current, err := store.control(context.Background(), f.command)
	if err != nil || current == nil || current.State != "delivery_unknown" || current.ClaimKey != started.ClaimKey || current.StartedAt != started.StartedAt {
		t.Fatal("restart forgot uncertain delivery", err)
	}
	if _, err := store.beginControl(context.Background(), f.command, *current, f.assignment, f.now); err == nil {
		t.Fatal("restart repeated ambiguous effect")
	}
	if err := store.finishControl(context.Background(), started, "applied"); err == nil {
		t.Fatal("late reply erased restart uncertainty")
	}
	if err := service.Accept(context.Background(), runner.Enrollment{RunnerID: f.command.RunnerID, WorkspaceID: f.command.WorkspaceID}, runner.CommandReference{ID: f.command.ID, Kind: "run_control", ExpiresAt: f.command.ExpiresAt}); err != nil {
		t.Fatal("service did not accept duplicate control", err)
	}
	command, err := store.Command(context.Background(), f.command.RunnerID, f.command.ID)
	if err != nil || command.ClaimKey != f.command.ClaimKey {
		t.Fatal("redelivery replaced original claim", err)
	}
}
