// ABOUTME: Bridges two fixed online attention actions through the authenticated runner channel.
// ABOUTME: Checks caller ownership and trusted session observations before dispatch and private delivery.

package agentwork

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/journal"
	"github.com/qdis/bfb/internal/localmcp"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

func registerAttentionRPC(registry *daemon.Registry, connection ConnectionLookup, ownership OwnershipCheck) error {
	for method, action := range map[string]struct{ path, document, field string }{
		"mcp.v4.request_human": {"attention-request", "agent-attention-local-request", "agent_attention_request"},
		"mcp.v4.get_attention": {"attention-get", "agent-attention-read-local-request", "agent_attention_read_request"},
	} {
		if err := registry.Register(method, func(ctx context.Context, request daemon.Request) (map[string]any, error) {
			data, err := json.Marshal(request.Envelope.Payload[action.field])
			if err != nil || request.Envelope.SchemaVersion != 4 || len(request.Envelope.Payload) != 1 || !protocol.DecodeWireDocument(action.document, data).OK || request.Store == nil {
				return nil, &daemon.Failure{Code: "invalid_request"}
			}
			var wire struct {
				Correlation string          `json:"correlation"`
				Request     json.RawMessage `json:"request"`
			}
			var bound struct {
				Reference   generated.AgentWorkRequest       `json:"reference"`
				Binding     *generated.AgentSessionReference `json:"binding"`
				AttentionID string                           `json:"attention_id"`
			}
			if json.Unmarshal(data, &wire) != nil || json.Unmarshal(wire.Request, &bound) != nil || len(wire.Request) > 16_384 {
				return nil, &daemon.Failure{Code: "invalid_request"}
			}
			input := generated.AgentLocalRequest{Correlation: wire.Correlation, Request: bound.Reference}
			assignment, caller, err := localmcp.VerifyDaemonCaller(ctx, request, input)
			if err != nil {
				return nil, attentionBindingError(err)
			}
			if err := ownership(ctx, input.Request.RunExecutionId, input.Request.AssignmentGeneration); err != nil {
				return nil, ownershipError(err)
			}
			ref := localmcp.AssignmentRef{ExecutionID: input.Request.RunExecutionId, AssignmentGeneration: input.Request.AssignmentGeneration, RunID: assignment.Boundary.RunID}
			bindings := localmcp.JournalBindings{Sessions: journal.NewStore(request.Store.DB)}
			observed, err := bindings.ObservedBinding(ctx, ref)
			if err != nil && (!errors.Is(err, localmcp.ErrSessionNotBound) || bound.Binding != nil) {
				return nil, attentionBindingError(err)
			}
			if bound.Binding != nil && !attentionObservationMatches(bound.Binding, observed) {
				return nil, &daemon.Failure{Code: "session_conflict"}
			}
			channel, err := connection(assignment.Boundary.RunnerID)
			if err != nil {
				return nil, channelError(err, nil)
			}
			result, err := channel.Request(ctx, "POST", "work/"+action.path, wire.Request)
			if err != nil {
				return nil, channelError(err, result)
			}
			var value generated.AgentAttentionResult
			if !protocol.DecodeWireDocument("agent-attention-result", result).OK || json.Unmarshal(result, &value) != nil {
				return nil, &daemon.Failure{Code: "invalid_request"}
			}
			if err := validateAttentionOrigin(value, input.Request, assignment.Boundary.RunID, action.path == "attention-request"); err != nil {
				return nil, err
			}
			if action.path == "attention-get" && value.Attention.Id != bound.AttentionID {
				return nil, &daemon.Failure{Code: "boundary_escape"}
			}
			if bound.Binding != nil && (value.AuthorityBinding == nil || *value.AuthorityBinding != *bound.Binding) {
				return nil, &daemon.Failure{Code: "session_conflict"}
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
			if value.AuthorityBinding != nil {
				if observed.ObservedSessionID == "" {
					return nil, &daemon.Failure{Code: "session_not_bound"}
				}
				if !attentionObservationMatches(value.AuthorityBinding, observed) {
					return nil, &daemon.Failure{Code: "session_conflict"}
				}
				after, err := bindings.ObservedBinding(ctx, ref)
				if err != nil {
					return nil, attentionBindingError(err)
				}
				if after != observed {
					return nil, &daemon.Failure{Code: "session_conflict"}
				}
			}
			payload := map[string]any{"agent_attention": value}
			if _, err := daemon.EncodeEnvelope(daemon.ResponseVersion(4, method, request.Envelope.RequestId, payload, nil)); err != nil {
				return nil, &daemon.Failure{Code: "request_rejected"}
			}
			return payload, nil
		}); err != nil {
			return err
		}
	}
	return nil
}

func attentionObservationMatches(binding *generated.AgentSessionReference, observation localmcp.SessionBinding) bool {
	return binding != nil && binding.Provider == observation.Provider && binding.ObservedSessionId == observation.ObservedSessionID
}

func attentionBindingError(err error) error {
	if errors.Is(err, localmcp.ErrSessionNotBound) {
		return &daemon.Failure{Code: "session_not_bound"}
	}
	return &daemon.Failure{Code: localmcp.CodeOf(err)}
}

func validateAttentionOrigin(value generated.AgentAttentionResult, reference generated.AgentWorkRequest, runID string, creation bool) error {
	if value.Origin.RunId != runID || (creation && (value.Origin.RunExecutionId != reference.RunExecutionId || value.Origin.AssignmentGeneration != reference.AssignmentGeneration || value.AuthorityBinding == nil)) {
		return &daemon.Failure{Code: "boundary_escape"}
	}
	return nil
}
