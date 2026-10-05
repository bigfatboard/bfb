// ABOUTME: Owns fixed agent read RPC actions using the daemon's authenticated runner connections.
// ABOUTME: Preserves typed denials and verifies native caller containment before and after network waits.

package agentwork

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/localmcp"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/runner"
)

type ConnectionLookup func(string) (runner.RunnerConnection, error)

// RegisterRPC is a fixed work-action bridge, not a URL, principal or shell proxy.
func RegisterRPC(registry *daemon.Registry, connection ConnectionLookup) error {
	actions := map[string]struct{ action, document, field string }{
		"mcp.authority":   {"authority", "agent-authority-result", "agent_authority"},
		"mcp.get_context": {"context", "agent-context-result", "agent_context"},
		"mcp.get_task":    {"task", "agent-task-result", "agent_task"},
	}
	for method, action := range actions {
		if err := registry.Register(method, func(ctx context.Context, request daemon.Request) (map[string]any, error) {
			data, err := json.Marshal(request.Envelope.Payload["agent_request"])
			if err != nil || len(request.Envelope.Payload) != 1 || !protocol.DecodeWireDocument("agent-local-request", data).OK {
				return nil, &daemon.Failure{Code: "invalid_request"}
			}
			var input generated.AgentLocalRequest
			if json.Unmarshal(data, &input) != nil || request.Store == nil {
				return nil, &daemon.Failure{Code: "invalid_request"}
			}
			assignment, caller, err := localmcp.VerifyDaemonCaller(ctx, request, input)
			if err != nil {
				return nil, &daemon.Failure{Code: localmcp.CodeOf(err)}
			}
			channel, err := connection(assignment.Boundary.RunnerID)
			if err != nil {
				return nil, channelError(err, nil)
			}
			body, _ := json.Marshal(input.Request)
			result, err := channel.Request(ctx, "POST", "work/"+action.action, body)
			if err != nil {
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
			var value any
			if json.Unmarshal(result, &value) != nil {
				return nil, &daemon.Failure{Code: "invalid_request"}
			}
			payload := map[string]any{action.field: value}
			if _, err := daemon.EncodeEnvelope(daemon.Response(method, request.Envelope.RequestId, payload, nil)); err != nil {
				return nil, &daemon.Failure{Code: "request_rejected"}
			}
			return payload, nil
		}); err != nil {
			return err
		}
	}
	return nil
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
			case "revoked", "assignment_ended", "capability_closed", "boundary_escape", "forbidden", "not_found", "request_rejected":
				code = denial.Error
			}
		}
	}
	if errors.Is(err, runner.ErrProtocol) {
		code = "request_rejected"
	}
	return &daemon.Failure{Code: code}
}
