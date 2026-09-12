// ABOUTME: Authenticates native gate ownership and obtains fresh C09 authorization over the enrolled runner transport.
// ABOUTME: Registers the exact signed child durably without accepting cloud paths, supplied identities or signal authority.

package supervisor

import (
	"context"
	"encoding/json"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

const finalRequestLimit = 5 * time.Second

type gateRequest struct {
	IntentID string `json:"terminal_intent_id"`
	LockID   string `json:"local_lock_id"`
	GroupID  int    `json:"process_group_id,omitempty"`
}

func parseGateRequest(payload map[string]any, group bool) (gateRequest, error) {
	var request gateRequest
	expected := 2
	if group {
		expected = 3
	}
	data, err := json.Marshal(payload)
	if err != nil || len(payload) != expected || strictPrivateJSON(data, &request) != nil || !terminalIntent.MatchString(request.IntentID) || !executionID.MatchString(request.LockID) || (group && (request.GroupID <= 1 || request.GroupID > 2147483647)) || (!group && request.GroupID != 0) {
		return gateRequest{}, failure("invalid_request")
	}
	return request, nil
}

// gateOwner runs under the service read lock. No private assignment is read
// until the socket peer has passed the native signed-helper check.
func (service *Service) gateOwner(ctx context.Context, peer daemon.Peer, input gateRequest) (LocalAssignment, LockRecord, error) {
	owner, err := service.options.InspectHelper(peer)
	if err != nil {
		return LocalAssignment{}, LockRecord{}, failure("peer_denied")
	}
	if service.store == nil || service.files == nil {
		return LocalAssignment{}, LockRecord{}, failure("daemon_offline")
	}
	assignment, err := service.store.ByIntent(ctx, input.IntentID)
	if err != nil {
		return LocalAssignment{}, LockRecord{}, err
	}
	history, err := readNativeHistory(ctx, service.store.db, assignment)
	if err != nil || history.Uncertain || (history.Group != nil && history.Group.Unknown) {
		return LocalAssignment{}, LockRecord{}, failure("containment_unknown")
	}
	if assignment.Supervisor == nil || *assignment.Supervisor != owner || (assignment.LockID != "" && assignment.LockID != input.LockID) {
		return LocalAssignment{}, LockRecord{}, failure("peer_denied")
	}
	wire, err := assignment.wire()
	if err != nil {
		return LocalAssignment{}, LockRecord{}, err
	}
	if _, err := launchDeadline(wire, service.options.Now()); err != nil {
		return LocalAssignment{}, LockRecord{}, err
	}
	lock, err := readHeldLock(service.paths, wire, input.LockID)
	if err != nil || lock.Owner != owner.Process {
		return LocalAssignment{}, LockRecord{}, failure("containment_unknown")
	}
	if assignment.Group != nil && (lock.Group == nil || lock.Group.Leader != *assignment.Group) {
		return LocalAssignment{}, LockRecord{}, failure("containment_unknown")
	}
	if lock.Group != nil {
		child, err := service.options.InspectHelper(daemon.Peer{UID: owner.Process.UID, PID: lock.Group.Leader.PID})
		if err != nil || child.ExecutableHash != owner.ExecutableHash || child.Process != lock.Group.Leader || child.Process.ParentPID != owner.Process.PID || child.Process.Zombie {
			return LocalAssignment{}, LockRecord{}, failure("peer_denied")
		}
		table, err := InspectProcesses()
		if err != nil || lock.Group.Observe(table).State != "live" {
			return LocalAssignment{}, LockRecord{}, failure("containment_unknown")
		}
	}
	return assignment, lock, nil
}

func (service *Service) authorize(ctx context.Context, request daemon.Request) (map[string]any, error) {
	input, err := parseGateRequest(request.Envelope.Payload, false)
	if err != nil {
		return nil, err
	}
	if err := service.waitReady(ctx); err != nil {
		return nil, err
	}
	service.mu.RLock()
	defer service.mu.RUnlock()
	assignment, lock, err := service.gateOwner(ctx, request.Peer, input)
	if err != nil {
		return nil, err
	}
	if lock.Group != nil && assignment.Group == nil {
		return nil, failure("execution_assignment_invalid")
	}
	if service.options.Connection == nil {
		return nil, failure("daemon_offline")
	}
	// Pin before sending: a failed response cannot erase the identity which
	// C09 may already have committed for subsequent absence/recovery proofs.
	assignment, err = service.store.PinOwnership(ctx, input.IntentID, *assignment.Supervisor, input.LockID, nil, service.options.Now())
	if err != nil {
		return nil, err
	}
	connection, err := service.options.Connection(assignment.Claim.Assignment.RunnerId)
	if err != nil || connection == nil {
		return nil, failure("daemon_offline")
	}
	wire, _ := assignment.wire()
	final := finalRequest(wire, input.LockID)
	data, err := wireJSON("launch-final-request", final)
	if err != nil {
		return nil, err
	}
	started := service.options.Now()
	ctx, cancel := context.WithTimeout(ctx, finalRequestLimit)
	defer cancel()
	response, err := connection.Request(ctx, "POST", "launch/authorize", data)
	if err != nil || ctx.Err() != nil {
		return nil, failure("execution_authorization_failed")
	}
	authorization, err := decodeFinalAuthorization(response, final, started, service.options.Now())
	if err != nil {
		return nil, err
	}
	// Recheck native ownership after online I/O as well as before it.
	current, _, err := service.gateOwner(ctx, request.Peer, input)
	if err != nil {
		return nil, err
	}
	currentWire, _ := current.wire()
	if finalRequest(currentWire, input.LockID) != final {
		return nil, failure("execution_assignment_invalid")
	}
	return map[string]any{"final_authorization": authorization}, nil
}

func decodeFinalAuthorization(data []byte, request generated.LaunchFinalRequest, started, completed time.Time) (generated.FinalAuthorization, error) {
	var authorization generated.FinalAuthorization
	if len(data) > 4096 {
		return authorization, failure("execution_authorization_failed")
	}
	decoded := protocol.DecodeWireDocument("final-authorization", data)
	if !decoded.OK || json.Unmarshal([]byte(decoded.JSON), &authorization) != nil || authorization.LaunchId != request.LaunchId || authorization.RunExecutionId != request.RunExecutionId || authorization.AssignmentGeneration != request.AssignmentGeneration || authorization.Decision != "authorized" || authorization.Rejection != nil {
		return authorization, failure("execution_authorization_failed")
	}
	authorized, err := time.Parse(time.RFC3339Nano, authorization.AuthorizedAt)
	// Large clock disagreement fails closed. A bounded authenticated round trip
	// is mandatory; no saved response or previous grant is accepted as authority.
	if err != nil || completed.Before(started) || completed.Sub(started) > finalRequestLimit || authorized.Before(started.Add(-finalRequestLimit)) || authorized.After(completed.Add(finalRequestLimit)) {
		return authorization, failure("execution_authorization_failed")
	}
	return authorization, nil
}

func (service *Service) recordGroup(ctx context.Context, request daemon.Request) (map[string]any, error) {
	input, err := parseGateRequest(request.Envelope.Payload, true)
	if err != nil {
		return nil, err
	}
	if err := service.waitReady(ctx); err != nil {
		return nil, err
	}
	service.mu.RLock()
	defer service.mu.RUnlock()
	assignment, lock, err := service.gateOwner(ctx, request.Peer, input)
	if err != nil {
		return nil, err
	}
	if lock.Group == nil || lock.Group.Leader.GroupID != input.GroupID {
		return nil, failure("containment_unknown")
	}
	if _, err := service.store.PinOwnership(ctx, input.IntentID, *assignment.Supervisor, input.LockID, &lock.Group.Leader, service.options.Now()); err != nil {
		return nil, err
	}
	return map[string]any{}, nil
}

// HelperGateCallbacks supplies the fixed RPC implementations for startGated.
// Its captured assignment cannot be replaced by a per-call cloud binding.
func HelperGateCallbacks(paths daemon.Paths, assignment generated.LocalExecutionAssignment) GateCallbacks {
	call := func(ctx context.Context, method string, payload map[string]any) (generated.LocalRpcEnvelope, error) {
		return daemon.CallWithPeerAuthorization(ctx, paths, method, payload, func(peer daemon.Peer) error {
			_, err := InspectHelper(peer)
			return err
		})
	}
	return GateCallbacks{
		Authorize: func(ctx context.Context, request generated.LaunchFinalRequest) error {
			if request != finalRequest(assignment, request.LocalLockId) {
				return failure("execution_assignment_invalid")
			}
			started := time.Now()
			ctx, cancel := context.WithTimeout(ctx, finalRequestLimit)
			defer cancel()
			response, err := call(ctx, "execution.authorize", map[string]any{"terminal_intent_id": assignment.TerminalIntentId, "local_lock_id": request.LocalLockId})
			if err != nil {
				return err
			}
			if len(response.Payload) != 1 || ctx.Err() != nil {
				return failure("execution_authorization_failed")
			}
			data, _ := json.Marshal(response.Payload["final_authorization"])
			_, err = decodeFinalAuthorization(data, request, started, time.Now())
			return err
		},
		RecordGroup: func(ctx context.Context, current generated.LocalExecutionAssignment, lockID string, child Process) error {
			want, _ := json.Marshal(assignment)
			actual, _ := json.Marshal(current)
			if string(want) != string(actual) || !validRecordedProcess(child) || child.ParentPID != int(assignment.Supervisor.Pid) || child.GroupID != child.PID || child.Zombie {
				return failure("execution_assignment_invalid")
			}
			response, err := call(ctx, "execution.group", map[string]any{"terminal_intent_id": assignment.TerminalIntentId, "local_lock_id": lockID, "process_group_id": child.GroupID})
			if err != nil {
				return err
			}
			if len(response.Payload) != 0 {
				return failure("execution_assignment_invalid")
			}
			return nil
		},
	}
}
