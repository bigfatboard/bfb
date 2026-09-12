// ABOUTME: Registers a kernel-identified signed supervisor before returning its one-time execution assignment.
// ABOUTME: Keeps local execution RPC separate from app delivery and remotely supplied process authority.

package supervisor

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"sync"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/runner"
)

type ServiceOptions struct {
	InspectHelper func(daemon.Peer) (SupervisorIdentity, error)
	Now           func() time.Time
	Connection    func(string) (runner.RunnerConnection, error)
}

type Service struct {
	options ServiceOptions
	mu      sync.RWMutex
	store   *IntentStore
	files   *AssignmentFiles
	paths   daemon.Paths
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
	files, err := OpenAssignmentFiles(store.Paths.Root)
	if err != nil {
		return nil, err
	}
	service.store = NewIntentStore(store.DB)
	service.files = files
	service.paths = store.Paths
	service.started.Do(func() { close(service.ready) })
	return func() {
		service.mu.Lock()
		defer service.mu.Unlock()
		_ = files.Close()
		service.store, service.files = nil, nil
	}, nil
}

func RegisterRPC(registry *daemon.Registry, service *Service) error {
	if err := registry.RegisterService("execution", service.Start); err != nil {
		return err
	}
	for method, handler := range map[string]daemon.Handler{
		"execution.register":  service.register,
		"execution.authorize": service.authorize,
		"execution.group":     service.recordGroup,
	} {
		if err := registry.Register(method, handler); err != nil {
			return err
		}
	}
	return nil
}

func (service *Service) waitReady(ctx context.Context) error {
	select {
	case <-service.ready:
	case <-ctx.Done():
		return failure("daemon_offline")
	}
	return nil
}

func (identity SupervisorIdentity) wire() generated.SupervisorIdentity {
	return generated.SupervisorIdentity{Pid: int64(identity.Process.PID), StartIdentity: identity.Process.StartIdentity, ExecutableHash: identity.ExecutableHash}
}

func (assignment LocalAssignment) wire() (generated.LocalExecutionAssignment, error) {
	if assignment.Supervisor == nil || (assignment.State != "registered" && assignment.State != "group_ready") {
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
	if err := service.waitReady(ctx); err != nil {
		return nil, err
	}
	service.mu.RLock()
	defer service.mu.RUnlock()
	if service.store == nil || service.files == nil {
		return nil, failure("daemon_offline")
	}
	assignment, err := service.store.Register(ctx, intent, identity, service.options.Now())
	if err != nil {
		return nil, err
	}
	wire, err := assignment.wire()
	if err != nil {
		return nil, err
	}
	if err := service.files.Publish(wire); err != nil {
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
	assignment, err := registeredResponse(response.Payload, intent, self, time.Now())
	if err != nil {
		return generated.LocalExecutionAssignment{}, err
	}
	files, err := ReadAssignmentFiles(paths.Root)
	if err != nil {
		return generated.LocalExecutionAssignment{}, err
	}
	defer files.Close()
	stored, err := files.Read(intent)
	want, _ := json.Marshal(assignment)
	actual, _ := json.Marshal(stored)
	if err != nil || !bytes.Equal(want, actual) {
		return generated.LocalExecutionAssignment{}, failure("execution_assignment_invalid")
	}
	return assignment, nil
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
	if err := validateLocalAssignment(assignment); err != nil {
		return generated.LocalExecutionAssignment{}, err
	}
	deadline, _ := time.Parse(time.RFC3339Nano, claim.Specification.ExpiresAt)
	if !now.Before(deadline) {
		return generated.LocalExecutionAssignment{}, failure("expired_intent")
	}
	return assignment, nil
}
