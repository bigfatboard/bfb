// ABOUTME: Admits explicit result submissions through current daemon authority and the shared protected journal.
// ABOUTME: Reconciles original signed identities after submission without authorizing another result version.

package agentwork

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/qdis/bfb/internal/auth"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/journal"
	"github.com/qdis/bfb/internal/localmcp"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/runner"
	"github.com/qdis/bfb/internal/supervisor"
)

func (service *workService) submitResult(ctx context.Context, input generated.AgentResultLocalRequest, reference generated.AgentWorkRequest, peerCheck func(context.Context) error) (map[string]any, error) {
	service.mu.Lock()
	defer service.mu.Unlock()
	if service.failed != nil || service.store == nil || service.journal == nil || service.results == nil {
		return nil, &daemon.Failure{Code: "storage_failed"}
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	if err := peerCheck(ctx); err != nil {
		service.results.invalidate()
		return nil, err
	}
	key, err := agentOperationKey("result.submit", reference)
	if err != nil {
		return nil, &daemon.Failure{Code: "request_rejected"}
	}
	record, found, err := service.journal.lookup(ctx, key)
	if err != nil {
		return nil, service.storageFailure(err)
	}
	var binding generated.AgentSessionReference
	if found {
		var original generated.AgentResultRequest
		if record.Intent.CaptureFamily != "agent_result" || json.Unmarshal([]byte(record.Intent.RequestJSON), &original) != nil {
			return nil, service.storageFailure(errWorkCorrupt)
		}
		binding = original.Binding
	} else if input.ExpectedBinding != nil {
		binding = *input.ExpectedBinding
	} else if cached, known := service.results.binding(reference); known {
		binding = cached
	} else {
		binding, err = service.bindCurrentAgentSession(ctx, reference, peerCheck)
		if err != nil {
			return nil, service.authorityError(err)
		}
	}
	if input.ExpectedBinding != nil && binding != *input.ExpectedBinding {
		service.results.invalidate()
		return nil, &daemon.Failure{Code: "session_conflict"}
	}
	if _, err := service.inspect(ctx, reference, binding); err != nil {
		return nil, service.authorityError(err)
	}
	// Preserve the actual unbound request, including optional empty arrays and
	// original text, while adding only the independently derived canonical binding.
	original := make(map[string]any, len(input.Request)+1)
	for field, value := range input.Request {
		original[field] = value
	}
	original["binding"] = binding
	encoded, err := json.Marshal(original)
	if err != nil {
		return nil, &daemon.Failure{Code: "request_rejected"}
	}
	canonical, err := protocol.CanonicalAgentWriteRequest("result.submit", encoded)
	if err != nil {
		return nil, &daemon.Failure{Code: "request_rejected"}
	}
	digest := sha256.Sum256([]byte(canonical))
	fingerprint := hex.EncodeToString(digest[:])
	command, _ := agentWorkCommand("result.submit")
	if found {
		if err := service.authorizeResultRecord(ctx, record, reference, binding); err != nil {
			if workFailureReason(err) != "work_unavailable" {
				service.results.invalidate()
			}
			denied, denyErr := service.deny(ctx, record, workFailureReason(err))
			if denyErr != nil {
				return nil, denyErr
			}
			return workResponse(command, denied, true)
		}
		if fingerprint != record.Intent.Fingerprint {
			return nil, &daemon.Failure{Code: "request_conflict"}
		}
		retried, err := service.dispatchResultRecord(ctx, record, peerCheck)
		if err != nil {
			return nil, err
		}
		return workResponse(command, retried, true)
	}
	confirmation, online, err := service.results.confirm(ctx, reference, binding, true)
	if err != nil {
		return nil, service.authorityError(err)
	}
	if !confirmation.value.CanSubmit {
		return nil, &daemon.Failure{Code: "invalid_transition"}
	}
	intent, err := prepareResultIntent(ctx, []byte(canonical), confirmation.value, confirmation.timing, service.resultSign)
	if err != nil {
		service.results.invalidate()
		if errors.Is(err, runner.ErrRevoked) || errors.Is(err, runner.ErrAuthorization) {
			return nil, &daemon.Failure{Code: "revoked"}
		}
		if daemon.AsFailure(err).Code == "storage_failed" {
			return nil, service.storageFailure(errWorkStorage)
		}
		if errors.Is(err, auth.ErrCredentialUnavailable) || errors.Is(err, auth.ErrCredentialNotFound) {
			return nil, &daemon.Failure{Code: "runner_credential_unavailable"}
		}
		if errors.Is(err, runner.ErrOffline) || ctx.Err() != nil {
			return nil, &daemon.Failure{Code: "offline_rejected"}
		}
		return nil, &daemon.Failure{Code: "capture_invalid"}
	}
	if !online && intent.AdmissionMode != "offline_admitted" {
		return nil, &daemon.Failure{Code: "offline_rejected"}
	}
	if err := peerCheck(ctx); err != nil {
		service.results.invalidate()
		return nil, err
	}
	current, err := service.inspect(ctx, reference, binding)
	if err != nil {
		return nil, service.authorityError(err)
	}
	if !resultConfirmationMatchesClaim(confirmation.value, current, binding) {
		service.results.invalidate()
		return nil, &daemon.Failure{Code: "assignment_ended"}
	}
	if confirmation.generation != service.results.currentGeneration() || checkCaptureExpiry(confirmation.timing, mustResultCapture(intent).IntentExpiresAt) != nil {
		return nil, &daemon.Failure{Code: "capture_invalid"}
	}
	record, added, err := service.journal.admit(ctx, intent, online)
	if err != nil {
		if errors.Is(err, errWorkQuota) {
			return nil, &daemon.Failure{Code: "capacity_exceeded"}
		}
		if errors.Is(err, errWorkConflict) {
			return nil, &daemon.Failure{Code: "request_conflict"}
		}
		return nil, service.storageFailure(err)
	}
	if !added {
		return nil, &daemon.Failure{Code: "request_conflict"}
	}
	if online {
		record, err = service.dispatch(ctx, command, record, false, peerCheck)
		if err != nil {
			return nil, err
		}
	}
	return workResponse(command, record, true)
}

func mustResultCapture(intent journalIntent) generated.AgentResultCapture {
	var capture generated.AgentResultCapture
	_ = json.Unmarshal([]byte(intent.CaptureJSON), &capture)
	return capture
}

func (service *workService) authorizeResultRecord(ctx context.Context, record journalRecord, reference generated.AgentWorkRequest, binding generated.AgentSessionReference) error {
	if service.results == nil || service.resultVerify == nil {
		return &daemon.Failure{Code: "storage_failed"}
	}
	capture := mustResultCapture(record.Intent)
	if err := service.resultVerify(ctx, capture); err != nil {
		if errors.Is(err, runner.ErrProtocol) {
			return &daemon.Failure{Code: "capture_invalid"}
		}
		if errors.Is(err, runner.ErrRevoked) || errors.Is(err, runner.ErrAuthorization) {
			return &daemon.Failure{Code: "revoked"}
		}
		if errors.Is(err, runner.ErrOffline) || ctx.Err() != nil {
			return &daemon.Failure{Code: "offline_rejected"}
		}
		return &daemon.Failure{Code: "storage_failed"}
	}
	confirmation, _, err := service.results.confirm(ctx, reference, binding, false)
	if err != nil {
		return err
	}
	if !sameResultCaptureAuthority(capture.Confirmation, confirmation.value) {
		return &daemon.Failure{Code: "policy_rejected"}
	}
	if capture.AdmissionMode == "offline_admitted" {
		now, err := confirmation.timing.captureTime()
		if err != nil {
			return &daemon.Failure{Code: "offline_rejected"}
		}
		expires, parseErr := time.Parse(time.RFC3339Nano, *capture.IntentExpiresAt)
		if parseErr != nil || !now.Before(expires) {
			return &daemon.Failure{Code: "intent_expired"}
		}
	}
	return nil
}

func (service *workService) retryResult(ctx context.Context, record journalRecord, request capturedWriteReference, explicit bool, peerCheck func(context.Context) error) (journalRecord, error) {
	if err := service.authorizeResultRecord(ctx, record, request.Reference, request.Binding); err != nil {
		if service.results != nil && workFailureReason(err) != "work_unavailable" {
			service.results.invalidate()
		}
		return service.deny(ctx, record, workFailureReason(err))
	}
	if record.Intent.AdmissionMode != "offline_admitted" && !explicit {
		return journalRecord{}, &daemon.Failure{Code: "offline_rejected"}
	}
	return service.dispatchResultRecord(ctx, record, peerCheck)
}

func (service *workService) dispatchResultRecord(ctx context.Context, record journalRecord, peerCheck func(context.Context) error) (journalRecord, error) {
	if record.State == "blocked" || record.State == "quarantined" {
		return record, nil
	}
	if record.State == "open" && record.Claim == nil {
		var err error
		record, err = service.journal.claimOperation(ctx, record.Intent.OperationKey)
		if err != nil {
			return journalRecord{}, service.storageFailure(err)
		}
	}
	command, _ := agentWorkCommand("result.submit")
	return service.dispatch(ctx, command, record, record.Intent.AdmissionMode == "offline_admitted", peerCheck)
}

func (service *workService) bindCurrentAgentSession(ctx context.Context, reference generated.AgentWorkRequest, peerCheck func(context.Context) error) (generated.AgentSessionReference, error) {
	view, err := supervisor.NewIntentStore(service.store.DB).JournalByExecution(ctx, reference.RunExecutionId, reference.AssignmentGeneration)
	if err != nil {
		return generated.AgentSessionReference{}, ownershipError(err)
	}
	observed, err := (localmcp.JournalBindings{Sessions: journal.NewStore(service.store.DB)}).ObservedBinding(ctx, localmcp.AssignmentRef{ExecutionID: reference.RunExecutionId, AssignmentGeneration: reference.AssignmentGeneration, RunID: view.RunID})
	if err != nil {
		if errors.Is(err, localmcp.ErrSessionNotBound) {
			return generated.AgentSessionReference{}, &daemon.Failure{Code: "session_not_bound"}
		}
		return generated.AgentSessionReference{}, &daemon.Failure{Code: "storage_failed"}
	}
	claim, err := service.inspect(ctx, reference, generated.AgentSessionReference{Provider: observed.Provider, ObservedSessionId: observed.ObservedSessionID})
	if err != nil {
		return generated.AgentSessionReference{}, err
	}
	channel, err := service.connection(claim.Assignment.RunnerId)
	if err != nil {
		return generated.AgentSessionReference{}, channelError(err, nil)
	}
	body, err := json.Marshal(generated.AgentSessionBindRequest{Reference: reference, Observation: map[string]any{"provider": observed.Provider, "observed_session_id": observed.ObservedSessionID, "observed_at": observed.ObservedAt.UTC().Format(time.RFC3339Nano)}})
	if err != nil || !protocol.DecodeWireDocument("agent-session-bind-request", body).OK {
		return generated.AgentSessionReference{}, &daemon.Failure{Code: "request_rejected"}
	}
	data, err := requestWork(ctx, channel, "work/session-bind", body)
	if err != nil {
		return generated.AgentSessionReference{}, channelError(err, data)
	}
	var result generated.AgentSessionBindResult
	if !protocol.DecodeWireDocument("agent-session-bind-result", data).OK || json.Unmarshal(data, &result) != nil ||
		result.Origin.RunId != claim.Assignment.RunId || result.Origin.RunExecutionId != reference.RunExecutionId || result.Origin.AssignmentGeneration != reference.AssignmentGeneration ||
		result.Origin.ProviderSessionId != result.Binding.ProviderSessionId || result.Binding.Provider != observed.Provider || result.Binding.ObservedSessionId != observed.ObservedSessionID {
		return generated.AgentSessionReference{}, &daemon.Failure{Code: "session_conflict"}
	}
	if err := peerCheck(ctx); err != nil {
		return generated.AgentSessionReference{}, err
	}
	if _, err := service.inspect(ctx, reference, result.Binding); err != nil {
		return generated.AgentSessionReference{}, err
	}
	return result.Binding, nil
}
