// ABOUTME: Tests helper-side control freshness, exact assignment binding and bounded asynchronous acknowledgement.
// ABOUTME: Uses synthetic typed delivery without accepting process identity or invocation data from a control.

package supervisor

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
)

func controlAssignment(binding LockBinding) generated.LocalExecutionAssignment {
	return generated.LocalExecutionAssignment{TerminalIntentId: "e0da52a9-d0cb-47d8-867b-e08f684b9001", Claim: generated.LaunchClaimResult{Assignment: generated.ExecutionAssignment{RunExecutionId: binding.ExecutionID, AssignmentGeneration: binding.AssignmentGeneration}}}
}

func helperDelivery(assignment generated.LocalExecutionAssignment, action string, now time.Time) generated.LocalExecutionControl {
	return generated.LocalExecutionControl{SchemaVersion: 1, TerminalIntentId: assignment.TerminalIntentId, ControlId: daemon.NewRequestID(), RunExecutionId: assignment.Claim.Assignment.RunExecutionId, AssignmentGeneration: assignment.Claim.Assignment.AssignmentGeneration, Action: action, AuthorizedAt: localTimestamp(now), ExpiresAt: localTimestamp(now.Add(2 * time.Minute))}
}

func TestHelperControlReplyRejectsConfusedAndStaleAuthority(t *testing.T) {
	assignment := controlAssignment(fixtureBinding())
	now := time.Now().UTC().Truncate(time.Millisecond)
	original := helperDelivery(assignment, "interrupt", now)
	for _, fault := range []string{"valid", "none", "extra", "wrong_field", "argv", "pid", "intent", "execution", "generation", "action", "expired", "future", "stale", "old_reply", "slow", "backwards"} {
		t.Run(fault, func(t *testing.T) {
			control := original
			started, completed := now, now
			payload := map[string]any{}
			switch fault {
			case "intent":
				control.TerminalIntentId = "e0da52a9-d0cb-47d8-867b-e08f684b9002"
			case "execution":
				control.RunExecutionId = daemon.NewRequestID()
			case "generation":
				control.AssignmentGeneration++
			case "action":
				control.Action = "resume"
			case "expired":
				control.ExpiresAt = localTimestamp(now)
			case "future":
				control.AuthorizedAt = localTimestamp(now.Add(time.Millisecond))
			case "stale":
				control.AuthorizedAt = localTimestamp(now.Add(-6 * time.Second))
			case "old_reply":
				control.AuthorizedAt = localTimestamp(now.Add(-2 * time.Second))
			case "slow":
				completed = now.Add(6 * time.Second)
			case "backwards":
				completed = now.Add(-time.Second)
			}
			encoded, _ := json.Marshal(control)
			var document map[string]any
			_ = json.Unmarshal(encoded, &document)
			payload["execution_control"] = document
			switch fault {
			case "none":
				payload = map[string]any{}
			case "extra":
				payload["status"] = "running"
			case "wrong_field":
				payload = map[string]any{"execution_assignment": document}
			case "argv":
				document["argv"] = []string{"synthetic"}
			case "pid":
				document["process_group_id"] = 1234
			}
			delivery, err := decodeHelperControl(payload, assignment, started, completed)
			if fault == "none" {
				if err != nil || delivery != nil {
					t.Fatal("empty poll invented authority", err)
				}
			} else if fault == "valid" {
				if err != nil || delivery == nil || *delivery != original {
					t.Fatal("valid bound delivery rejected", err)
				}
			} else if err == nil || delivery != nil {
				t.Fatal("unsafe reply accepted")
			}
		})
	}
}

func TestHelperControlPollerDrainsResultAfterLifetimeExit(t *testing.T) {
	assignment := controlAssignment(fixtureBinding())
	controls := make(chan helperControl)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done, acknowledged := make(chan struct{}), make(chan struct{}, 1)
	var polls atomic.Int32
	call := func(ctx context.Context, method string, payload map[string]any) (generated.LocalRpcEnvelope, error) {
		switch method {
		case "execution.control":
			if len(payload) != 1 || payload["terminal_intent_id"] != assignment.TerminalIntentId {
				t.Error("poll supplied authority")
			}
			polls.Add(1)
			return generated.LocalRpcEnvelope{Payload: map[string]any{"execution_control": helperDelivery(assignment, "terminate", time.Now())}}, nil
		case "execution.control_result":
			if ctx.Err() != nil || len(payload) != 3 || payload["control_disposition"] != "applied" || payload["terminal_intent_id"] != assignment.TerminalIntentId {
				t.Error("final result lost its independent deadline")
			}
			acknowledged <- struct{}{}
			return generated.LocalRpcEnvelope{}, failure("daemon_offline") // A lost acknowledgement is not another effect.
		default:
			t.Error("unexpected helper method")
		}
		return generated.LocalRpcEnvelope{}, failure("invalid_request")
	}
	go func() { defer close(done); pollHelperControls(ctx, assignment, controls, call) }()
	select {
	case control := <-controls:
		control.complete("applied")
		cancel()
	case <-time.After(2 * time.Second):
		t.Fatal("poller did not deliver")
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("poller did not join")
	}
	select {
	case <-acknowledged:
	default:
		t.Fatal("provider exit dropped its result")
	}
	if polls.Load() != 1 {
		t.Fatal("lost result triggered another delivery")
	}
}

func TestHelperControlPollerCancelsOfflineRequest(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	controls, entered, done := make(chan helperControl), make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		pollHelperControls(ctx, controlAssignment(fixtureBinding()), controls, func(ctx context.Context, _ string, _ map[string]any) (generated.LocalRpcEnvelope, error) {
			close(entered)
			<-ctx.Done()
			return generated.LocalRpcEnvelope{}, ctx.Err()
		})
	}()
	<-entered
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("offline poll blocked helper exit")
	}
	if _, open := <-controls; open {
		t.Fatal("offline request invented a control")
	}
}
