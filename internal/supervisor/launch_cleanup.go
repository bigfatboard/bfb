// ABOUTME: Settles unstarted C09 reservations using the original claim and durable local absence barrier.
// ABOUTME: Treats missing replies as pending and never releases a registered or ambiguously contained execution.

package supervisor

import (
	"context"
	"encoding/json"
	"time"

	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/runner"
)

func claimRequest(command LocalCommand) ([]byte, error) {
	return wireJSON("launch-claim", generated.LaunchClaim{
		SchemaVersion: 1, LaunchId: command.ID, RunnerId: command.RunnerID,
		IdempotencyKey: command.ClaimKey, ClaimedAt: command.ClaimStartedAt,
	})
}

func requestLaunch(ctx context.Context, connection runner.RunnerConnection, path string, body []byte) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, finalRequestLimit)
	defer cancel()
	data, err := connection.Request(ctx, "POST", path, body)
	if err != nil || ctx.Err() != nil {
		return nil, failure("execution_authorization_failed")
	}
	return data, nil
}

func reconciliation(data []byte, command LocalCommand, assignment *LocalAssignment) (generated.LaunchReconciliation, error) {
	var receipt generated.LaunchReconciliation
	if len(data) == 0 || len(data) > 8192 {
		return receipt, failure("execution_assignment_invalid")
	}
	decoded := protocol.DecodeWireDocument("launch-reconciliation", data)
	if !decoded.OK || json.Unmarshal([]byte(decoded.JSON), &receipt) != nil || receipt.WorkspaceId != command.WorkspaceID || receipt.RunnerId != command.RunnerID || receipt.LaunchId != command.ID {
		return generated.LaunchReconciliation{}, failure("execution_assignment_invalid")
	}
	if assignment != nil {
		claim := assignment.Claim
		if receipt.ReservationState == "never_acquired" || receipt.RunExecutionId != claim.Assignment.RunExecutionId || receipt.AssignmentGeneration != claim.Assignment.AssignmentGeneration || receipt.PhysicalWorktreeHash != claim.Snapshot.PhysicalWorktreeHash || (receipt.FencingGeneration != nil && *receipt.FencingGeneration != claim.FencingGeneration) {
			return generated.LaunchReconciliation{}, failure("execution_assignment_invalid")
		}
	}
	return receipt, nil
}

func (service *Service) cleanupUnstarted(ctx context.Context, store *IntentStore, command LocalCommand, connection runner.RunnerConnection) error {
	command, err := store.BeginUnstartedCleanup(ctx, command)
	if err != nil {
		return err
	}
	assignment, err := store.ByCommand(ctx, command)
	if err != nil {
		return err
	}
	body, err := claimRequest(command)
	if err != nil {
		return err
	}
	data, err := requestLaunch(ctx, connection, "launch/reconcile", body)
	if err != nil && assignment == nil {
		deadline, parseErr := time.Parse(time.RFC3339Nano, command.ExpiresAt)
		if parseErr == nil && !service.options.Now().Before(deadline) {
			// A pending command may never have reached C09 before local cleanup
			// began. The original expired claim can terminalize it; discard any
			// returned configuration and keep the local issuance barrier closed.
			_, _ = requestLaunch(ctx, connection, "launch/claim", body)
			data, err = requestLaunch(ctx, connection, "launch/reconcile", body)
		}
	}
	if err != nil {
		return err
	}
	receipt, err := reconciliation(data, command, assignment)
	if err != nil {
		return err
	}
	switch receipt.ReservationState {
	case "never_acquired", "released", "superseded":
		return store.CompleteUnstarted(ctx, command)
	case "reserved":
		if receipt.LaunchState == "started" {
			return failure("containment_unknown")
		}
	default:
		return failure("containment_unknown")
	}
	// No configuration or execution authority is obtained from this receipt.
	// The local transaction has already barred both issuance and registration.
	reject, err := wireJSON("launch-reject-request", generated.LaunchRejectRequest{
		SchemaVersion: 1, LaunchId: command.ID, RunExecutionId: receipt.RunExecutionId, AssignmentGeneration: receipt.AssignmentGeneration,
	})
	if err != nil {
		return err
	}
	if _, err = requestLaunch(ctx, connection, "launch/reject", reject); err != nil {
		return err
	}
	if receipt.ObservationSequence == nil || receipt.FencingGeneration == nil || *receipt.ObservationSequence >= 9007199254740991 {
		return failure("execution_assignment_invalid")
	}
	observation, err := wireJSON("checkout-lease-observation", generated.CheckoutLeaseObservation{
		SchemaVersion: 1, RunExecutionId: receipt.RunExecutionId, AssignmentGeneration: receipt.AssignmentGeneration,
		FencingGeneration: *receipt.FencingGeneration, Sequence: *receipt.ObservationSequence + 1, ObservedAt: localTimestamp(service.options.Now()),
		Operation: "release", LocalLockId: command.CleanupLockID, SupervisorState: "never_started", GroupState: "never_started",
		LockState: "never_acquired", DescendantsState: "none",
	})
	if err != nil {
		return err
	}
	if _, err = requestLaunch(ctx, connection, "leases/observe", observation); err != nil {
		return err
	}
	// Settle only from another strict, fully bound reconciliation receipt. A
	// successful HTTP status or a partial release acknowledgement is not proof.
	data, err = requestLaunch(ctx, connection, "launch/reconcile", body)
	if err != nil {
		return err
	}
	settled, err := reconciliation(data, command, assignment)
	if err != nil {
		return err
	}
	if settled.RunExecutionId != receipt.RunExecutionId || settled.AssignmentGeneration != receipt.AssignmentGeneration || settled.PhysicalWorktreeHash != receipt.PhysicalWorktreeHash ||
		(settled.FencingGeneration != nil && *settled.FencingGeneration != *receipt.FencingGeneration) || (settled.ReservationState != "released" && settled.ReservationState != "superseded") {
		return failure("containment_unknown")
	}
	return store.CompleteUnstarted(ctx, command)
}
