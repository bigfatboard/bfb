// ABOUTME: Tests online artifact v6 documents and recovery identities with the shared fixture matrix.
// ABOUTME: Checks generated Go round trips preserve nullable phases and optional target absence.

package protocol_test

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

func TestArtifactDocumentFixtures(t *testing.T) {
	root, err := protocol.RepositoryRoot()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "protocol/fixtures/v6/local-agent-artifact-rpc.json"))
	if err != nil {
		t.Fatal(err)
	}
	var matrix struct {
		Owner        string `json:"owner_command"`
		Document     string `json:"document"`
		Version      int    `json:"schema_version"`
		Synthetic    bool   `json:"synthetic"`
		OperationKey string `json:"operation_key"`
		RequestHash  string `json:"canonical_request_sha256"`
		Fixtures     []struct {
			Name, Document, JSON string
			Accept               bool
			Hash                 string `json:"canonical_sha256"`
		}
	}
	if json.Unmarshal(data, &matrix) != nil || matrix.Owner != "pnpm protocol:generate" || matrix.Document != "local-agent-artifact-rpc" || matrix.Version != 6 || !matrix.Synthetic || len(matrix.Fixtures) < 90 || protocol.ProtocolHead() != "bfb-wire/1" {
		t.Fatal("invalid artifact fixture catalog")
	}
	seen := map[string]bool{}
	for _, fixture := range matrix.Fixtures {
		if seen[fixture.Name] {
			t.Fatal("duplicate fixture", fixture.Name)
		}
		seen[fixture.Name] = true
		t.Run(fixture.Name, func(t *testing.T) {
			decoded := protocol.DecodeWireDocument(fixture.Document, []byte(fixture.JSON))
			if decoded.OK != fixture.Accept {
				t.Fatalf("accept=%v got %#v", fixture.Accept, decoded.Error)
			}
			if !decoded.OK {
				return
			}
			if fmt.Sprintf("%x", sha256.Sum256([]byte(decoded.JSON))) != fixture.Hash {
				t.Fatal("canonical hash mismatch")
			}
			var target any
			switch fixture.Document {
			case "agent-artifact-request":
				target = &generated.AgentArtifactRequest{}
			case "agent-artifact-local-request":
				target = &generated.AgentArtifactLocalRequest{}
			case "agent-artifact-prepare-result":
				target = &generated.AgentArtifactPrepareResult{}
			case "agent-artifact-result":
				target = &generated.AgentArtifactResult{}
			case "local-agent-artifact-rpc":
				target = &generated.LocalAgentArtifactRpcEnvelope{}
			}
			if target == nil || json.Unmarshal([]byte(decoded.JSON), target) != nil {
				t.Fatal("generated type cannot consume fixture")
			}
			encoded, err := json.Marshal(target)
			if err != nil {
				t.Fatal(err)
			}
			typed := protocol.DecodeWireDocument(fixture.Document, encoded)
			if !typed.OK || typed.JSON != decoded.JSON {
				t.Fatal("generated type changed null or optional presence", typed.Error)
			}
			if fixture.Name == "agent-artifact-request-minimal" {
				if fmt.Sprintf("%x", sha256.Sum256([]byte(decoded.JSON))) != matrix.RequestHash {
					t.Fatal("request fingerprint changed")
				}
				request := target.(*generated.AgentArtifactRequest)
				if request.ArtifactId != nil {
					t.Fatal("optional target became present")
				}
				identity, _ := json.Marshal(map[string]any{"tool": "publish_artifact", "schema_version": request.Reference.SchemaVersion, "run_execution_id": request.Reference.RunExecutionId, "assignment_generation": request.Reference.AssignmentGeneration, "request_id": request.Reference.RequestId})
				canonical, err := protocol.NormalizeJSON(identity)
				if err != nil || "agent:"+fmt.Sprintf("%x", sha256.Sum256([]byte(canonical))) != matrix.OperationKey {
					t.Fatal("operation identity changed", err)
				}
			}
		})
	}
}
