// ABOUTME: Reproduces durable control delivery for launches that never created a local execution assignment.
// ABOUTME: Keeps terminal cloud receipts and expiry cleanup separate from any native effect or local success record.

package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/runner"
)

func fixtureUnassignedControl(t *testing.T) *controlFixture {
	t.Helper()
	store, local, claim, now := fixtureIntents(t)
	ref := runner.CommandReference{ID: daemon.NewRequestID(), Kind: "run_control", ExpiresAt: localTimestamp(now.Add(2 * time.Minute))}
	if err := store.Accept(context.Background(), runner.Enrollment{RunnerID: claim.Assignment.RunnerId, WorkspaceID: claim.Assignment.WorkspaceId}, ref, now); err != nil {
		t.Fatal(err)
	}
	command, err := store.Command(context.Background(), claim.Assignment.RunnerId, ref.ID)
	if err != nil {
		t.Fatal(err)
	}
	return &controlFixture{store: store, local: local, command: command, now: now, receipt: generated.RunControlResult{
		SchemaVersion: 1, ControlId: command.ID, RunExecutionId: claim.Assignment.RunExecutionId, AssignmentGeneration: claim.Assignment.AssignmentGeneration,
		RunnerId: command.RunnerID, Action: "cancel", State: "pending", ExpiresAt: command.ExpiresAt,
	}}
}

func TestUnassignedControlTerminalReceiptClosesOnlyDelivery(t *testing.T) {
	for _, terminal := range []struct{ state, disposition string }{{"applied", "applied"}, {"rejected", "local_rejected"}, {"expired", "expired"}} {
		t.Run(terminal.state, func(t *testing.T) {
			f := fixtureUnassignedControl(t)
			f.receipt.State, f.receipt.Disposition = terminal.state, new(terminal.disposition)
			reads := 0
			service := controlService(t, f, func(_ context.Context, _, path string, _ []byte) ([]byte, error) {
				if path != "controls/read" {
					t.Error("terminal receipt caused a claim or native acknowledgement")
				}
				reads++
				return json.Marshal(f.receipt)
			})
			for range 2 {
				if err := service.processControl(context.Background(), f.store, f.command); err != nil {
					t.Fatal("terminal control stranded without an assignment", err)
				}
				if err := f.store.Accept(context.Background(), runner.Enrollment{RunnerID: f.command.RunnerID, WorkspaceID: f.command.WorkspaceID}, runner.CommandReference{ID: f.command.ID, Kind: "run_control", ExpiresAt: f.command.ExpiresAt}, f.now); err != nil {
					t.Fatal(err)
				}
			}
			command, err := f.store.Command(context.Background(), f.command.RunnerID, f.command.ID)
			if err != nil || command.State != "complete" || reads != 1 {
				t.Fatal("terminal receipt replayed delivery", err, reads)
			}
			for _, table := range []string{"execution_control_effects", "local_execution_assignments", "execution_observations"} {
				var count int
				if err := f.local.DB.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != 0 {
					t.Fatal("terminal receipt invented a local effect", table, err)
				}
			}
		})
	}
}

func TestUnassignedControlExpiresWithoutClaimingAnUnexpiredOrResumedEffect(t *testing.T) {
	f := fixtureUnassignedControl(t)
	claims := 0
	service := controlService(t, f, func(_ context.Context, _, path string, body []byte) ([]byte, error) {
		if path == "controls/read" {
			return json.Marshal(f.receipt)
		}
		if path != "controls/claim" {
			t.Error("expiry attempted another action")
			return nil, errors.New("unexpected action")
		}
		claims++
		var request generated.RunControlClaim
		if json.Unmarshal(body, &request) != nil || request.ControlId != f.command.ID || request.IdempotencyKey != f.command.ClaimKey || request.RunExecutionId != f.receipt.RunExecutionId || request.AssignmentGeneration != f.receipt.AssignmentGeneration || request.Action != "cancel" {
			t.Error("expiry lost the original control binding")
		}
		f.receipt.State, f.receipt.Disposition = "expired", new("expired")
		return nil, errors.New("synthetic lost expiration response")
	})
	if err := service.processControl(context.Background(), f.store, f.command); err == nil || claims != 0 {
		t.Fatal("unexpired control without an assignment reached a claim", err)
	}
	f.now = f.now.Add(3 * time.Minute)
	f.receipt.Action = "resume"
	if err := service.processControl(context.Background(), f.store, f.command); err == nil || claims != 0 {
		t.Fatal("missing resume source could create a child through clock-skewed expiry", err)
	}
	f.receipt.Action = "cancel"
	if err := service.processControl(context.Background(), f.store, f.command); err == nil || claims != 1 {
		t.Fatal("expiration did not reconcile the missing assignment", err, claims)
	}
	if err := service.processControl(context.Background(), f.store, f.command); err != nil || claims != 1 {
		t.Fatal("lost expiration response did not settle from its original receipt", err, claims)
	}
	command, _ := f.store.Command(context.Background(), f.command.RunnerID, f.command.ID)
	effect, err := f.store.control(context.Background(), command)
	if err != nil || command.State != "complete" || effect != nil {
		t.Fatal("expiry manufactured local delivery", err)
	}
}

func TestTerminalControlCannotHideAnExistingEffectByChangingItsAssignment(t *testing.T) {
	f := fixtureControl(t, "interrupt")
	f.prepare(t)
	f.receipt.RunExecutionId = daemon.NewRequestID()
	f.receipt.State, f.receipt.Disposition = "expired", new("expired")
	if err := f.store.completeControl(context.Background(), f.command, f.receipt); err == nil {
		t.Fatal("retargeted terminal receipt hid existing delivery")
	}
	command, _ := f.store.Command(context.Background(), f.command.RunnerID, f.command.ID)
	if command.State == "complete" {
		t.Fatal("retargeted receipt closed delivery")
	}
}
