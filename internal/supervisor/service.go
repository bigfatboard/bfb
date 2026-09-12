// ABOUTME: Registers a kernel-identified signed supervisor before returning its one-time execution assignment.
// ABOUTME: Keeps local execution RPC separate from app delivery and remotely supplied process authority.

package supervisor

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"sync"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
)

type ServiceOptions struct {
	InspectHelper func(daemon.Peer) (SupervisorIdentity, error)
	Now           func() time.Time
}

type Service struct {
	options ServiceOptions
	mu      sync.RWMutex
	store   *IntentStore
	ready   chan struct{}
	started sync.Once
}

func NewService(options ServiceOptions) *Service {
	if options.InspectHelper == nil {
		options.InspectHelper = InspectHelper
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	return &Service{options: options, ready: make(chan struct{})}
}

func (service *Service) Start(_ context.Context, store *daemon.Store) (func(), error) {
	service.mu.Lock()
	defer service.mu.Unlock()
	if service.store != nil {
		return nil, failure("already_running")
	}
	service.store = NewIntentStore(store.DB)
	service.started.Do(func() { close(service.ready) })
	return func() { service.mu.Lock(); defer service.mu.Unlock(); service.store = nil }, nil
}

func RegisterRPC(registry *daemon.Registry, service *Service) error {
	if err := registry.RegisterService("execution", service.Start); err != nil {
		return err
	}
	return registry.Register("execution.register", service.register)
}

func (service *Service) intents(ctx context.Context) (*IntentStore, error) {
	select {
	case <-service.ready:
	case <-ctx.Done():
		return nil, failure("daemon_offline")
	}
	service.mu.RLock()
	defer service.mu.RUnlock()
	if service.store == nil {
		return nil, failure("daemon_offline")
	}
	return service.store, nil
}

func (identity SupervisorIdentity) wire() generated.SupervisorIdentity {
	return generated.SupervisorIdentity{Pid: int64(identity.Process.PID), StartIdentity: identity.Process.StartIdentity, ExecutableHash: identity.ExecutableHash}
}

func (assignment LocalAssignment) wire() (generated.LocalExecutionAssignment, error) {
	if assignment.Supervisor == nil || assignment.State != "registered" {
		return generated.LocalExecutionAssignment{}, failure("execution_intent_consumed")
	}
	wire := generated.LocalExecutionAssignment{
		SchemaVersion: 1, TerminalIntentId: assignment.IntentID, Claim: assignment.Claim,
		ProviderIdentityHash: assignment.ProviderIdentityHash, CorrelationToken: assignment.CorrelationToken,
		Supervisor: assignment.Supervisor.wire(),
	}
	if _, err := wireJSON("local-execution-assignment", wire); err != nil {
		return generated.LocalExecutionAssignment{}, err
	}
	return wire, nil
}

func (service *Service) register(ctx context.Context, request daemon.Request) (map[string]any, error) {
	intent, ok := request.Envelope.Payload["terminal_intent_id"].(string)
	if !ok || len(request.Envelope.Payload) != 1 || !terminalIntent.MatchString(intent) {
		return nil, failure("invalid_request")
	}
	identity, err := service.options.InspectHelper(request.Peer)
	if err != nil {
		return nil, failure("peer_denied")
	}
	store, err := service.intents(ctx)
	if err != nil {
		return nil, err
	}
	assignment, err := store.Register(ctx, intent, identity, service.options.Now())
	if err != nil {
		return nil, err
	}
	wire, err := assignment.wire()
	if err != nil {
		return nil, err
	}
	return map[string]any{"execution_assignment": wire}, nil
}

func RegisterHelper(ctx context.Context, paths daemon.Paths, intent string) (generated.LocalExecutionAssignment, error) {
	if !terminalIntent.MatchString(intent) {
		return generated.LocalExecutionAssignment{}, failure("invalid_request")
	}
	response, err := daemon.CallWithPeerAuthorization(ctx, paths, "execution.register", map[string]any{"terminal_intent_id": intent}, func(peer daemon.Peer) error {
		_, err := InspectHelper(peer)
		return err
	})
	if err != nil {
		return generated.LocalExecutionAssignment{}, err
	}
	self, err := InspectHelper(daemon.Peer{UID: os.Getuid(), PID: os.Getpid()})
	if err != nil {
		return generated.LocalExecutionAssignment{}, err
	}
	return registeredResponse(response.Payload, intent, self, time.Now())
}

func registeredResponse(payload map[string]any, intent string, self SupervisorIdentity, now time.Time) (generated.LocalExecutionAssignment, error) {
	var assignment generated.LocalExecutionAssignment
	if len(payload) != 1 {
		return assignment, failure("execution_assignment_invalid")
	}
	data, err := wireJSON("local-execution-assignment", payload["execution_assignment"])
	if err != nil || json.Unmarshal(data, &assignment) != nil || assignment.TerminalIntentId != intent || assignment.Supervisor != self.wire() {
		return generated.LocalExecutionAssignment{}, failure("execution_assignment_invalid")
	}
	claim := assignment.Claim
	if err := validateClaim(claim, claim.Assignment.WorkspaceId, claim.Assignment.RunnerId, claim.Specification.LaunchId, claim.Specification.ExpiresAt); err != nil {
		return generated.LocalExecutionAssignment{}, err
	}
	deadline, _ := time.Parse(time.RFC3339Nano, claim.Specification.ExpiresAt)
	if !now.Before(deadline) {
		return generated.LocalExecutionAssignment{}, failure("expired_intent")
	}
	token, err := base64.RawURLEncoding.DecodeString(assignment.CorrelationToken)
	if err != nil || len(token) != 32 || base64.RawURLEncoding.EncodeToString(token) != assignment.CorrelationToken {
		return generated.LocalExecutionAssignment{}, failure("execution_assignment_invalid")
	}
	return assignment, nil
}
