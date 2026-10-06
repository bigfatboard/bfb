// ABOUTME: Owns fixed agent work RPC actions using the daemon's authenticated runner connections.
// ABOUTME: Preserves typed denials and verifies native caller containment before and after network waits.

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
)

type ConnectionLookup func(string) (runner.RunnerConnection, error)
type OwnershipCheck func(context.Context, string, int64) error

// RegisterRPC is a fixed work-action bridge, not a URL, principal or shell proxy.
func RegisterRPC(registry *daemon.Registry, manager *runner.Manager, ownership OwnershipCheck) error {
	if ownership == nil || manager == nil {
		return &daemon.Failure{Code: "invalid_request"}
	}
	work := newWorkService(manager, ownership)
	if err := registry.RegisterService("agent.work", work.start); err != nil {
		return err
	}
	return registerWorkRPC(registry, work)
}

func registerWorkRPC(registry *daemon.Registry, work *workService) error {
	connection, ownership := work.connection, work.ownership
	actions := map[string]struct{ action, inputDocument, inputField, document, field string }{
		"mcp.authority":          {"authority", "agent-local-request", "agent_request", "agent-authority-result", "agent_authority"},
		"mcp.get_context":        {"context", "agent-local-request", "agent_request", "agent-context-result", "agent_context"},
		"mcp.get_task":           {"task", "agent-local-request", "agent_request", "agent-task-result", "agent_task"},
		"mcp.v2.authority":       {"authority", "agent-local-request", "agent_request", "agent-authority-result", "agent_authority"},
		"mcp.v2.get_context":     {"context", "agent-local-request", "agent_request", "agent-context-result", "agent_context"},
		"mcp.v2.get_task":        {"task", "agent-local-request", "agent_request", "agent-task-result", "agent_task"},
		"mcp.v2.bind_session":    {"session-bind", "agent-local-request", "agent_request", "agent-session-bind-result", "agent_binding"},
		"mcp.v2.bound_authority": {"bound-authority", "agent-bound-local-request", "agent_bound_request", "agent-authority-result", "agent_authority"},
		"mcp.v2.add_comment":     {"comment", "agent-comment-local-request", "agent_comment_request", "agent-comment-result", "agent_comment"},
		"mcp.v2.update_task":     {"update", "agent-update-local-request", "agent_update_request", "agent-update-result", "agent_update"},
		"mcp.v2.report_progress": {"progress", "agent-progress-local-request", "agent_progress_request", "agent-comment-result", "agent_comment"},
		"mcp.v2.propose_task":    {"proposal", "agent-proposal-local-request", "agent_proposal_request", "agent-proposal-result", "agent_proposal"},
		"mcp.v3.add_comment":     {"comment", "agent-comment-local-request", "agent_comment_request", "agent-comment-result", "agent_comment"},
		"mcp.v3.update_task":     {"update", "agent-update-local-request", "agent_update_request", "agent-update-result", "agent_update"},
		"mcp.v3.report_progress": {"progress", "agent-progress-local-request", "agent_progress_request", "agent-comment-result", "agent_comment"},
		"mcp.v3.propose_task":    {"proposal", "agent-proposal-local-request", "agent_proposal_request", "agent-proposal-result", "agent_proposal"},
	}
	for method, action := range actions {
		if err := registry.Register(method, func(ctx context.Context, request daemon.Request) (output map[string]any, failure error) {
			defer func() { work.results.invalidateOnDenial(failure) }()
			data, err := json.Marshal(request.Envelope.Payload[action.inputField])
			if err != nil || len(request.Envelope.Payload) != 1 || !protocol.DecodeWireDocument(action.inputDocument, data).OK {
				return nil, &daemon.Failure{Code: "invalid_request"}
			}
			var input generated.AgentLocalRequest
			var wire struct {
				Correlation string          `json:"correlation"`
				Request     json.RawMessage `json:"request"`
			}
			if json.Unmarshal(data, &wire) != nil || request.Store == nil {
				return nil, &daemon.Failure{Code: "invalid_request"}
			}
			input.Correlation = wire.Correlation
			var binding *generated.AgentSessionReference
			if action.action == "bound-authority" || action.action == "comment" || action.action == "update" || action.action == "progress" || action.action == "proposal" {
				var bound struct {
					Reference generated.AgentWorkRequest      `json:"reference"`
					Binding   generated.AgentSessionReference `json:"binding"`
				}
				if json.Unmarshal(wire.Request, &bound) != nil {
					return nil, &daemon.Failure{Code: "invalid_request"}
				}
				input.Request, binding = bound.Reference, &bound.Binding
			} else if json.Unmarshal(wire.Request, &input.Request) != nil {
				return nil, &daemon.Failure{Code: "invalid_request"}
			}
			assignment, caller, err := localmcp.VerifyDaemonCaller(ctx, request, input)
			if err != nil {
				return nil, &daemon.Failure{Code: localmcp.CodeOf(err)}
			}
			if err := ownership(ctx, input.Request.RunExecutionId, input.Request.AssignmentGeneration); err != nil {
				return nil, ownershipError(err)
			}
			body := []byte(wire.Request)
			var observed localmcp.SessionBinding
			if action.action == "session-bind" || binding != nil {
				observed, err = (localmcp.JournalBindings{Sessions: journal.NewStore(request.Store.DB)}).ObservedBinding(ctx, localmcp.AssignmentRef{ExecutionID: input.Request.RunExecutionId, AssignmentGeneration: input.Request.AssignmentGeneration, RunID: assignment.Boundary.RunID})
				if err != nil {
					code := localmcp.CodeOf(err)
					if errors.Is(err, localmcp.ErrSessionNotBound) {
						code = "session_not_bound"
					}
					return nil, &daemon.Failure{Code: code}
				}
				if binding != nil && (binding.Provider != observed.Provider || binding.ObservedSessionId != observed.ObservedSessionID) {
					return nil, &daemon.Failure{Code: "session_conflict"}
				}
				if action.action == "session-bind" {
					body, err = json.Marshal(generated.AgentSessionBindRequest{Reference: input.Request, Observation: map[string]any{"provider": observed.Provider, "observed_session_id": observed.ObservedSessionID, "observed_at": observed.ObservedAt.UTC().Format(time.RFC3339Nano)}})
					if err != nil || !protocol.DecodeWireDocument("agent-session-bind-request", body).OK {
						return nil, &daemon.Failure{Code: "request_rejected"}
					}
				}
			}
			if len(body) > 16_384 {
				return nil, &daemon.Failure{Code: "request_rejected"}
			}
			if command, write := agentWorkCommand("agent_run." + action.action); write {
				check := func(ctx context.Context) error {
					_, current, err := localmcp.VerifyDaemonCaller(ctx, request, input)
					if err != nil {
						return &daemon.Failure{Code: localmcp.CodeOf(err)}
					}
					if current.StartIdentity != caller.StartIdentity {
						return &daemon.Failure{Code: "peer_denied"}
					}
					return nil
				}
				return work.write(ctx, command, body, request.Envelope.SchemaVersion == 3, check)
			}
			channel, err := connection(assignment.Boundary.RunnerID)
			if err != nil {
				return nil, channelError(err, nil)
			}
			result, err := channel.Request(ctx, "POST", "work/"+action.action, body)
			if err != nil {
				if !transientWorkError(err) {
					work.results.invalidate()
				}
				return nil, channelError(err, result)
			}
			if !protocol.DecodeWireDocument(action.document, result).OK {
				return nil, &daemon.Failure{Code: "invalid_request"}
			}
			_, current, err := localmcp.VerifyDaemonCaller(ctx, request, input)
			if err != nil {
				return nil, &daemon.Failure{Code: localmcp.CodeOf(err)}
			}
			if current.StartIdentity != caller.StartIdentity {
				return nil, &daemon.Failure{Code: "peer_denied"}
			}
			if err := ownership(ctx, input.Request.RunExecutionId, input.Request.AssignmentGeneration); err != nil {
				return nil, ownershipError(err)
			}
			if action.action == "session-bind" || binding != nil {
				now, err := (localmcp.JournalBindings{Sessions: journal.NewStore(request.Store.DB)}).ObservedBinding(ctx, localmcp.AssignmentRef{ExecutionID: input.Request.RunExecutionId, AssignmentGeneration: input.Request.AssignmentGeneration, RunID: assignment.Boundary.RunID})
				if err != nil {
					return nil, &daemon.Failure{Code: "storage_failed"}
				}
				if now != observed {
					return nil, &daemon.Failure{Code: "session_conflict"}
				}
			}
			var value any
			if json.Unmarshal(result, &value) != nil {
				return nil, &daemon.Failure{Code: "invalid_request"}
			}
			payload := map[string]any{action.field: value}
			if _, err := daemon.EncodeEnvelope(daemon.ResponseVersion(request.Envelope.SchemaVersion, method, request.Envelope.RequestId, payload, nil)); err != nil {
				return nil, &daemon.Failure{Code: "request_rejected"}
			}
			if action.action == "session-bind" {
				var confirmed generated.AgentSessionBindResult
				if json.Unmarshal(result, &confirmed) != nil || confirmed.Origin.RunId != assignment.Boundary.RunID ||
					confirmed.Origin.RunExecutionId != input.Request.RunExecutionId || confirmed.Origin.AssignmentGeneration != input.Request.AssignmentGeneration ||
					confirmed.Origin.ProviderSessionId != confirmed.Binding.ProviderSessionId || confirmed.Binding.Provider != observed.Provider || confirmed.Binding.ObservedSessionId != observed.ObservedSessionID {
					work.results.invalidate()
					return nil, &daemon.Failure{Code: "session_conflict"}
				}
				work.results.schedule(input.Request, confirmed.Binding)
			}
			if action.action == "authority" || action.action == "bound-authority" {
				var authority generated.AgentAuthorityResult
				if json.Unmarshal(result, &authority) == nil && (authority.Revoked || authority.ExecutionEnded || authority.ResultTerminal) {
					work.results.invalidate()
				}
			}
			return payload, nil
		}); err != nil {
			return err
		}
	}
	if err := registerAttentionRPC(registry, connection, ownership, work.results); err != nil {
		return err
	}
	return registerResultRPC(registry, work)
}

func ownershipError(err error) error {
	code := "offline_rejected"
	switch daemon.AsFailure(err).Code {
	case "execution_assignment_invalid", "containment_unknown":
		// This closes access; it does not report a business execution-end event.
		code = "assignment_ended"
	case "storage_failed":
		code = "storage_failed"
	}
	return &daemon.Failure{Code: code}
}

func channelError(err error, data []byte) error {
	code := "offline_rejected"
	if errors.Is(err, runner.ErrRevoked) {
		code = "revoked"
	}
	if errors.Is(err, runner.ErrAuthorization) {
		code = "revoked"
		var denial struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &denial) == nil {
			switch denial.Error {
			case "revoked", "assignment_ended", "capability_closed", "boundary_escape", "forbidden", "not_found", "request_rejected", "session_not_bound", "session_conflict", "stale_version", "policy_rejected", "invalid_argument", "invalid_transition", "child_limit", "capture_invalid", "intent_expired":
				code = denial.Error
			}
		}
	}
	if errors.Is(err, runner.ErrProtocol) {
		code = "request_rejected"
	}
	return &daemon.Failure{Code: code}
}
