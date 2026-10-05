// ABOUTME: Owns daemon-only durable admission and bounded recovery for the four fixed agent work commands.
// ABOUTME: Separates proven effects from delivery permission and checks every write-ahead disposition.

package agentwork

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"sync"
	"time"

	"github.com/qdis/bfb/internal/auth"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/runner"
)

type workService struct {
	mu            sync.Mutex
	store         *daemon.Store
	journal       *workJournal
	logger        *daemon.Logger
	connection    ConnectionLookup
	ownership     OwnershipCheck
	inspect       func(context.Context, generated.AgentWorkRequest, generated.AgentSessionReference) (generated.LaunchClaimResult, error)
	sign          captureSigner
	verify        func(context.Context, generated.AgentWorkCapture) error
	clock         captureClock
	confirmations map[string]workConfirmation
	afterKey      string
	failed        error
}

func newWorkService(manager *runner.Manager, ownership OwnershipCheck) *workService {
	service := &workService{connection: manager.Connection, ownership: ownership, sign: manager.SignAgentWorkCapture,
		verify: manager.VerifyAgentWorkCapture, clock: readCaptureClock, confirmations: make(map[string]workConfirmation)}
	service.inspect = service.localAuthority
	return service
}

func (service *workService) start(ctx context.Context, store *daemon.Store) (func(), error) {
	service.mu.Lock()
	defer service.mu.Unlock()
	if service.store != nil {
		return nil, &daemon.Failure{Code: "already_running"}
	}
	journal, err := openWorkJournal(ctx, filepath.Join(store.Paths.Root, "local-mcp-journal.sqlite"), service.clock)
	if err != nil {
		return nil, &daemon.Failure{Code: "storage_failed"}
	}
	service.store, service.journal = store, journal
	service.logger = daemon.NewLogger(store.Paths)
	lifetime, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-lifetime.Done():
				return
			case <-ticker.C:
				service.drain(lifetime)
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			cancel()
			<-done
			service.mu.Lock()
			defer service.mu.Unlock()
			if err := journal.close(); err != nil {
				service.failed = err
			}
			service.store, service.journal = nil, nil
			clear(service.confirmations)
		})
	}, nil
}

func (service *workService) storageFailure(err error) error {
	if errors.Is(err, errWorkStorage) || errors.Is(err, errWorkCorrupt) {
		first := service.failed == nil
		service.failed = err
		if first && service.logger != nil {
			if logErr := service.logger.Record(daemon.LogEvent{Event: "recovery_required", Code: "storage_failed"}); logErr != nil {
				service.failed = logErr
			}
		}
	}
	return &daemon.Failure{Code: "storage_failed"}
}

func (service *workService) authorityError(err error) error {
	if daemon.AsFailure(err).Code == "storage_failed" {
		return service.storageFailure(errWorkStorage)
	}
	return err
}

func (service *workService) write(ctx context.Context, command workCommand, original []byte, receipts bool, peerCheck func(context.Context) error) (map[string]any, error) {
	service.mu.Lock()
	defer service.mu.Unlock()
	if service.failed != nil || service.store == nil || service.journal == nil {
		return nil, &daemon.Failure{Code: "storage_failed"}
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	canonical, err := protocol.CanonicalAgentWriteRequest(command.name, original)
	var request capturedWriteReference
	if err != nil || json.Unmarshal([]byte(canonical), &request) != nil {
		return nil, &daemon.Failure{Code: "request_rejected"}
	}
	if err := peerCheck(ctx); err != nil {
		return nil, err
	}
	if _, err := service.inspect(ctx, request.Reference, request.Binding); err != nil {
		return nil, service.authorityError(err)
	}
	key, err := agentOperationKey(command.name, request.Reference)
	if err != nil {
		return nil, &daemon.Failure{Code: "request_rejected"}
	}
	record, found, err := service.journal.lookup(ctx, key)
	if err != nil {
		return nil, service.storageFailure(err)
	}
	digest := sha256.Sum256([]byte(canonical))
	fingerprint := hex.EncodeToString(digest[:])
	if found && record.Intent.Fingerprint != fingerprint {
		// Even a conflicting replay is a cached disposition. Authenticate the
		// current scope before revealing that this identity already exists.
		if _, _, err := service.confirmation(ctx, request.Reference, request.Binding, false); err != nil {
			return nil, service.authorityError(err)
		}
		return nil, &daemon.Failure{Code: "request_conflict"}
	}
	if found {
		// Every retry validates the original signature and obtains current cloud
		// authority. Neither a pending receipt nor a private result is memoized.
		result, err := service.retry(ctx, record, request, true, peerCheck)
		if err != nil {
			return nil, err
		}
		return workResponse(command, result, receipts)
	}
	confirmation, online, err := service.confirmation(ctx, request.Reference, request.Binding, receipts)
	if err != nil {
		return nil, service.authorityError(err)
	}
	intent, err := prepareWorkIntent(ctx, command.name, []byte(canonical), confirmation.value, confirmation.timing, service.sign)
	if err != nil {
		delete(service.confirmations, confirmationKey(request.Reference, request.Binding))
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
		return nil, err
	}
	current, err := service.inspect(ctx, request.Reference, request.Binding)
	if err != nil {
		return nil, service.authorityError(err)
	}
	if !confirmationMatchesClaim(confirmation.value, current, request.Binding) {
		return nil, &daemon.Failure{Code: "assignment_ended"}
	}
	if checkAdmissionDeadline(confirmation.timing, mustCapture(intent)) != nil {
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
	return workResponse(command, record, receipts)
}

func mustCapture(intent journalIntent) generated.AgentWorkCapture {
	var capture generated.AgentWorkCapture
	// All callers hold a wire-validated immutable journal intent.
	_ = json.Unmarshal([]byte(intent.CaptureJSON), &capture)
	return capture
}

func (service *workService) retry(ctx context.Context, record journalRecord, request capturedWriteReference, explicit bool, peerCheck func(context.Context) error) (journalRecord, error) {
	capture := mustCapture(record.Intent)
	if err := service.verify(ctx, capture); err != nil {
		if errors.Is(err, runner.ErrProtocol) {
			return service.deny(ctx, record, "capture_invalid")
		}
		if errors.Is(err, runner.ErrRevoked) || errors.Is(err, runner.ErrAuthorization) {
			return service.deny(ctx, record, "revoked")
		}
		if errors.Is(err, runner.ErrOffline) || ctx.Err() != nil {
			return service.unavailable(ctx, record)
		}
		return journalRecord{}, service.storageFailure(errWorkStorage)
	}
	confirmation, _, err := service.confirmation(ctx, request.Reference, request.Binding, false)
	if err != nil {
		reason := workFailureReason(err)
		if reason == "work_unavailable" {
			return service.unavailable(ctx, record)
		}
		return service.deny(ctx, record, reason)
	}
	if !sameCaptureAuthority(capture.Confirmation, confirmation.value) {
		return service.deny(ctx, record, "policy_rejected")
	}
	if capture.AdmissionMode == "offline_admitted" {
		now, err := confirmation.timing.captureTime()
		expires, parseErr := time.Parse(time.RFC3339Nano, *capture.IntentExpiresAt)
		if err != nil {
			return service.unavailable(ctx, record)
		}
		if parseErr != nil || !now.Before(expires) {
			return service.deny(ctx, record, "intent_expired")
		}
	} else if !explicit {
		return journalRecord{}, &daemon.Failure{Code: "offline_rejected"}
	}
	if record.State == "blocked" || record.State == "quarantined" {
		return record, nil
	}
	if record.State == "open" && record.Claim == nil {
		record, err = service.journal.claimOperation(ctx, record.Intent.OperationKey)
		if err != nil {
			return journalRecord{}, service.storageFailure(err)
		}
	}
	command, _ := journalCommand(record.Intent.Tool)
	return service.dispatch(ctx, command, record, capture.AdmissionMode == "offline_admitted", peerCheck)
}

func (service *workService) dispatch(ctx context.Context, command workCommand, record journalRecord, replay bool, peerCheck func(context.Context) error) (journalRecord, error) {
	capture := mustCapture(record.Intent)
	var request capturedWriteReference
	_ = json.Unmarshal([]byte(record.Intent.RequestJSON), &request)
	if peerCheck != nil {
		if err := peerCheck(ctx); err != nil {
			return journalRecord{}, err
		}
	}
	current, err := service.inspect(ctx, request.Reference, request.Binding)
	if err != nil {
		return service.deny(ctx, record, workFailureReason(err))
	}
	if !confirmationMatchesClaim(capture.Confirmation, current, request.Binding) {
		return service.deny(ctx, record, "assignment_ended")
	}
	channel, err := service.connection(capture.Confirmation.RunnerId)
	if err != nil {
		if !transientWorkError(err) {
			return service.deny(ctx, record, workFailureReason(channelError(err, nil)))
		}
		return service.unavailable(ctx, record)
	}
	body, action := []byte(record.Intent.RequestJSON), "work/"+command.action
	if replay {
		var original map[string]any
		_ = json.Unmarshal(body, &original)
		body, err = json.Marshal(generated.AgentWorkReplayRequest{SchemaVersion: 1, CommandName: command.name, OriginalRequest: original, Capture: capture})
		if err != nil || len(body) > 32768 || !protocol.DecodeWireDocument("agent-work-replay-request", body).OK {
			return service.deny(ctx, record, "capture_invalid")
		}
		action = "work/replay"
	}
	if record.State != "applied" {
		if record.Claim == nil {
			return journalRecord{}, service.storageFailure(errWorkClaim)
		}
		if err := service.journal.markDispatch(ctx, *record.Claim); err != nil {
			return journalRecord{}, service.storageFailure(err)
		}
	}
	result, err := requestWork(ctx, channel, action, body)
	if err != nil {
		if !transientWorkError(err) {
			delete(service.confirmations, confirmationKey(request.Reference, request.Binding))
			return service.deny(ctx, record, workFailureReason(channelError(err, result)))
		}
		return service.unavailable(ctx, record)
	}
	if len(result) > 16384 || !protocol.DecodeWireDocument(command.resultDocument, result).OK || !journalOutcomeBound(record.Intent, string(result)) {
		return service.unavailable(ctx, record)
	}
	if record.State != "applied" {
		persist, cancel := workPersistenceContext(ctx)
		err := service.journal.acknowledge(persist, *record.Claim, string(result))
		cancel()
		if err != nil {
			return journalRecord{}, service.storageFailure(err)
		}
	} else {
		stored, e1 := protocol.NormalizeJSON([]byte(record.OutcomeJSON))
		current, e2 := protocol.NormalizeJSON(result)
		if e1 != nil || e2 != nil || stored != current {
			return journalRecord{}, service.storageFailure(errWorkCorrupt)
		}
	}
	record, err = service.reload(ctx, record.Intent.OperationKey)
	if err != nil {
		return journalRecord{}, err
	}
	// A durable effect survives postflight denial, but its private body does not.
	current, err = service.inspect(ctx, request.Reference, request.Binding)
	if err != nil {
		return service.deny(ctx, record, workFailureReason(err))
	}
	if !confirmationMatchesClaim(capture.Confirmation, current, request.Binding) {
		return service.deny(ctx, record, "assignment_ended")
	}
	if peerCheck != nil {
		if err := peerCheck(ctx); err != nil {
			return journalRecord{}, err
		}
	}
	return record, nil
}

func requestWork(ctx context.Context, channel runner.RunnerConnection, action string, body []byte) ([]byte, error) {
	attempt, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	return channel.Request(attempt, "POST", action, body)
}

func (service *workService) reload(ctx context.Context, key string) (journalRecord, error) {
	ctx, cancel := workPersistenceContext(ctx)
	defer cancel()
	record, found, err := service.journal.lookup(ctx, key)
	if err != nil || !found {
		return journalRecord{}, service.storageFailure(errWorkCorrupt)
	}
	return record, nil
}

func (service *workService) unavailable(ctx context.Context, record journalRecord) (journalRecord, error) {
	ctx, cancel := workPersistenceContext(ctx)
	defer cancel()
	if record.State == "applied" {
		return withheldWorkReceipt(record, "work_unavailable")
	}
	if record.State == "open" && record.Claim != nil {
		if err := service.journal.release(ctx, *record.Claim); err != nil {
			return journalRecord{}, service.storageFailure(err)
		}
	}
	return service.reload(ctx, record.Intent.OperationKey)
}

func (service *workService) deny(ctx context.Context, record journalRecord, reason string) (journalRecord, error) {
	if reason == "storage_failed" {
		return journalRecord{}, service.storageFailure(errWorkStorage)
	}
	ctx, cancel := workPersistenceContext(ctx)
	defer cancel()
	if reason == "work_unavailable" {
		return service.unavailable(ctx, record)
	}
	if record.State == "applied" || record.State == "blocked" || record.State == "quarantined" {
		return withheldWorkReceipt(record, reason)
	}
	if record.State == "open" {
		var err error
		if record.Claim == nil {
			record, err = service.journal.claimOperation(ctx, record.Intent.OperationKey)
			if err != nil {
				return journalRecord{}, service.storageFailure(err)
			}
		}
		if err := service.journal.block(ctx, *record.Claim, reason); err != nil {
			return journalRecord{}, service.storageFailure(err)
		}
	}
	return service.reload(ctx, record.Intent.OperationKey)
}

// The caller or network deadline may expire after the remote effect. Finish
// bounded local bookkeeping independently; never acknowledge only in memory.
func workPersistenceContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
}

func withheldWorkReceipt(record journalRecord, reason string) (journalRecord, error) {
	encoded, err := journalReceipt(record)
	if err != nil {
		return journalRecord{}, &daemon.Failure{Code: "storage_failed"}
	}
	var receipt generated.AgentWorkReceipt
	_ = json.Unmarshal([]byte(encoded), &receipt)
	if record.State == "applied" {
		receipt.DeliveryState = "delivery_blocked"
	}
	receipt.ReasonCode = &reason
	data, err := json.Marshal(receipt)
	if err != nil || !protocol.DecodeWireDocument("agent-work-receipt", data).OK {
		return journalRecord{}, &daemon.Failure{Code: "storage_failed"}
	}
	// Expose the current denial without rewriting the durable original effect
	// or disposition. A terminal authority reason can close the caller's capability.
	record.OutcomeJSON, record.ReceiptJSON = "", string(data)
	return record, nil
}

func workResponse(command workCommand, record journalRecord, receipts bool) (map[string]any, error) {
	if record.OutcomeJSON != "" {
		var value any
		if json.Unmarshal([]byte(record.OutcomeJSON), &value) != nil {
			return nil, &daemon.Failure{Code: "storage_failed"}
		}
		return map[string]any{command.resultField: value}, nil
	}
	if !receipts {
		reason := record.Reason
		if record.ReceiptJSON != "" {
			var receipt generated.AgentWorkReceipt
			if json.Unmarshal([]byte(record.ReceiptJSON), &receipt) == nil && receipt.ReasonCode != nil {
				reason = *receipt.ReasonCode
			}
		}
		if reason != "" && reason != "work_unavailable" {
			return nil, &daemon.Failure{Code: reason}
		}
		return nil, &daemon.Failure{Code: "offline_rejected"}
	}
	encoded := record.ReceiptJSON
	if encoded == "" {
		var err error
		encoded, err = journalReceipt(record)
		if err != nil {
			return nil, &daemon.Failure{Code: "storage_failed"}
		}
	}
	var value any
	if json.Unmarshal([]byte(encoded), &value) != nil {
		return nil, &daemon.Failure{Code: "storage_failed"}
	}
	return map[string]any{"agent_work_receipt": value}, nil
}

func workFailureReason(err error) string {
	code := daemon.AsFailure(err).Code
	switch code {
	case "revoked", "assignment_ended", "capability_closed", "session_not_bound", "session_conflict", "policy_rejected", "forbidden", "stale_version", "child_limit", "boundary_escape", "request_rejected", "invalid_argument", "intent_expired", "capture_invalid", "containment_unknown", "storage_failed":
		return code
	case "not_found":
		return "forbidden"
	default:
		return "work_unavailable"
	}
}

func (service *workService) drain(lifetime context.Context) {
	// One exclusive claim bounds each wake and never spends another operation's
	// deadline while waiting for the network.
	if lifetime.Err() != nil {
		return
	}
	service.mu.Lock()
	if service.failed != nil || service.journal == nil {
		service.mu.Unlock()
		return
	}
	ctx, cancel := context.WithTimeout(lifetime, 8*time.Second)
	records, err := service.journal.claimBatchAfter(ctx, service.afterKey, 1)
	if err != nil {
		_ = service.storageFailure(err)
		cancel()
		service.mu.Unlock()
		return
	}
	if len(records) == 0 {
		service.afterKey = ""
		cancel()
		service.mu.Unlock()
		return
	}
	var request capturedWriteReference
	_ = json.Unmarshal([]byte(records[0].Intent.RequestJSON), &request)
	service.afterKey = records[0].Intent.OperationKey
	result, err := service.retry(ctx, records[0], request, false, nil)
	if err == nil && result.State == "blocked" && service.logger != nil {
		if logErr := service.logger.Record(daemon.LogEvent{Event: "recovery_required", Code: result.Reason}); logErr != nil {
			service.failed = logErr
		}
	}
	cancel()
	service.mu.Unlock()
	// The next tick backs off even after infrastructure failure.
}
