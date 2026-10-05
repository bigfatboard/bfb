// ABOUTME: Carries closed online attention requests and fresh reads through the checked v4 daemon lane.
// ABOUTME: Separates original record provenance from current session authority without journal admission.

package localmcp

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

// Only this fixed transport can omit a redundant authority RPC for each poll:
// its daemon/cloud read performs fresh authorization and native postflight.
type daemonAttentionTransport interface{ attentionReadAuthorizes() }

func (RPCTransport) attentionReadAuthorizes() {}

func (transport RPCTransport) callAttention(ctx context.Context, method string, input any) (generated.AgentAttentionResult, error) {
	field := "agent_attention_request"
	if method == "mcp.v4.get_attention" {
		field = "agent_attention_read_request"
	}
	response, err := daemon.CallAgentAttention(ctx, transport.Paths, method, map[string]any{field: input})
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return generated.AgentAttentionResult{}, fail("offline_rejected")
		}
		code := daemon.AsFailure(err).Code
		switch code {
		case "daemon_offline", "runner_credential_unavailable":
			code = "offline_rejected"
		case "invalid_request":
			code = "request_rejected"
		}
		return generated.AgentAttentionResult{}, fail(code)
	}
	data, err := json.Marshal(response.Payload["agent_attention"])
	var result generated.AgentAttentionResult
	if err != nil || !protocol.DecodeWireDocument("agent-attention-result", data).OK || json.Unmarshal(data, &result) != nil {
		return result, fail("request_rejected")
	}
	return result, nil
}

func (transport RPCTransport) RequestAttention(ctx context.Context, boundary Boundary, session ConfirmedSession, request AttentionRequest, requestID string) (AttentionRecord, error) {
	input := generated.AgentAttentionRequest{Reference: operationReference(boundary, requestID), Binding: session, Kind: request.Kind, Question: request.Question, Blocking: request.Blocking}
	if request.ReferenceKind != "" {
		input.ReferenceKind = &request.ReferenceKind
		input.ReferenceId = &request.ReferenceID
	}
	result, err := transport.callAttention(ctx, "mcp.v4.request_human", generated.AgentAttentionLocalRequest{Correlation: transport.Correlation, Request: input})
	if err != nil {
		return AttentionRecord{}, err
	}
	if result.Origin.RunId != boundary.RunID || result.Origin.RunExecutionId != boundary.ExecutionID || int64(result.Origin.AssignmentGeneration) != boundary.Generation {
		return AttentionRecord{}, fail("boundary_escape")
	}
	if result.AuthorityBinding == nil || *result.AuthorityBinding != session {
		return AttentionRecord{}, fail("session_conflict")
	}
	if result.Attention.Kind != request.Kind || result.Attention.Question != request.Question || result.Attention.Blocking != request.Blocking {
		return AttentionRecord{}, fail("request_rejected")
	}
	return attentionMetadata(result.Attention), nil
}

func (transport RPCTransport) GetAttention(ctx context.Context, boundary Boundary, session *ConfirmedSession, attentionID, requestID string) (AttentionRecord, error) {
	input := generated.AgentAttentionReadLocalRequest{Correlation: transport.Correlation, Request: generated.AgentAttentionReadRequest{Reference: operationReference(boundary, requestID), AttentionId: attentionID, Binding: session}}
	result, err := transport.callAttention(ctx, "mcp.v4.get_attention", input)
	if err != nil {
		return AttentionRecord{}, err
	}
	if result.Origin.RunId != boundary.RunID || result.Attention.Id != attentionID {
		return AttentionRecord{}, fail("boundary_escape")
	}
	if session != nil && (result.AuthorityBinding == nil || *result.AuthorityBinding != *session) {
		return AttentionRecord{}, fail("session_conflict")
	}
	return attentionMetadata(result.Attention), nil
}

// Preserve the existing MCP projection's empty strings while the private wire
// distinguishes required null from absent fields and validates state pairs.
func attentionMetadata(input generated.AgentAttentionRecord) AttentionRecord {
	result := AttentionRecord{ID: input.Id, Kind: input.Kind, RequiredRole: input.RequiredRole, Question: input.Question, Blocking: input.Blocking, State: input.State, ResourceVersion: int64(input.ResourceVersion), RequestedAt: string(input.RequestedAt)}
	if input.Answer != nil {
		result.Answer = *input.Answer
	}
	if input.FirstResponseAt != nil {
		result.FirstResponseAt = string(*input.FirstResponseAt)
	}
	if input.AnsweredAt != nil {
		result.AnsweredAt = string(*input.AnsweredAt)
	}
	if input.ResolvedAt != nil {
		result.ResolvedAt = string(*input.ResolvedAt)
	}
	return result
}
