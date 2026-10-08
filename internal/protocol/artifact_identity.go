// ABOUTME: Derives the fixed online artifact operation identity from its closed original reference.
// ABOUTME: Keeps publication independent of local paths, renewed credentials and protected capture tools.

package protocol

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

	"github.com/qdis/bfb/internal/protocol/generated"
)

func ArtifactOperationKey(reference generated.AgentWorkRequest) (string, error) {
	encoded, err := json.Marshal(reference)
	if err != nil || !DecodeWireDocument("agent-work-request", encoded).OK {
		return "", errors.New("artifact reference rejected")
	}
	encoded, err = json.Marshal(map[string]any{"tool": "publish_artifact", "schema_version": reference.SchemaVersion,
		"run_execution_id": reference.RunExecutionId, "assignment_generation": reference.AssignmentGeneration, "request_id": reference.RequestId})
	if err != nil {
		return "", err
	}
	canonical, err := NormalizeJSON(encoded)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(canonical))
	return "agent:" + hex.EncodeToString(digest[:]), nil
}
