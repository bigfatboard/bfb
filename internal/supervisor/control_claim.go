// ABOUTME: Validates bounded C09 control receipts against their original inbox command and immutable local target.
// ABOUTME: Keeps cloud claim and terminal disposition semantics separate from authority to perform a native effect.

package supervisor

import (
	"encoding/json"

	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

func controlOutcome(data []byte, command LocalCommand) (generated.RunControlResult, error) {
	var result generated.RunControlResult
	if len(data) == 0 || len(data) > 8192 || command.Kind != "run_control" || command.CleanupLockID != "" {
		return result, failure("execution_assignment_invalid")
	}
	decoded := protocol.DecodeWireDocument("run-control-result", data)
	if !decoded.OK || json.Unmarshal([]byte(decoded.JSON), &result) != nil || result.ControlId != command.ID || result.RunnerId != command.RunnerID || result.ExpiresAt != command.ExpiresAt {
		return generated.RunControlResult{}, failure("execution_assignment_invalid")
	}
	disposition := ""
	if result.Disposition != nil {
		disposition = *result.Disposition
	}
	valid := false
	switch result.State {
	case "pending", "claimed":
		valid = result.Disposition == nil
	case "applied":
		valid = disposition == "applied" || disposition == "already_applied"
	case "rejected":
		valid = disposition == "local_rejected" || disposition == "delivery_unknown" || disposition == "authorization_lost"
	case "expired":
		valid = disposition == "expired"
	}
	if !valid || (result.ResumeLaunchId != nil && (result.Action != "resume" || result.State == "pending" || *result.ResumeLaunchId == result.ControlId)) ||
		(result.Action == "resume" && (result.State == "claimed" || result.State == "applied") && result.ResumeLaunchId == nil) {
		return generated.RunControlResult{}, failure("execution_assignment_invalid")
	}
	return result, nil
}

func controlTerminal(result generated.RunControlResult) bool {
	return result.State == "applied" || result.State == "rejected" || result.State == "expired"
}

func (effect controlEffect) matches(command LocalCommand, result generated.RunControlResult) bool {
	return effect.ID == command.ID && effect.RunnerID == command.RunnerID && effect.ClaimKey == command.ClaimKey && effect.ExpiresAt == command.ExpiresAt &&
		result.ControlId == effect.ID && result.RunnerId == effect.RunnerID && result.RunExecutionId == effect.ExecutionID &&
		result.AssignmentGeneration == effect.Generation && result.Action == effect.Action && result.ExpiresAt == effect.ExpiresAt &&
		(effect.ResumeLaunchID == "" || result.ResumeLaunchId != nil && *result.ResumeLaunchId == effect.ResumeLaunchID)
}

func (effect controlEffect) claimRequest() ([]byte, error) {
	return wireJSON("run-control-claim", generated.RunControlClaim{
		SchemaVersion: 1, ControlId: effect.ID, IdempotencyKey: effect.ClaimKey,
		RunExecutionId: effect.ExecutionID, AssignmentGeneration: effect.Generation, Action: effect.Action,
	})
}

func (effect controlEffect) dispositionRequest() ([]byte, error) {
	disposition := ""
	switch effect.State {
	case "applied":
		disposition = "applied"
	case "rejected":
		disposition = "local_rejected"
	case "delivery_unknown":
		disposition = "delivery_unknown"
	default:
		return nil, failure("execution_assignment_invalid")
	}
	return wireJSON("run-control-disposition", generated.RunControlDisposition{
		SchemaVersion: 1, ControlId: effect.ID, IdempotencyKey: effect.ClaimKey,
		RunExecutionId: effect.ExecutionID, AssignmentGeneration: effect.Generation, Disposition: disposition,
	})
}
