// ABOUTME: Checks complete cloud capture confirmation against the daemon's immutable supervised assignment.
// ABOUTME: Retains bounded in-memory timing only after fresh native ownership and trusted session checks.

package agentwork

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/journal"
	"github.com/qdis/bfb/internal/localmcp"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/runner"
	"github.com/qdis/bfb/internal/supervisor"
)

type workConfirmation struct {
	value  generated.AgentCaptureConfirmationResult
	timing *captureTiming
}

func confirmationKey(reference generated.AgentWorkRequest, binding generated.AgentSessionReference) string {
	data, _ := json.Marshal([]any{reference.RunExecutionId, reference.AssignmentGeneration, binding})
	return string(data)
}

func (service *workService) localAuthority(ctx context.Context, reference generated.AgentWorkRequest, binding generated.AgentSessionReference) (generated.LaunchClaimResult, error) {
	if err := service.ownership(ctx, reference.RunExecutionId, reference.AssignmentGeneration); err != nil {
		return generated.LaunchClaimResult{}, ownershipError(err)
	}
	intents := supervisor.NewIntentStore(service.store.DB)
	view, err := intents.JournalByExecution(ctx, reference.RunExecutionId, reference.AssignmentGeneration)
	if err != nil {
		return generated.LaunchClaimResult{}, ownershipError(err)
	}
	assignment, err := intents.ByIntent(ctx, view.IntentID)
	if err != nil {
		return generated.LaunchClaimResult{}, ownershipError(err)
	}
	observed, err := (localmcp.JournalBindings{Sessions: journal.NewStore(service.store.DB)}).ObservedBinding(ctx, localmcp.AssignmentRef{ExecutionID: reference.RunExecutionId, AssignmentGeneration: reference.AssignmentGeneration, RunID: view.RunID})
	if err != nil {
		if errors.Is(err, localmcp.ErrSessionNotBound) {
			return generated.LaunchClaimResult{}, &daemon.Failure{Code: "session_not_bound"}
		}
		return generated.LaunchClaimResult{}, &daemon.Failure{Code: "storage_failed"}
	}
	if observed.Provider != binding.Provider || observed.ObservedSessionID != binding.ObservedSessionId {
		return generated.LaunchClaimResult{}, &daemon.Failure{Code: "session_conflict"}
	}
	return assignment.Claim, nil
}

func confirmationMatchesClaim(value generated.AgentCaptureConfirmationResult, claim generated.LaunchClaimResult, binding generated.AgentSessionReference) bool {
	a, s := claim.Assignment, claim.Snapshot
	return value.WorkspaceId == a.WorkspaceId && value.ProjectId == a.ProjectId && value.SourceTaskId == a.TaskId &&
		value.RunId == a.RunId && value.RunExecutionId == a.RunExecutionId && value.AssignmentGeneration == a.AssignmentGeneration &&
		value.RunnerId == a.RunnerId && value.CheckoutId == a.CheckoutId && value.FencingGeneration == claim.FencingGeneration &&
		value.PhysicalWorktreeHash == s.PhysicalWorktreeHash && value.Binding == binding &&
		value.SnapshotHash == claim.Specification.ConfigSnapshotHash && value.SnapshotGeneration == s.SnapshotGeneration &&
		value.WorkspacePolicyVersion == s.WorkspacePolicyVersion && value.ProjectPolicyVersion == s.ProjectPolicyVersion &&
		value.RepositoryConfigVersion == s.RepositoryConfigVersion && value.SnapshotRepositoryConfigHash == s.RepositoryConfigHash
}

// A failed contact can reuse only this process's still-valid original receipt.
// A known denial invalidates it. No persisted confirmation recreates an anchor.
func (service *workService) confirmation(ctx context.Context, reference generated.AgentWorkRequest, binding generated.AgentSessionReference, allowCached bool) (output workConfirmation, online bool, failure error) {
	defer func() { service.results.invalidateOnDenial(failure) }()
	key := confirmationKey(reference, binding)
	claim, err := service.inspect(ctx, reference, binding)
	if err != nil {
		delete(service.confirmations, key)
		return workConfirmation{}, false, err
	}
	channel, err := service.connection(claim.Assignment.RunnerId)
	var result []byte
	var timing *captureTiming
	requestID := daemon.NewRequestID()
	if err == nil {
		timing, err = newCaptureTiming(requestID, service.clock)
		if err != nil {
			delete(service.confirmations, key)
			return workConfirmation{}, false, &daemon.Failure{Code: "capture_invalid"}
		}
		body, _ := json.Marshal(generated.AgentCaptureConfirmationRequest{SchemaVersion: 1, RequestId: requestID, RunExecutionId: reference.RunExecutionId, AssignmentGeneration: reference.AssignmentGeneration, Binding: binding})
		result, err = requestWork(ctx, channel, "work/capture-confirmation", body)
	}
	if err != nil {
		failure := channelError(err, result)
		if transientWorkError(err) && allowCached {
			if cached, found := service.confirmations[key]; found && confirmationMatchesClaim(cached.value, claim, binding) {
				if _, timingErr := cached.timing.captureTime(); timingErr == nil {
					current, localErr := service.inspect(ctx, reference, binding)
					if localErr != nil {
						delete(service.confirmations, key)
						return workConfirmation{}, false, localErr
					}
					if confirmationMatchesClaim(cached.value, current, binding) {
						return cached, false, nil
					}
					delete(service.confirmations, key)
					return workConfirmation{}, false, &daemon.Failure{Code: "assignment_ended"}
				}
			}
		}
		delete(service.confirmations, key)
		return workConfirmation{}, false, failure
	}
	var value generated.AgentCaptureConfirmationResult
	if len(result) > 4096 || !protocol.DecodeWireDocument("agent-capture-confirmation-result", result).OK || json.Unmarshal(result, &value) != nil || value.ConfirmationId != requestID || !confirmationMatchesClaim(value, claim, binding) {
		delete(service.confirmations, key)
		return workConfirmation{}, false, &daemon.Failure{Code: "capture_invalid"}
	}
	current, err := service.inspect(ctx, reference, binding)
	if err != nil || !confirmationMatchesClaim(value, current, binding) {
		delete(service.confirmations, key)
		if err != nil {
			return workConfirmation{}, false, err
		}
		return workConfirmation{}, false, &daemon.Failure{Code: "assignment_ended"}
	}
	confirmed, _ := time.Parse(time.RFC3339Nano, value.ConfirmedAt)
	lease, _ := time.Parse(time.RFC3339Nano, value.LeaseExpiresAt)
	credential, _ := time.Parse(time.RFC3339Nano, value.CredentialExpiresAt)
	if timing.receive(requestID, confirmed, lease, credential) != nil {
		delete(service.confirmations, key)
		return workConfirmation{}, false, &daemon.Failure{Code: "capture_invalid"}
	}
	confirmation := workConfirmation{value, timing}
	// This is an availability cache, not durable permission or unbounded history.
	if len(service.confirmations) >= 1024 {
		clear(service.confirmations)
	}
	service.confirmations[key] = confirmation
	if service.results != nil {
		service.results.schedule(reference, binding)
	}
	return confirmation, true, nil
}

func transientWorkError(err error) bool {
	return !errors.Is(err, runner.ErrRevoked) && !errors.Is(err, runner.ErrAuthorization) && !errors.Is(err, runner.ErrProtocol)
}

// Token renewal and lease renewal change freshness, not the protected principal.
func sameCaptureAuthority(original, current generated.AgentCaptureConfirmationResult) bool {
	current.ConfirmationId = original.ConfirmationId
	current.ConfirmedAt = original.ConfirmedAt
	current.LeaseExpiresAt = original.LeaseExpiresAt
	current.CredentialExpiresAt = original.CredentialExpiresAt
	current.RunnerTokenEpoch = original.RunnerTokenEpoch
	a, _ := json.Marshal(original)
	b, _ := json.Marshal(current)
	left, e1 := protocol.NormalizeJSON(a)
	right, e2 := protocol.NormalizeJSON(b)
	return e1 == nil && e2 == nil && left == right
}
