// ABOUTME: Delivers focus only for a freshly authorized live assignment and its kernel-observed Terminal device.
// ABOUTME: Rechecks native ownership for each signed-app effect and never repeats an ambiguous focus delivery.

package supervisor

import (
	"context"
	"os"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/runner"
)

func (service *Service) focusOwner(ctx context.Context, store *IntentStore, effect controlEffect) (LocalAssignment, string, error) {
	assignment, err := scanAssignment(store.db.QueryRowContext(ctx, "SELECT "+assignmentColumns+" FROM local_execution_assignments WHERE execution_id = ? AND assignment_generation = ?", effect.ExecutionID, effect.Generation))
	if err != nil || effect.Action != "focus_existing" || assignment.Supervisor == nil || assignment.Claim.Assignment.RunnerId != effect.RunnerID {
		return LocalAssignment{}, "", failure("execution_assignment_invalid")
	}
	verified, err := service.controlOwner(ctx, daemon.Peer{UID: os.Getuid(), PID: assignment.Supervisor.Process.PID}, assignment.IntentID)
	if err != nil || !sameObservedAssignment(assignment, verified) {
		return LocalAssignment{}, "", failure("containment_unknown")
	}
	tty, err := controllingTTY(verified.Supervisor.Process)
	return verified, tty, err
}

func (service *Service) processFocusControl(ctx context.Context, store *IntentStore, command LocalCommand, effect controlEffect, connection runner.RunnerConnection) error {
	if service.options.FocusTerminal == nil {
		return failure("app_unavailable")
	}
	before, tty, err := service.focusOwner(ctx, store, effect)
	if err != nil {
		return err
	}
	body, err := effect.claimRequest()
	if err != nil {
		return err
	}
	started := service.options.Now()
	data, err := requestLaunch(ctx, connection, "controls/claim", body)
	if err != nil {
		return err
	}
	receipt, err := controlOutcome(data, command)
	if err != nil || !effect.matches(command, receipt) {
		return failure("execution_assignment_invalid")
	}
	if controlTerminal(receipt) {
		return store.completeControl(ctx, command, receipt)
	}
	if receipt.State != "claimed" {
		return failure("execution_authorization_failed")
	}
	effect, err = store.rememberControl(ctx, command, receipt)
	if err != nil {
		return err
	}
	after, device, err := service.focusOwner(ctx, store, effect)
	if err != nil || !sameObservedAssignment(before, after) || device != tty {
		return failure("containment_unknown")
	}
	now := service.options.Now()
	if ctx.Err() != nil || now.Before(started) || now.Sub(started) > finalRequestLimit {
		return failure("execution_authorization_failed")
	}
	effect, err = store.beginControl(ctx, command, effect, after, now)
	if err != nil {
		return err
	}
	target := generated.LocalExecutionFocus{
		SchemaVersion: 1, TerminalIntentId: after.IntentID, ControlId: effect.ID,
		RunExecutionId: effect.ExecutionID, AssignmentGeneration: effect.Generation,
		Tty: tty, AuthorizedAt: effect.StartedAt, ExpiresAt: effect.ExpiresAt,
	}
	// The app supplies only the delivery ID when checking. These original
	// command, assignment, timestamp and device bindings stay inside the daemon.
	err = service.options.FocusTerminal(ctx, target, func(check context.Context) error {
		if ctx.Err() != nil {
			return failure("execution_authorization_failed")
		}
		service.mu.RLock()
		defer service.mu.RUnlock()
		if service.store != store || service.files == nil {
			return failure("daemon_offline")
		}
		return service.authorizeFocus(check, store, command, effect, after, target)
	})
	disposition := "applied"
	if err != nil {
		disposition = "local_rejected"
		if daemon.AsFailure(err).Code == "app_delivery_unknown" {
			disposition = "delivery_unknown"
		}
	}
	return store.finishControl(ctx, effect, disposition)
}

func (service *Service) authorizeFocus(ctx context.Context, store *IntentStore, command LocalCommand, effect controlEffect, original LocalAssignment, target generated.LocalExecutionFocus) error {
	current, err := store.Command(ctx, command.RunnerID, command.ID)
	if err != nil || (current.State != "queued" && current.State != "waiting") {
		return failure("execution_assignment_invalid")
	}
	bound, err := store.control(ctx, current)
	if err != nil || bound == nil || *bound != effect || bound.State != "applying" {
		return failure("execution_assignment_invalid")
	}
	started, err := time.Parse(time.RFC3339Nano, target.AuthorizedAt)
	deadline, deadlineErr := time.Parse(time.RFC3339Nano, target.ExpiresAt)
	now := service.options.Now()
	if err != nil || deadlineErr != nil || now.Before(started) || now.Sub(started) > finalRequestLimit || !now.Before(deadline) {
		return failure("expired_intent")
	}
	observed, tty, err := service.focusOwner(ctx, store, effect)
	if err != nil || !sameObservedAssignment(original, observed) || tty != target.Tty {
		return failure("containment_unknown")
	}
	now = service.options.Now()
	if ctx.Err() != nil || now.Before(started) || now.Sub(started) > finalRequestLimit || !now.Before(deadline) {
		return failure("expired_intent")
	}
	return nil
}
