// ABOUTME: Maintains C09 leases from fresh native inspection without replaying historical heartbeat authority.
// ABOUTME: Reconciles lost replies against the original claim and never touches a superseding local owner.

package supervisor

import (
	"context"
	"sync"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
)

func (service *Service) runLeases(ctx context.Context, store *IntentStore, files *AssignmentFiles, paths daemon.Paths) {
	if service.options.Connection == nil {
		<-ctx.Done()
		return
	}
	// Launch preparation can consume its full timeout; it must not occupy the
	// workers responsible for inspecting and renewing already running groups.
	const concurrency = 4
	finished := make(chan string, concurrency)
	inFlight := map[string]bool{}
	next := map[string]time.Time{}
	var workers sync.WaitGroup
	defer workers.Wait()
	inspector := service.nativeInspector(paths, files)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for ctx.Err() == nil {
		assignments, err := store.supervised(ctx)
		if err == nil {
			pending := map[string]bool{}
			for _, assignment := range assignments {
				id := assignment.IntentID
				pending[id] = true
				if len(inFlight) == concurrency || inFlight[id] || time.Now().Before(next[id]) {
					continue
				}
				inFlight[id] = true
				workers.Go(func() {
					attempt, cancel := context.WithTimeout(ctx, 15*time.Second)
					defer cancel()
					_ = service.maintainLease(attempt, store, inspector, id)
					finished <- id
				})
			}
			for id := range next {
				if !pending[id] && !inFlight[id] {
					delete(next, id)
				}
			}
		}
		select {
		case <-ctx.Done():
		case <-ticker.C:
		case id := <-finished:
			delete(inFlight, id)
			next[id] = time.Now().Add(processHeartbeatInterval)
		}
	}
}

func (service *Service) maintainLease(ctx context.Context, store *IntentStore, inspector nativeInspector, intent string) error {
	assignment, err := store.ByIntent(ctx, intent)
	if err != nil || assignment.Supervisor == nil {
		return failure("execution_assignment_invalid")
	}
	// Before the first pinned final request no provider can pass the child
	// gate. Cleanup of that distinct registered phase has no lease identity.
	if assignment.LockID == "" {
		return nil
	}
	command, err := store.Command(ctx, assignment.Claim.Assignment.RunnerId, assignment.Claim.Specification.LaunchId)
	if err != nil || command.State == "complete" {
		return err
	}
	if service.options.Connection == nil {
		return failure("daemon_offline")
	}
	connection, err := service.options.Connection(command.RunnerID)
	if err != nil || connection == nil {
		return failure("daemon_offline")
	}
	body, err := claimRequest(command)
	if err != nil {
		return err
	}
	data, err := requestLaunch(ctx, connection, "launch/reconcile", body)
	if err != nil {
		return err
	}
	receipt, err := reconciliation(data, command, &assignment)
	if err != nil {
		return err
	}
	if receipt.ReservationState == "released" || receipt.ReservationState == "superseded" {
		return service.settleRegistered(ctx, store, inspector, assignment)
	}
	if receipt.ObservationSequence == nil {
		return failure("execution_assignment_invalid")
	}
	// Reconciliation may take the entire network deadline. Inspect afterward,
	// never serialize an earlier observation or retry its previous wire body.
	facts, checkpoint, err := service.inspectNative(ctx, store, inspector, assignment)
	if err != nil {
		return err
	}
	observation := leaseObservation(assignment, facts, checkpoint.ProviderObserved != "", receipt.ReservationState)
	if observation == nil {
		return nil
	}
	if observation.Operation == "renew" && checkpoint.ProviderObserved == "" {
		// This inspection may be the only one to see the provider image before
		// its parent exits. Persist startup before C09 attaches the execution;
		// later child-only renewal must not depend on seeing that image again.
		if _, err = store.captureProcess(ctx, assignment, facts.Capture, facts.ObservedAt); err != nil {
			return err
		}
	}
	observation.Sequence, err = store.nextLeaseSequence(ctx, assignment, *receipt.ObservationSequence)
	if err != nil {
		return err
	}
	observation.ObservedAt = localTimestamp(facts.ObservedAt)
	encoded, err := wireJSON("checkout-lease-observation", observation)
	if err != nil {
		return err
	}
	now := service.options.Now()
	if now.Before(facts.ObservedAt) || now.Sub(facts.ObservedAt) > finalRequestLimit {
		return failure("containment_unknown")
	}
	if _, err = requestLaunch(ctx, connection, "leases/observe", encoded); err != nil {
		return err
	}
	if observation.Operation != "release" && observation.Operation != "recover" {
		return nil
	}
	// HTTP success (including a containment_unknown reply) is not release.
	// Only a strict canonical receipt can settle the original local command.
	data, err = requestLaunch(ctx, connection, "launch/reconcile", body)
	if err != nil {
		return err
	}
	settled, err := reconciliation(data, command, &assignment)
	if err != nil {
		return err
	}
	if settled.ReservationState != "released" && settled.ReservationState != "superseded" {
		return failure("containment_unknown")
	}
	return service.settleRegistered(ctx, store, inspector, assignment)
}

func leaseObservation(assignment LocalAssignment, facts nativeFacts, providerObserved bool, reservation string) *generated.CheckoutLeaseObservation {
	if facts.ObservedAt.IsZero() || facts.SupervisorState == "" || facts.GroupState == "" || facts.LockState == "" {
		return nil
	}
	leader := assignment.Group
	if facts.History.Group != nil {
		leader = &facts.History.Group.Leader
	}
	operation := "unknown"
	if facts.LocalReleased {
		operation = "release"
		if facts.RecoveryLocal {
			operation = "recover"
		} else if reservation == "containment_unknown" {
			operation = "unknown"
		}
	} else if leader == nil || assignment.Group == nil {
		// Do not pin C09 to a zero/mid-spawn group identity that may still grow.
		// An incomplete native marker remains occupied without a cloud renewal.
		return nil
	} else if !facts.History.Uncertain && facts.GroupState == "gone" && facts.SupervisorState == "verified" {
		return nil // Normal foreground restoration and helper exit are still in progress.
	} else if facts.Capture.State == "live" && !facts.History.Uncertain && facts.History.Group != nil && !facts.History.Group.Unknown {
		if !providerObserved && !facts.Capture.ProviderImage {
			return nil // A waiting signed wrapper is not provider startup.
		}
		if reservation != "containment_unknown" {
			operation = "renew"
		}
	}
	owner := assignment.Supervisor.wire()
	observation := &generated.CheckoutLeaseObservation{
		SchemaVersion: 1, RunExecutionId: assignment.Claim.Assignment.RunExecutionId,
		AssignmentGeneration: assignment.Claim.Assignment.AssignmentGeneration, FencingGeneration: assignment.Claim.FencingGeneration,
		Operation: operation, Supervisor: &owner, LocalLockId: assignment.LockID,
		SupervisorState: facts.SupervisorState, GroupState: facts.GroupState, LockState: facts.LockState,
		DescendantsState: facts.Descendants, RecoveryLocal: operation == "recover",
	}
	if leader != nil {
		observation.OwnedGroupId, observation.OwnedGroupStartIdentity = int64(leader.GroupID), leader.StartIdentity
	}
	return observation
}

func (service *Service) settleRegistered(ctx context.Context, store *IntentStore, inspector nativeInspector, assignment LocalAssignment) error {
	history, err := readNativeHistory(ctx, store.db, assignment)
	if err != nil {
		return err
	}
	if history.LocalReleasedAt == "" {
		if _, _, err = service.inspectNative(ctx, store, inspector, assignment); err != nil {
			return err
		}
	}
	service.nativeMu.Lock()
	defer service.nativeMu.Unlock()
	history, err = readNativeHistory(ctx, store.db, assignment)
	if err != nil || history.LocalReleasedAt == "" {
		return failure("containment_unknown")
	}
	// The checkpoint is not fresh release authority. After a canonical cloud
	// release it allows local settlement if another execution replaced the
	// physical marker; inspect only this execution's retained native identities.
	started := service.options.Now()
	table, err := inspector.processes()
	if err != nil {
		return failure("containment_unknown")
	}
	if owner, exists := table[assignment.Supervisor.Process.PID]; exists && !owner.Zombie {
		return failure("containment_unknown")
	}
	if history.Group != nil {
		history.Group.Observe(table)
		history, err = store.rememberNative(ctx, assignment, history)
		if err != nil || !history.Group.ProveGone(table) {
			return failure("containment_unknown")
		}
	} else if assignment.Group != nil {
		return failure("containment_unknown")
	}
	now := service.options.Now()
	if now.Before(started) || now.Sub(started) > finalRequestLimit {
		return failure("containment_unknown")
	}
	checkpoint, err := store.observationCheckpoint(ctx, assignment.IntentID)
	if err != nil {
		return err
	}
	if checkpoint.ProcessAbsent == "" && (history.Uncertain || (history.Group != nil && history.Group.Unknown)) {
		if _, err = store.captureProcess(ctx, assignment, processCapture{State: "unknown"}, now); err != nil {
			return err
		}
	}
	capture := processCapture{State: "gone"}
	if history.Group == nil {
		capture = processCapture{State: "never_started", Diagnostic: failure("launch_blocked")}
	}
	if _, err = store.captureProcess(ctx, assignment, capture, now); err != nil {
		return err
	}
	return store.completeRegistered(ctx, assignment)
}
