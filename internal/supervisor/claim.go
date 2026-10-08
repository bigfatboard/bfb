// ABOUTME: Recomputes immutable C09 launch hashes and binds every local assignment to its command.
// ABOUTME: Rejects valid-looking but inconsistent scope, configuration and expiry before any Terminal effect.

package supervisor

import (
	"bytes"
	"encoding/json"
	"io"
	"time"

	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
)

// claimOutcome validates the non-document HTTP wrapper before the generated
// claim decoder. Map unmarshalling alone would hide duplicate JSON keys.
func claimOutcome(data []byte, command LocalCommand) (*generated.LaunchClaimResult, error) {
	if len(data) == 0 || len(data) > 40000 {
		return nil, failure("execution_assignment_invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil, failure("execution_assignment_invalid")
	}
	fields := map[string]json.RawMessage{}
	for decoder.More() {
		token, err := decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok || (key != "state" && key != "claim" && key != "reason") || fields[key] != nil {
			return nil, failure("execution_assignment_invalid")
		}
		var value json.RawMessage
		if decoder.Decode(&value) != nil {
			return nil, failure("execution_assignment_invalid")
		}
		fields[key] = value
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') {
		return nil, failure("execution_assignment_invalid")
	}
	if _, err := decoder.Token(); err != io.EOF || len(fields) != 2 {
		return nil, failure("execution_assignment_invalid")
	}
	var state, reason string
	if json.Unmarshal(fields["state"], &state) != nil {
		return nil, failure("execution_assignment_invalid")
	}
	if state == "claimed" && fields["claim"] != nil {
		decoded := protocol.DecodeWireDocument("launch-claim-result", fields["claim"])
		var claim generated.LaunchClaimResult
		if !decoded.OK || json.Unmarshal([]byte(decoded.JSON), &claim) != nil {
			return nil, failure("execution_assignment_invalid")
		}
		if err := validateClaim(claim, command.WorkspaceID, command.RunnerID, command.ID, command.ExpiresAt); err != nil {
			return nil, err
		}
		return &claim, nil
	}
	if json.Unmarshal(fields["reason"], &reason) == nil && ((state == "expired" && reason == "launch_expired") || (state == "rejected" && reason == "launch_blocked")) {
		return nil, nil
	}
	return nil, failure("execution_assignment_invalid")
}

func wireJSON(document string, value any) ([]byte, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, failure("invalid_request")
	}
	decoded := protocol.DecodeWireDocument(document, data)
	if !decoded.OK {
		return nil, failure("invalid_request")
	}
	return []byte(decoded.JSON), nil
}

// Snapshot fields use ASCII keys and bounded exact integers. The shared codec
// normalizes lexical integers; encoding the map sorts keys recursively, matching
// C09 canonicalLaunchJson rather than the declaration order of generated structs.
func snapshotHash(snapshot generated.LaunchSnapshot) (string, error) {
	data, err := wireJSON("launch-snapshot", snapshot)
	if err != nil {
		return "", err
	}
	decoded := protocol.DecodeWireDocument("launch-snapshot", data)
	var canonical bytes.Buffer
	encoder := json.NewEncoder(&canonical)
	encoder.SetEscapeHTML(false)
	if err = encoder.Encode(decoded.Value); err != nil {
		return "", failure("invalid_request")
	}
	return provider.Hash(bytes.TrimSuffix(canonical.Bytes(), []byte{'\n'})), nil
}

func validateClaim(claim generated.LaunchClaimResult, workspace, runner, command, expires string) error {
	if _, err := wireJSON("launch-claim-result", claim); err != nil {
		return err
	}
	spec, assignment, snapshot := claim.Specification, claim.Assignment, claim.Snapshot
	if assignment.EndedAt != nil || assignment.WorkspaceId != workspace || assignment.RunnerId != runner || spec.LaunchId != command || spec.ExpiresAt != expires || spec.RunExecutionId != assignment.RunExecutionId || spec.AssignmentGeneration != assignment.AssignmentGeneration || spec.RunId != assignment.RunId || spec.TaskId != assignment.TaskId || spec.RunnerId != assignment.RunnerId || spec.CheckoutId != assignment.CheckoutId || snapshot.WorkspaceId != assignment.WorkspaceId || snapshot.ProjectId != assignment.ProjectId || snapshot.TaskId != assignment.TaskId || snapshot.AgentProfileId != spec.AgentProfileId {
		return failure("execution_assignment_invalid")
	}
	want, _ := json.Marshal(spec.ExecutionConfig)
	actual, _ := json.Marshal(snapshot.ExecutionConfig)
	hash, err := snapshotHash(snapshot)
	if err != nil || !bytes.Equal(want, actual) || hash != spec.ConfigSnapshotHash {
		return failure("execution_assignment_invalid")
	}
	created, _ := time.Parse(time.RFC3339Nano, assignment.CreatedAt)
	deadline, _ := time.Parse(time.RFC3339Nano, expires)
	if !deadline.After(created) || deadline.Sub(created) > 120*time.Second {
		return failure("execution_assignment_invalid")
	}
	return nil
}
