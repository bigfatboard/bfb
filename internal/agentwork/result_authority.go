// ABOUTME: Obtains result-specific authority without turning task-write permission into result permission.
// ABOUTME: Primes bounded in-memory confirmations while retaining original elapsed-time anchors and denial fences.

package agentwork

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

type resultConfirmation struct {
	value      generated.AgentResultConfirmationResult
	timing     *captureTiming
	generation uint64
}

type resultPrime struct {
	reference generated.AgentWorkRequest
	binding   generated.AgentSessionReference
}

type resultAuthority struct {
	mu            sync.Mutex
	connection    ConnectionLookup
	inspect       func(context.Context, generated.AgentWorkRequest, generated.AgentSessionReference) (generated.LaunchClaimResult, error)
	clock         captureClock
	confirmations map[string]resultConfirmation
	generation    uint64
	queue         chan resultPrime
	pending       map[string]bool
	lifetime      context.Context
	done          chan struct{}
}

func newResultAuthority(connection ConnectionLookup, inspect func(context.Context, generated.AgentWorkRequest, generated.AgentSessionReference) (generated.LaunchClaimResult, error), clock captureClock) *resultAuthority {
	return &resultAuthority{connection: connection, inspect: inspect, clock: clock,
		confirmations: make(map[string]resultConfirmation), pending: make(map[string]bool), queue: make(chan resultPrime, 16)}
}

func (authority *resultAuthority) start(ctx context.Context) {
	authority.mu.Lock()
	authority.lifetime, authority.done = ctx, make(chan struct{})
	authority.mu.Unlock()
	go func() {
		defer close(authority.done)
		for {
			select {
			case <-ctx.Done():
				return
			case prime := <-authority.queue:
				key := confirmationKey(prime.reference, prime.binding)
				if _, valid := authority.cached(key); !valid {
					attempt, cancel := context.WithTimeout(ctx, 4*time.Second)
					_, _, _ = authority.confirm(attempt, prime.reference, prime.binding, false)
					cancel()
				}
				authority.mu.Lock()
				delete(authority.pending, key)
				authority.mu.Unlock()
			}
		}
	}()
}

// Scheduling is optional availability work; it never waits on cloud I/O or
// changes the successful operation that supplied this verified binding.
func (authority *resultAuthority) schedule(reference generated.AgentWorkRequest, binding generated.AgentSessionReference) {
	key := confirmationKey(reference, binding)
	if _, valid := authority.cached(key); valid {
		return
	}
	authority.mu.Lock()
	defer authority.mu.Unlock()
	if authority.lifetime == nil || authority.lifetime.Err() != nil || authority.pending[key] {
		return
	}
	select {
	case authority.queue <- resultPrime{reference, binding}:
		authority.pending[key] = true
	default:
	}
}

func (authority *resultAuthority) cached(key string) (resultConfirmation, bool) {
	authority.mu.Lock()
	defer authority.mu.Unlock()
	value, found := authority.confirmations[key]
	if found {
		if _, err := value.timing.captureTime(); err == nil {
			return value, true
		}
		delete(authority.confirmations, key)
	}
	return resultConfirmation{}, false
}

func (authority *resultAuthority) invalidate() {
	authority.mu.Lock()
	defer authority.mu.Unlock()
	clear(authority.confirmations)
	authority.generation++
}

func (authority *resultAuthority) currentGeneration() uint64 {
	authority.mu.Lock()
	defer authority.mu.Unlock()
	return authority.generation
}

// A validated committed result is explicit knowledge that the old capture
// eligibility was consumed. Invalidate its cache and any already-running prime;
// a later changes-requested cycle must obtain a fresh cloud confirmation.
func (authority *resultAuthority) closeSubmissionCaptureWindow(expected uint64) (uint64, bool) {
	authority.mu.Lock()
	defer authority.mu.Unlock()
	unchanged := authority.generation == expected
	clear(authority.confirmations)
	authority.generation++
	return authority.generation, unchanged
}

func (authority *resultAuthority) invalidateOnDenial(err error) {
	if authority == nil || err == nil {
		return
	}
	switch daemon.AsFailure(err).Code {
	case "revoked", "assignment_unknown", "assignment_ended", "correlation_rejected", "capability_closed", "session_not_bound", "session_conflict", "policy_rejected", "forbidden", "not_found", "boundary_escape", "capture_invalid", "containment_unknown", "storage_failed", "peer_denied":
		authority.invalidate()
	}
}

// Binding knowledge is not capture permission. The caller must still check
// trusted observation/native scope and obtain confirmation or its valid cache.
func (authority *resultAuthority) binding(reference generated.AgentWorkRequest) (generated.AgentSessionReference, bool) {
	authority.mu.Lock()
	defer authority.mu.Unlock()
	var binding generated.AgentSessionReference
	found := false
	for _, confirmation := range authority.confirmations {
		value := confirmation.value
		if value.RunExecutionId == reference.RunExecutionId && value.AssignmentGeneration == reference.AssignmentGeneration {
			if found && binding != value.Binding {
				return generated.AgentSessionReference{}, false
			}
			binding, found = value.Binding, true
		}
	}
	return binding, found
}

func resultConfirmationMatchesClaim(value generated.AgentResultConfirmationResult, claim generated.LaunchClaimResult, binding generated.AgentSessionReference) bool {
	// Only the common immutable scope is projected here. Permission, eligibility
	// and full result-schema validation stay with the result-specific consumer.
	encoded, err := json.Marshal(value)
	var scope generated.AgentCaptureConfirmationResult
	return err == nil && json.Unmarshal(encoded, &scope) == nil && confirmationMatchesClaim(scope, claim, binding)
}

func (authority *resultAuthority) confirm(ctx context.Context, reference generated.AgentWorkRequest, binding generated.AgentSessionReference, allowCached bool) (resultConfirmation, bool, error) {
	key := confirmationKey(reference, binding)
	authority.mu.Lock()
	generation := authority.generation
	authority.mu.Unlock()
	claim, err := authority.inspect(ctx, reference, binding)
	if err != nil {
		authority.invalidate()
		return resultConfirmation{}, false, err
	}
	channel, err := authority.connection(claim.Assignment.RunnerId)
	var result []byte
	var timing *captureTiming
	requestID := daemon.NewRequestID()
	if err == nil {
		timing, err = newCaptureTiming(requestID, authority.clock)
		if err != nil {
			authority.invalidate()
			return resultConfirmation{}, false, &daemon.Failure{Code: "capture_invalid"}
		}
		body, _ := json.Marshal(generated.AgentResultConfirmationRequest{SchemaVersion: 1, RequestId: requestID, RunExecutionId: reference.RunExecutionId, AssignmentGeneration: reference.AssignmentGeneration, Binding: binding})
		result, err = requestWork(ctx, channel, "work/result-confirmation", body)
	}
	if err != nil {
		if transientWorkError(err) && allowCached {
			if cached, found := authority.cached(key); found && resultConfirmationMatchesClaim(cached.value, claim, binding) {
				current, localErr := authority.inspect(ctx, reference, binding)
				authority.mu.Lock()
				unchanged := generation == authority.generation
				authority.mu.Unlock()
				if localErr == nil && unchanged && resultConfirmationMatchesClaim(cached.value, current, binding) {
					return cached, false, nil
				}
				if localErr != nil {
					authority.invalidate()
					return resultConfirmation{}, false, localErr
				}
				authority.invalidate()
				return resultConfirmation{}, false, &daemon.Failure{Code: "assignment_ended"}
			}
		}
		if !transientWorkError(err) {
			authority.invalidate()
		}
		return resultConfirmation{}, false, channelError(err, result)
	}
	var value generated.AgentResultConfirmationResult
	if len(result) > 4096 || !protocol.DecodeWireDocument("agent-result-confirmation-result", result).OK || json.Unmarshal(result, &value) != nil || value.ConfirmationId != requestID || !resultConfirmationMatchesClaim(value, claim, binding) {
		authority.invalidate()
		return resultConfirmation{}, false, &daemon.Failure{Code: "capture_invalid"}
	}
	current, err := authority.inspect(ctx, reference, binding)
	if err != nil || !resultConfirmationMatchesClaim(value, current, binding) {
		authority.invalidate()
		if err != nil {
			return resultConfirmation{}, false, err
		}
		return resultConfirmation{}, false, &daemon.Failure{Code: "assignment_ended"}
	}
	confirmed, _ := time.Parse(time.RFC3339Nano, value.ConfirmedAt)
	lease, _ := time.Parse(time.RFC3339Nano, value.LeaseExpiresAt)
	credential, _ := time.Parse(time.RFC3339Nano, value.CredentialExpiresAt)
	if timing.receive(requestID, confirmed, lease, credential) != nil {
		authority.invalidate()
		return resultConfirmation{}, false, &daemon.Failure{Code: "capture_invalid"}
	}
	confirmation := resultConfirmation{value, timing, generation}
	authority.mu.Lock()
	defer authority.mu.Unlock()
	if generation != authority.generation || ctx.Err() != nil {
		return resultConfirmation{}, false, &daemon.Failure{Code: "offline_rejected"}
	}
	if len(authority.confirmations) >= 1024 {
		clear(authority.confirmations)
	}
	authority.confirmations[key] = confirmation
	return confirmation, true, nil
}

func sameResultCaptureAuthority(original, current generated.AgentResultConfirmationResult) bool {
	current.ConfirmationId, current.ConfirmedAt = original.ConfirmationId, original.ConfirmedAt
	current.LeaseExpiresAt, current.CredentialExpiresAt = original.LeaseExpiresAt, original.CredentialExpiresAt
	current.RunnerTokenEpoch, current.CanSubmit = original.RunnerTokenEpoch, original.CanSubmit
	a, _ := json.Marshal(original)
	b, _ := json.Marshal(current)
	left, e1 := protocol.NormalizeJSON(a)
	right, e2 := protocol.NormalizeJSON(b)
	return e1 == nil && e2 == nil && left == right
}
