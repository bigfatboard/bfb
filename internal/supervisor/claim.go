// ABOUTME: Recomputes immutable C09 launch hashes and binds every local assignment to its command.
// ABOUTME: Rejects valid-looking but inconsistent scope, configuration and expiry before any Terminal effect.

package supervisor

import (
	"bytes"
	"encoding/json"
	"time"

	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
)

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
