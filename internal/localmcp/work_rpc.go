// ABOUTME: Sends the four closed agent writes through daemon-owned v3 admission.
// ABOUTME: Validates bounded receipts and committed scope without exposing capture state or credentials.

package localmcp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

type agentWorkAction struct {
	action, method, requestDocument, inputField, resultDocument, resultField string
	inputFields                                                              []string
}

var agentWorkActions = map[string]agentWorkAction{
	"bfb_add_comment":     {"comment", "mcp.v3.add_comment", "agent-comment-request", "agent_comment_request", "agent-comment-result", "agent_comment", []string{"body"}},
	"bfb_update_task":     {"update", "mcp.v3.update_task", "agent-update-request", "agent_update_request", "agent-update-result", "agent_update", []string{"expected_version", "title", "punchline"}},
	"bfb_report_progress": {"progress", "mcp.v3.report_progress", "agent-progress-request", "agent_progress_request", "agent-comment-result", "agent_comment", []string{"summary", "percent", "confidence"}},
	"bfb_propose_task":    {"proposal", "mcp.v3.propose_task", "agent-proposal-request", "agent_proposal_request", "agent-proposal-result", "agent_proposal", []string{"title", "priority", "parent_task_id"}},
}

// This private seam is implemented only by the daemon transport in production.
// Legacy WorkTransport writes remain available to the isolated package fixtures.
type agentAdmissionTransport interface {
	admitAgentWork(context.Context, Boundary, ConfirmedSession, string, map[string]any, string) (any, error)
}

func (transport RPCTransport) admitAgentWork(ctx context.Context, boundary Boundary, session ConfirmedSession, tool string, params map[string]any, requestID string) (any, error) {
	action, supported := agentWorkActions[tool]
	if !supported {
		return nil, fail("not_implemented")
	}
	reference := operationReference(boundary, requestID)
	original := map[string]any{"reference": reference, "binding": session}
	for _, field := range action.inputFields {
		if value, present := params[field]; present {
			original[field] = value
		}
	}
	// Preserve text whitespace and optional presence. The closed codec, rather
	// than defaults or a second business implementation, checks original bytes.
	data, err := json.Marshal(original)
	if err != nil || !protocol.DecodeWireDocument(action.requestDocument, data).OK {
		return nil, fail("invalid_params")
	}
	response, err := daemon.CallAgentWork(ctx, transport.Paths, action.method, map[string]any{
		action.inputField: map[string]any{"request": original, "correlation": transport.Correlation},
	})
	if err != nil {
		code := daemon.AsFailure(err).Code
		switch code {
		case "daemon_offline", "runner_credential_unavailable":
			code = "offline_rejected"
		case "invalid_request":
			code = "request_rejected"
		}
		return nil, fail(code)
	}
	if value, present := response.Payload["agent_work_receipt"]; present {
		return checkedAgentWorkReceipt(value, action.action, tool, reference)
	}
	data, err = json.Marshal(response.Payload[action.resultField])
	if err != nil || !protocol.DecodeWireDocument(action.resultDocument, data).OK {
		return nil, fail("request_rejected")
	}
	switch tool {
	case "bfb_add_comment", "bfb_report_progress":
		var result generated.AgentCommentResult
		if json.Unmarshal(data, &result) != nil || !originMatches(result.Origin, boundary, session.ProviderSessionId) {
			return nil, fail("boundary_escape")
		}
		return CommentResult{ID: result.Id}, nil
	case "bfb_update_task":
		var result generated.AgentUpdateResult
		expected, ok := params["expected_version"].(float64)
		version, versionErr := checkVersion(expected)
		if !ok || versionErr != nil || json.Unmarshal(data, &result) != nil || !originMatches(result.Origin, boundary, session.ProviderSessionId) ||
			result.Task.Id != boundary.TaskID || result.Task.ProjectId != boundary.ProjectID || result.Task.ResourceVersion != version+1 {
			return nil, fail("boundary_escape")
		}
		return TaskView{ID: result.Task.Id, ProjectID: result.Task.ProjectId, State: result.Task.State, Priority: result.Task.Priority,
			Title: result.Task.Title, Punchline: result.Task.Punchline, ResourceVersion: result.Task.ResourceVersion}, nil
	default:
		var result generated.AgentProposalResult
		state := "proposed"
		if _, present := params["parent_task_id"]; present {
			state = "ready"
		}
		if json.Unmarshal(data, &result) != nil || !originMatches(result.Origin, boundary, session.ProviderSessionId) ||
			result.Id == boundary.TaskID || result.State != state {
			return nil, fail("boundary_escape")
		}
		return ProposeTaskResult{ID: result.Id, State: result.State}, nil
	}
}

func checkedAgentWorkReceipt(value any, action, tool string, reference generated.AgentWorkRequest) (generated.AgentWorkReceipt, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return generated.AgentWorkReceipt{}, fail("request_rejected")
	}
	decoded := protocol.DecodeWireDocument("agent-work-receipt", data)
	var receipt generated.AgentWorkReceipt
	if !decoded.OK || json.Unmarshal([]byte(decoded.JSON), &receipt) != nil {
		return generated.AgentWorkReceipt{}, fail("request_rejected")
	}
	// The scoped business key, not an IPC ID or capture's session/body, owns a receipt.
	identity, err := json.Marshal(map[string]any{"tool": action, "schema_version": reference.SchemaVersion,
		"run_execution_id": reference.RunExecutionId, "assignment_generation": reference.AssignmentGeneration, "request_id": reference.RequestId})
	if err != nil {
		return generated.AgentWorkReceipt{}, fail("request_rejected")
	}
	canonical, err := protocol.NormalizeJSON(identity)
	if err != nil {
		return generated.AgentWorkReceipt{}, fail("request_rejected")
	}
	digest := sha256.Sum256([]byte(canonical))
	expectedKey := "agent:" + hex.EncodeToString(digest[:])
	if receipt.OperationKey != expectedKey || receipt.RequestId != reference.RequestId || receipt.Tool != tool {
		return generated.AgentWorkReceipt{}, fail("boundary_escape")
	}
	return receipt, nil
}
