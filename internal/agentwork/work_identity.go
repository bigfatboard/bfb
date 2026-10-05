// ABOUTME: Maps the four fixed agent writes to their original business operation identities.
// ABOUTME: Keeps IPC and capture envelope versions separate from the immutable request schema and key.

package agentwork

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

var errWorkIdentityInvalid = errors.New("agent work identity invalid")

type workCommand struct {
	name, action, tool, method                 string
	requestDocument, localDocument, localField string
	resultDocument, resultField                string
}

func agentWorkCommand(name string) (workCommand, bool) {
	switch name {
	case "agent_run.comment":
		return workCommand{name, "comment", "bfb_add_comment", "mcp.v3.add_comment", "agent-comment-request", "agent-comment-local-request", "agent_comment_request", "agent-comment-result", "agent_comment"}, true
	case "agent_run.update":
		return workCommand{name, "update", "bfb_update_task", "mcp.v3.update_task", "agent-update-request", "agent-update-local-request", "agent_update_request", "agent-update-result", "agent_update"}, true
	case "agent_run.progress":
		return workCommand{name, "progress", "bfb_report_progress", "mcp.v3.report_progress", "agent-progress-request", "agent-progress-local-request", "agent_progress_request", "agent-comment-result", "agent_comment"}, true
	case "agent_run.proposal":
		return workCommand{name, "proposal", "bfb_propose_task", "mcp.v3.propose_task", "agent-proposal-request", "agent-proposal-local-request", "agent_proposal_request", "agent-proposal-result", "agent_proposal"}, true
	default:
		return workCommand{}, false
	}
}

// agentOperationKey mirrors domain.agentWorkKey. Payload fingerprints and
// admission metadata never participate in the scoped business identity.
func agentOperationKey(commandName string, reference generated.AgentWorkRequest) (string, error) {
	command, known := agentWorkCommand(commandName)
	encoded, err := json.Marshal(reference)
	if !known || err != nil || !protocol.DecodeWireDocument("agent-work-request", encoded).OK {
		return "", errWorkIdentityInvalid
	}
	encoded, err = json.Marshal(map[string]any{
		"tool": command.action, "schema_version": reference.SchemaVersion,
		"run_execution_id": reference.RunExecutionId, "assignment_generation": reference.AssignmentGeneration,
		"request_id": reference.RequestId,
	})
	if err != nil {
		return "", errWorkIdentityInvalid
	}
	canonical, err := protocol.NormalizeJSON(encoded)
	if err != nil {
		return "", errWorkIdentityInvalid
	}
	digest := sha256.Sum256([]byte(canonical))
	return "agent:" + hex.EncodeToString(digest[:]), nil
}
