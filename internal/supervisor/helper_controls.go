// ABOUTME: Polls authenticated local control delivery without blocking the helper's native lifetime loop.
// ABOUTME: Validates exact assignment and freshness, then reports bounded signal outcomes without resending effects.

package supervisor

import (
	"context"
	"encoding/json"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
)

type helperControl struct {
	delivery generated.LocalExecutionControl
	result   chan string
}

func (control helperControl) complete(disposition string) {
	select {
	case control.result <- disposition:
	default:
	}
}

type helperControlCall func(context.Context, string, map[string]any) (generated.LocalRpcEnvelope, error)

func startHelperControls(paths daemon.Paths, assignment generated.LocalExecutionAssignment) (<-chan helperControl, func()) {
	ctx, cancel := context.WithCancel(context.Background())
	controls := make(chan helperControl)
	done := make(chan struct{})
	go func() {
		defer close(done)
		pollHelperControls(ctx, assignment, controls, func(ctx context.Context, method string, payload map[string]any) (generated.LocalRpcEnvelope, error) {
			return daemon.CallWithPeerAuthorization(ctx, paths, method, payload, func(peer daemon.Peer) error {
				_, err := InspectHelper(peer)
				return err
			})
		})
	}()
	return controls, func() { cancel(); <-done }
}

func pollHelperControls(ctx context.Context, assignment generated.LocalExecutionAssignment, controls chan<- helperControl, call helperControlCall) {
	defer close(controls)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for ctx.Err() == nil {
		started := time.Now()
		request, cancel := context.WithTimeout(ctx, finalRequestLimit)
		response, err := call(request, "execution.control", map[string]any{"terminal_intent_id": assignment.TerminalIntentId})
		if request.Err() != nil {
			err = failure("execution_authorization_failed")
		}
		cancel()
		var delivery *generated.LocalExecutionControl
		if err == nil {
			delivery, err = decodeHelperControl(response.Payload, assignment, started, time.Now())
		}
		if err == nil && delivery != nil {
			control := helperControl{delivery: *delivery, result: make(chan string, 1)}
			select {
			case controls <- control:
			case <-ctx.Done():
				return
			}
			var disposition string
			select {
			case disposition = <-control.result:
			case <-ctx.Done():
				// The lifetime owner reports any received pending command before
				// stopping this poller. Drain that result even during fast exit.
				select {
				case disposition = <-control.result:
				default:
					return
				}
			}
			// A final result gets one bounded delivery attempt even after the
			// provider exits. Lost acknowledgement is reconciled by the daemon,
			// never by another native action or a helper-side retry.
			ack, stop := context.WithTimeout(context.WithoutCancel(ctx), finalRequestLimit)
			_, _ = call(ack, "execution.control_result", map[string]any{
				"terminal_intent_id": assignment.TerminalIntentId, "control_id": delivery.ControlId, "control_disposition": disposition,
			})
			stop()
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func decodeHelperControl(payload map[string]any, assignment generated.LocalExecutionAssignment, started, now time.Time) (*generated.LocalExecutionControl, error) {
	if len(payload) == 0 {
		return nil, nil
	}
	if len(payload) != 1 || now.Before(started) || now.Sub(started) > finalRequestLimit {
		return nil, failure("execution_authorization_failed")
	}
	data, err := wireJSON("local-execution-control", payload["execution_control"])
	var control generated.LocalExecutionControl
	if err != nil || json.Unmarshal(data, &control) != nil || !validHelperControl(control, assignment, now) {
		return nil, failure("execution_assignment_invalid")
	}
	authorized, _ := time.Parse(time.RFC3339Nano, control.AuthorizedAt)
	if authorized.Before(started.Add(-time.Second)) {
		return nil, failure("execution_authorization_failed")
	}
	return &control, nil
}

func validHelperControl(control generated.LocalExecutionControl, assignment generated.LocalExecutionAssignment, now time.Time) bool {
	if control.SchemaVersion != 1 || !executionID.MatchString(control.ControlId) || !terminalIntent.MatchString(control.TerminalIntentId) ||
		control.TerminalIntentId != assignment.TerminalIntentId || control.RunExecutionId != assignment.Claim.Assignment.RunExecutionId ||
		control.AssignmentGeneration != assignment.Claim.Assignment.AssignmentGeneration ||
		(control.Action != "interrupt" && control.Action != "terminate" && control.Action != "cancel") {
		return false
	}
	authorized, err := time.Parse(time.RFC3339Nano, control.AuthorizedAt)
	deadline, deadlineErr := time.Parse(time.RFC3339Nano, control.ExpiresAt)
	return err == nil && deadlineErr == nil && !now.Before(authorized) && now.Sub(authorized) <= finalRequestLimit && now.Before(deadline)
}
