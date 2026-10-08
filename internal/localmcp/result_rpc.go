// ABOUTME: Sends result submissions through the closed daemon-owned v5 capture lane.
// ABOUTME: Checks receipt identity and committed provenance without exposing signed capture state.

package localmcp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

type daemonResultTransport interface {
	AdmitResult(context.Context, Boundary, *ConfirmedSession, map[string]any, string) (any, error)
}

// resultBinding preserves an activated assertion without ordinary launch
// authorization. Submitted retries and provisional restarts are decided by v5.
func (capability *Capability) resultBinding(ctx context.Context) (*ConfirmedSession, error) {
	state := capability.State()
	if state == StateClosed {
		return nil, fail("capability_closed")
	}
	if state != StateActivated {
		return nil, nil
	}
	session := capability.ConfirmedSession()
	binding, err := capability.bindings.ObservedBinding(ctx, capability.ref())
	if errors.Is(err, ErrSessionNotBound) {
		return nil, fail("session_not_bound")
	}
	if err != nil {
		return nil, err
	}
	if !bindingMatches(capability.ref(), binding) || binding.Provider != session.Provider || binding.ObservedSessionID != session.ObservedSessionId {
		return nil, fail("session_conflict")
	}
	return &session, nil
}

// AdmitResult sends only original input and an optional already-confirmed MCP
// assertion. A fresh verified CLI omits that assertion; the daemon owns binding.
func (transport RPCTransport) AdmitResult(ctx context.Context, boundary Boundary, expected *ConfirmedSession, params map[string]any, requestID string) (any, error) {
	reference := operationReference(boundary, requestID)
	original := map[string]any{"reference": reference}
	for _, field := range []string{"summary", "limitations", "evidence_refs", "git_branch", "git_commit", "git_dirty"} {
		if value, present := params[field]; present {
			original[field] = value
		}
	}
	local := map[string]any{"request": original, "correlation": transport.Correlation}
	if expected != nil {
		local["expected_binding"] = expected
	}
	data, err := json.Marshal(local)
	if err != nil || !protocol.DecodeWireDocument("agent-result-local-request", data).OK {
		return nil, fail("invalid_params")
	}
	response, err := daemon.CallAgentResult(ctx, transport.Paths, "mcp.v5.submit_result", map[string]any{"agent_result_request": local})
	if err != nil {
		code := daemon.AsFailure(err).Code
		switch {
		case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded), code == "daemon_offline", code == "runner_credential_unavailable":
			code = "offline_rejected"
		case code == "invalid_request":
			code = "request_rejected"
		}
		return nil, fail(code)
	}
	if value, present := response.Payload["agent_result_receipt"]; present {
		return checkedAgentResultReceipt(value, reference)
	}
	data, err = json.Marshal(response.Payload["agent_result"])
	var result generated.AgentResultResult
	if err != nil || !protocol.DecodeWireDocument("agent-result-result", data).OK || json.Unmarshal(data, &result) != nil {
		return nil, fail("request_rejected")
	}
	if result.Origin.RunId != boundary.RunID || result.Origin.RunExecutionId != boundary.ExecutionID || result.Origin.AssignmentGeneration != boundary.Generation ||
		(expected != nil && result.Origin.ProviderSessionId != expected.ProviderSessionId) {
		return nil, fail("boundary_escape")
	}
	return result, nil
}

func checkedAgentResultReceipt(value any, reference generated.AgentWorkRequest) (generated.AgentResultReceipt, error) {
	data, err := json.Marshal(value)
	var receipt generated.AgentResultReceipt
	if err != nil || !protocol.DecodeWireDocument("agent-result-receipt", data).OK || json.Unmarshal(data, &receipt) != nil {
		return receipt, fail("request_rejected")
	}
	identity, err := json.Marshal(map[string]any{"tool": "submit_result", "schema_version": reference.SchemaVersion,
		"run_execution_id": reference.RunExecutionId, "assignment_generation": reference.AssignmentGeneration, "request_id": reference.RequestId})
	if err != nil {
		return receipt, fail("request_rejected")
	}
	canonical, err := protocol.NormalizeJSON(identity)
	if err != nil {
		return receipt, fail("request_rejected")
	}
	digest := sha256.Sum256([]byte(canonical))
	if receipt.OperationKey != "agent:"+hex.EncodeToString(digest[:]) || receipt.RequestId != reference.RequestId || receipt.Tool != "bfb_submit_result" {
		return receipt, fail("boundary_escape")
	}
	return receipt, nil
}
