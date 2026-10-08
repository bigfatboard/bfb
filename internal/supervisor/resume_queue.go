// ABOUTME: Reauthorizes exact-session resume and dispatches only its immutable C09 child launch.
// ABOUTME: Reconciles durable native-start evidence before acknowledging without repeating Terminal delivery.

package supervisor

import (
	"context"

	"github.com/qdis/bfb/internal/runner"
)

func (service *Service) processResumeControl(ctx context.Context, store *IntentStore, command LocalCommand, effect controlEffect, connection runner.RunnerConnection) error {
	if effect.State == "prepared" {
		source, err := readResumeSource(ctx, store.db, effect, service.options.Now())
		if err != nil {
			return err
		}
		if err = source.verifyGone(); err != nil {
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
		now := service.options.Now()
		if now.Before(started) || now.Sub(started) > finalRequestLimit || ctx.Err() != nil {
			return failure("execution_authorization_failed")
		}
		effect, err = store.beginResumeControl(ctx, command, effect, source, now)
		if err != nil {
			return err
		}
	}
	if effect.State != "applying" || effect.Action != "resume" || !executionID.MatchString(effect.ResumeLaunchID) || effect.StartedAt == "" {
		return failure("execution_assignment_invalid")
	}
	// Claiming the control already created this exact durable C09 reference.
	// A crash between local effect binding and inbox acceptance simply retries
	// acceptance of the same ID; the launch queue never repeats an offered intent.
	if err := store.Accept(ctx, runner.Enrollment{WorkspaceID: command.WorkspaceID, RunnerID: command.RunnerID},
		runner.CommandReference{ID: effect.ResumeLaunchID, Kind: "launch", ExpiresAt: effect.ExpiresAt}, service.options.Now()); err != nil {
		return err
	}
	select {
	case service.wake <- struct{}{}:
	default:
	}
	childCommand, err := store.Command(ctx, command.RunnerID, effect.ResumeLaunchID)
	if err != nil {
		return err
	}
	child, err := store.ByCommand(ctx, childCommand)
	if err != nil {
		return err
	}
	if child == nil && childCommand.State != "complete" {
		return nil
	}
	observed := false
	if child != nil {
		source, err := readResumeSource(ctx, store.db, effect, service.options.Now())
		if err != nil {
			return err
		}
		if _, err = source.binding(child.Claim); err != nil {
			return err
		}
		checkpoint, err := store.observationCheckpoint(ctx, child.IntentID)
		if err != nil {
			return err
		}
		observed = checkpoint.ProviderObserved != ""
		if !observed && childCommand.State != "complete" {
			return nil
		}
	}
	body, err := claimRequest(childCommand)
	if err != nil {
		return err
	}
	data, err := requestLaunch(ctx, connection, "launch/reconcile", body)
	if err != nil {
		return err
	}
	receipt, err := reconciliation(data, childCommand, child)
	if err != nil {
		return err
	}
	if receipt.LaunchState == "started" && observed {
		return store.finishControl(ctx, effect, "applied")
	}
	if childCommand.State == "complete" && (receipt.LaunchState == "expired" || receipt.LaunchState == "rejected") &&
		(receipt.ReservationState == "never_acquired" || receipt.ReservationState == "released" || receipt.ReservationState == "superseded") {
		return store.finishControl(ctx, effect, "local_rejected")
	}
	return nil
}
