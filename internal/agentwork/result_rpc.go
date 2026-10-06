// ABOUTME: Exposes only the negotiated result-submission action to verified local agent processes.
// ABOUTME: Derives execution authority from kernel and immutable daemon state before protected admission.

package agentwork

import (
	"context"
	"encoding/json"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/localmcp"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

func registerResultRPC(registry *daemon.Registry, service *workService) error {
	return registry.Register("mcp.v5.submit_result", func(ctx context.Context, request daemon.Request) (map[string]any, error) {
		data, err := json.Marshal(request.Envelope.Payload["agent_result_request"])
		if err != nil || request.Envelope.SchemaVersion != 5 || len(request.Envelope.Payload) != 1 || request.Store == nil || !protocol.DecodeWireDocument("agent-result-local-request", data).OK {
			return nil, &daemon.Failure{Code: "invalid_request"}
		}
		var input generated.AgentResultLocalRequest
		var body struct {
			Request struct {
				Reference generated.AgentWorkRequest `json:"reference"`
			} `json:"request"`
		}
		if json.Unmarshal(data, &input) != nil || json.Unmarshal(data, &body) != nil {
			return nil, &daemon.Failure{Code: "invalid_request"}
		}
		ref := body.Request.Reference
		callerInput := generated.AgentLocalRequest{Correlation: input.Correlation, Request: ref}
		_, caller, err := localmcp.VerifyDaemonCaller(ctx, request, callerInput)
		if err != nil {
			failure := &daemon.Failure{Code: localmcp.CodeOf(err)}
			service.results.invalidateOnDenial(failure)
			return nil, failure
		}
		check := func(ctx context.Context) error {
			_, current, err := localmcp.VerifyDaemonCaller(ctx, request, callerInput)
			if err != nil {
				return &daemon.Failure{Code: localmcp.CodeOf(err)}
			}
			if current.StartIdentity != caller.StartIdentity {
				return &daemon.Failure{Code: "peer_denied"}
			}
			return nil
		}
		return service.submitResult(ctx, input, ref, check)
	})
}
