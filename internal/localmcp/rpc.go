// ABOUTME: Bridges fixed local agent read actions to the daemon-owned possession-authenticated connection.
// ABOUTME: Independently checks kernel containment and assignment identity without giving credentials to MCP.

package localmcp

import (
	"context"
	"encoding/json"
	"os"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

var readActions = map[string]struct{ action, document, field string }{
	"mcp.authority":   {"authority", "agent-authority-result", "agent_authority"},
	"mcp.get_context": {"context", "agent-context-result", "agent_context"},
	"mcp.get_task":    {"task", "agent-task-result", "agent_task"},
}

// VerifyDaemonCaller checks the kernel-supplied caller independently of stdio startup verification.
func VerifyDaemonCaller(ctx context.Context, request daemon.Request, input generated.AgentLocalRequest) (AssignmentRecord, PeerFacts, error) {
	assignment, err := (DaemonAssignments{DB: request.Store.DB}).Lookup(ctx, input.Request.RunExecutionId, input.Request.AssignmentGeneration)
	if err != nil {
		return AssignmentRecord{}, PeerFacts{}, err
	}
	caller, err := inspectProcess(request.Peer.PID)
	if err != nil || caller.UID != request.Peer.UID || caller.UID != os.Getuid() {
		return AssignmentRecord{}, PeerFacts{}, fail("peer_denied")
	}
	if err := VerifyPeer(caller, os.Getuid(), assignment, input.Correlation); err != nil {
		return AssignmentRecord{}, PeerFacts{}, err
	}
	// An absent/uncertain group is not rescued by a supervisor PID fallback.
	if assignment.OwnedGroupID <= 1 || caller.GroupID != assignment.OwnedGroupID {
		return AssignmentRecord{}, PeerFacts{}, fail("peer_denied")
	}
	leader, err := inspectProcess(assignment.ProviderPID)
	if err != nil || leader.UID != caller.UID || leader.GroupID != assignment.OwnedGroupID || leader.StartIdentity != assignment.ProviderStart {
		return AssignmentRecord{}, PeerFacts{}, fail("peer_denied")
	}
	parent, err := inspectProcess(caller.ParentPID)
	if err != nil || parent.UID != caller.UID || !peerInOwnedGroup(parent, assignment) {
		return AssignmentRecord{}, PeerFacts{}, fail("peer_denied")
	}
	return assignment, caller, nil
}

// RPCTransport contains only local paths and correlation, never runner credentials.
// Unsupported mutations stay visibly rejected until writes and replay are closed.
type RPCTransport struct {
	OfflineTransport
	Paths       daemon.Paths
	Correlation string
}

func (RPCTransport) Online() bool { return true }

func (transport RPCTransport) call(ctx context.Context, method string, boundary Boundary, requestID string, target any) error {
	input := generated.AgentLocalRequest{Correlation: transport.Correlation,
		Request: generated.AgentWorkRequest{SchemaVersion: 1, RunExecutionId: boundary.ExecutionID,
			AssignmentGeneration: boundary.Generation, RequestId: requestID}}
	response, err := daemon.Call(ctx, transport.Paths, method, map[string]any{"agent_request": input})
	if err != nil {
		code := daemon.AsFailure(err).Code
		switch code {
		case "daemon_offline", "runner_credential_unavailable":
			return fail("offline_rejected")
		case "invalid_request":
			return fail("request_rejected")
		default:
			return fail(code)
		}
	}
	action := readActions[method]
	data, err := json.Marshal(response.Payload[action.field])
	if err != nil || !protocol.DecodeWireDocument(action.document, data).OK || json.Unmarshal(data, target) != nil {
		return fail("request_rejected")
	}
	return nil
}

func (transport RPCTransport) Current(ctx context.Context, boundary Boundary) (AuthorityState, error) {
	var state AuthorityState
	err := transport.call(ctx, "mcp.authority", boundary, daemon.NewRequestID(), &state)
	return state, err
}

func (transport RPCTransport) GetContext(ctx context.Context, boundary Boundary, requestID string) (ContextResult, error) {
	var result ContextResult
	if err := transport.call(ctx, "mcp.get_context", boundary, requestID, &result); err != nil {
		return ContextResult{}, err
	}
	if len(result.Context) != len(result.Deliveries) {
		return ContextResult{}, fail("request_rejected")
	}
	seen := make(map[string]bool)
	for index, item := range result.Context {
		delivery := result.Deliveries[index]
		if delivery.RunID != boundary.RunID || delivery.ContextVersion != item.Version || delivery.ContentHash != item.ContentHash || seen[delivery.ID] {
			return ContextResult{}, fail("request_rejected")
		}
		seen[delivery.ID] = true
	}
	return result, nil
}

func (transport RPCTransport) GetTask(ctx context.Context, boundary Boundary, requestID string) (TaskView, error) {
	var result TaskView
	if err := transport.call(ctx, "mcp.get_task", boundary, requestID, &result); err != nil {
		return TaskView{}, err
	}
	if result.ID != boundary.TaskID || result.ProjectID != boundary.ProjectID {
		return TaskView{}, fail("boundary_escape")
	}
	return result, nil
}
