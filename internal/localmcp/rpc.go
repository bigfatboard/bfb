// ABOUTME: Bridges fixed local agent work actions to the daemon-owned possession-authenticated connection.
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
	"mcp.v2.authority":   {"authority", "agent-authority-result", "agent_authority"},
	"mcp.v2.get_context": {"context", "agent-context-result", "agent_context"},
	"mcp.v2.get_task":    {"task", "agent-task-result", "agent_task"},
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
	if assignment.RootSupervision && !rootPeerAncestry(caller, assignment, inspectProcess) {
		return AssignmentRecord{}, PeerFacts{}, fail("peer_denied")
	}
	return assignment, caller, nil
}

func rootPeerAncestry(caller PeerFacts, assignment AssignmentRecord, inspect func(int) (PeerFacts, error)) bool {
	seen := map[int]bool{}
	ancestors := []PeerFacts{}
	current := caller
	for range 256 {
		if current.PID <= 1 || current.UID != caller.UID || current.GroupID != assignment.OwnedGroupID || current.StartIdentity == "" || seen[current.PID] {
			return false
		}
		ancestors = append(ancestors, current)
		if current.PID == assignment.ProviderPID {
			if current.StartIdentity != assignment.ProviderStart {
				return false
			}
			// An ancestor can exit or be reparented during the walk. Repeat each
			// exact identity/link before granting authority from that ancestry.
			for _, prior := range ancestors {
				fresh, err := inspect(prior.PID)
				if err != nil || fresh != prior {
					return false
				}
			}
			return true
		}
		seen[current.PID] = true
		var err error
		current, err = inspect(current.ParentPID)
		if err != nil {
			return false
		}
	}
	return false
}

// RPCTransport contains only local paths and correlation, never runner credentials.
// Offline replay and unrelated mutations stay visibly rejected until separately connected.
type RPCTransport struct {
	OfflineTransport
	Paths       daemon.Paths
	Correlation string
}

func (RPCTransport) Online() bool { return true }

func (transport RPCTransport) call(ctx context.Context, method string, boundary Boundary, requestID string, target any) error {
	input := generated.AgentLocalRequest{Correlation: transport.Correlation, Request: operationReference(boundary, requestID)}
	action := readActions[method]
	return transport.callPayload(ctx, method, map[string]any{"agent_request": input}, action.document, action.field, target)
}

func operationReference(boundary Boundary, requestID string) generated.AgentWorkRequest {
	return generated.AgentWorkRequest{SchemaVersion: 1, RunExecutionId: boundary.ExecutionID, AssignmentGeneration: boundary.Generation, RequestId: requestID}
}

func (transport RPCTransport) callPayload(ctx context.Context, method string, payload map[string]any, document, field string, target any) error {
	response, err := daemon.CallAgent(ctx, transport.Paths, method, payload)
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
	data, err := json.Marshal(response.Payload[field])
	if err != nil || !protocol.DecodeWireDocument(document, data).OK || json.Unmarshal(data, target) != nil {
		return fail("request_rejected")
	}
	return nil
}

func (transport RPCTransport) Current(ctx context.Context, boundary Boundary) (AuthorityState, error) {
	var state AuthorityState
	err := transport.call(ctx, "mcp.v2.authority", boundary, daemon.NewRequestID(), &state)
	return state, err
}

func (transport RPCTransport) GetContext(ctx context.Context, boundary Boundary, requestID string) (ContextResult, error) {
	var result ContextResult
	if err := transport.call(ctx, "mcp.v2.get_context", boundary, requestID, &result); err != nil {
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
	if err := transport.call(ctx, "mcp.v2.get_task", boundary, requestID, &result); err != nil {
		return TaskView{}, err
	}
	if result.ID != boundary.TaskID || result.ProjectID != boundary.ProjectID {
		return TaskView{}, fail("boundary_escape")
	}
	return result, nil
}

func originMatches(origin generated.AgentEffectOrigin, boundary Boundary, sessionID string) bool {
	return origin.RunId == boundary.RunID && origin.RunExecutionId == boundary.ExecutionID &&
		origin.AssignmentGeneration == boundary.Generation && origin.ProviderSessionId == sessionID
}

func (transport RPCTransport) ConfirmSession(ctx context.Context, boundary Boundary, observed SessionBinding) (ConfirmedSession, error) {
	input := generated.AgentLocalRequest{Correlation: transport.Correlation, Request: operationReference(boundary, "session-bind-v1")}
	var result generated.AgentSessionBindResult
	if err := transport.callPayload(ctx, "mcp.v2.bind_session", map[string]any{"agent_request": input}, "agent-session-bind-result", "agent_binding", &result); err != nil {
		return ConfirmedSession{}, err
	}
	if !originMatches(result.Origin, boundary, result.Binding.ProviderSessionId) || result.Binding.Provider != observed.Provider || result.Binding.ObservedSessionId != observed.ObservedSessionID || result.ObservedAt != observed.ObservedAt.UTC().Format("2006-01-02T15:04:05.999999999Z") {
		return ConfirmedSession{}, fail("session_conflict")
	}
	return result.Binding, nil
}

func (transport RPCTransport) CurrentBound(ctx context.Context, boundary Boundary, session ConfirmedSession) (AuthorityState, error) {
	input := generated.AgentBoundLocalRequest{Correlation: transport.Correlation, Request: generated.AgentBoundRequest{Reference: operationReference(boundary, daemon.NewRequestID()), Binding: session}}
	var state AuthorityState
	err := transport.callPayload(ctx, "mcp.v2.bound_authority", map[string]any{"agent_bound_request": input}, "agent-authority-result", "agent_authority", &state)
	return state, err
}

func (transport RPCTransport) AddComment(ctx context.Context, boundary Boundary, session ConfirmedSession, body, requestID string) (CommentResult, error) {
	input := generated.AgentCommentLocalRequest{Correlation: transport.Correlation, Request: generated.AgentCommentRequest{Reference: operationReference(boundary, requestID), Binding: session, Body: body}}
	var result generated.AgentCommentResult
	if err := transport.callPayload(ctx, "mcp.v2.add_comment", map[string]any{"agent_comment_request": input}, "agent-comment-result", "agent_comment", &result); err != nil {
		return CommentResult{}, err
	}
	if !originMatches(result.Origin, boundary, session.ProviderSessionId) {
		return CommentResult{}, fail("boundary_escape")
	}
	return CommentResult{ID: result.Id}, nil
}

func (transport RPCTransport) UpdateTask(ctx context.Context, boundary Boundary, session ConfirmedSession, update UpdateTaskInput, requestID string) (TaskView, error) {
	input := generated.AgentUpdateLocalRequest{Correlation: transport.Correlation, Request: generated.AgentUpdateRequest{
		Reference: operationReference(boundary, requestID), Binding: session,
		ExpectedVersion: update.ExpectedVersion, Title: update.Title, Punchline: update.Punchline}}
	var result generated.AgentUpdateResult
	if err := transport.callPayload(ctx, "mcp.v2.update_task", map[string]any{"agent_update_request": input}, "agent-update-result", "agent_update", &result); err != nil {
		return TaskView{}, err
	}
	if !originMatches(result.Origin, boundary, session.ProviderSessionId) || result.Task.Id != boundary.TaskID || result.Task.ProjectId != boundary.ProjectID || result.Task.ResourceVersion != update.ExpectedVersion+1 {
		return TaskView{}, fail("boundary_escape")
	}
	return TaskView{ID: result.Task.Id, ProjectID: result.Task.ProjectId, State: result.Task.State,
		Priority: result.Task.Priority, Title: result.Task.Title, Punchline: result.Task.Punchline, ResourceVersion: result.Task.ResourceVersion}, nil
}

func (transport RPCTransport) ReportProgress(ctx context.Context, boundary Boundary, session ConfirmedSession, summary string, percent, confidence *float64, requestID string) (CommentResult, error) {
	input := generated.AgentProgressLocalRequest{Correlation: transport.Correlation, Request: generated.AgentProgressRequest{
		Reference: operationReference(boundary, requestID), Binding: session, Summary: summary, Percent: percent, Confidence: confidence}}
	var result generated.AgentCommentResult
	if err := transport.callPayload(ctx, "mcp.v2.report_progress", map[string]any{"agent_progress_request": input}, "agent-comment-result", "agent_comment", &result); err != nil {
		return CommentResult{}, err
	}
	if !originMatches(result.Origin, boundary, session.ProviderSessionId) {
		return CommentResult{}, fail("boundary_escape")
	}
	return CommentResult{ID: result.Id}, nil
}

func (transport RPCTransport) ProposeTask(ctx context.Context, boundary Boundary, session ConfirmedSession, proposal ProposeTaskInput, requestID string) (ProposeTaskResult, error) {
	input := generated.AgentProposalLocalRequest{Correlation: transport.Correlation, Request: generated.AgentProposalRequest{
		Reference: operationReference(boundary, requestID), Binding: session, Title: proposal.Title,
		Priority: &proposal.Priority, ParentTaskId: proposal.ParentTaskID}}
	var result generated.AgentProposalResult
	if err := transport.callPayload(ctx, "mcp.v2.propose_task", map[string]any{"agent_proposal_request": input}, "agent-proposal-result", "agent_proposal", &result); err != nil {
		return ProposeTaskResult{}, err
	}
	state := "proposed"
	if proposal.ParentTaskID != nil {
		state = "ready"
	}
	if !originMatches(result.Origin, boundary, session.ProviderSessionId) || result.Id == boundary.TaskID || result.State != state {
		return ProposeTaskResult{}, fail("boundary_escape")
	}
	return ProposeTaskResult{ID: result.Id, State: result.State}, nil
}
