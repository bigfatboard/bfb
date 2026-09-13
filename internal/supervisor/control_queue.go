// ABOUTME: Reconciles durable run-control references and acknowledges only separately recorded local results.
// ABOUTME: Separates signed-helper signals from app focus and exact-session child-launch delivery.

package supervisor

import (
	"context"
	"time"

	"github.com/qdis/bfb/internal/protocol/generated"
)

func (service *Service) runControlQueue(ctx context.Context, store *IntentStore) {
	service.runCommands(ctx, store, "run_control", service.controlWake, 15*time.Second, time.Second, time.Second, func(ctx context.Context, command LocalCommand) error {
		return service.processControl(ctx, store, command)
	})
}

func (service *Service) processControl(ctx context.Context, store *IntentStore, pending LocalCommand) error {
	command, err := store.Command(ctx, pending.RunnerID, pending.ID)
	if err != nil || command.State == "complete" || command.State == "containment_unknown" {
		return err
	}
	if command.Kind != "run_control" || command.CleanupLockID != "" {
		return failure("execution_assignment_invalid")
	}
	if service.options.Connection == nil {
		return failure("daemon_offline")
	}
	connection, err := service.options.Connection(command.RunnerID)
	if err != nil || connection == nil {
		return failure("daemon_offline")
	}
	effect, err := store.control(ctx, command)
	if err != nil {
		return err
	}
	if effect != nil && effect.State == "applying" && effect.Action != "resume" {
		started, err := time.Parse(time.RFC3339Nano, effect.StartedAt)
		now := service.options.Now()
		if err != nil || now.Before(started) || now.Sub(started) > 2*finalRequestLimit {
			if err := store.finishControl(ctx, *effect, "delivery_unknown"); err != nil {
				return err
			}
		}
	}
	body, err := wireJSON("run-control-reference", generated.RunControlReference{SchemaVersion: 1, ControlId: command.ID})
	if err != nil {
		return err
	}
	data, err := requestLaunch(ctx, connection, "controls/read", body)
	if err != nil {
		return err
	}
	receipt, err := controlOutcome(data, command)
	if err != nil || effect != nil && !effect.matches(command, receipt) {
		return failure("execution_assignment_invalid")
	}
	if controlTerminal(receipt) {
		return store.completeControl(ctx, command, receipt)
	}
	current, err := store.rememberControl(ctx, command, receipt)
	if err != nil {
		return err
	}
	if current.State == "prepared" || current.State == "applying" {
		// Only the authenticated effect owner claims immediately before its
		// effect. Reclaiming here could reject an in-flight termination after
		// its group ends but before the helper acknowledges its signal.
		deadline, _ := time.Parse(time.RFC3339Nano, command.ExpiresAt)
		if (current.State == "prepared" || current.Action == "resume") && !service.options.Now().Before(deadline) {
			body, err = current.claimRequest()
			if err != nil {
				return err
			}
			data, err = requestLaunch(ctx, connection, "controls/claim", body)
			if err != nil {
				return err
			}
			receipt, err = controlOutcome(data, command)
			if err != nil || !current.matches(command, receipt) || !controlTerminal(receipt) {
				return failure("execution_authorization_failed")
			}
			return store.completeControl(ctx, command, receipt)
		}
		if current.Action == "resume" {
			return service.processResumeControl(ctx, store, command, current, connection)
		}
		if current.Action == "focus_existing" && current.State == "prepared" {
			return service.processFocusControl(ctx, store, command, current, connection)
		}
		return nil
	}
	if receipt.State != "claimed" {
		return failure("execution_authorization_failed")
	}
	body, err = current.dispositionRequest()
	if err != nil {
		return err
	}
	data, err = requestLaunch(ctx, connection, "controls/acknowledge", body)
	if err != nil {
		return err
	}
	receipt, err = controlOutcome(data, command)
	if err != nil || !current.matches(command, receipt) || !controlTerminal(receipt) {
		return failure("execution_assignment_invalid")
	}
	return store.completeControl(ctx, command, receipt)
}
