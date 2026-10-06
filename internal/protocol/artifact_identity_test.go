// ABOUTME: Pins artifact operation-key parity to the shared v6 protocol fixture.
// ABOUTME: Rejects unqualified references and separates generation, execution and original request identity.

package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/qdis/bfb/internal/protocol/generated"
)

func TestArtifactOperationKeyMatchesSharedFixture(t *testing.T) {
	root, err := RepositoryRoot()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "protocol/fixtures/v6/local-agent-artifact-rpc.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixtures struct {
		OperationKey string `json:"operation_key"`
		Fixtures     []struct{ Name, JSON string }
	}
	if json.Unmarshal(data, &fixtures) != nil {
		t.Fatal("shared artifact fixtures invalid")
	}
	var original generated.AgentArtifactRequest
	found := false
	for _, fixture := range fixtures.Fixtures {
		if fixture.Name == "agent-artifact-request-minimal" {
			found = true
			if json.Unmarshal([]byte(fixture.JSON), &original) != nil {
				t.Fatal("shared artifact request invalid")
			}
		}
	}
	key, err := ArtifactOperationKey(original.Reference)
	if !found || err != nil || key != fixtures.OperationKey {
		t.Fatal("artifact identity differs from TS fixture", err, key)
	}
	for _, field := range []string{"schema", "generation", "request", "execution"} {
		t.Run(field, func(t *testing.T) {
			changed := original.Reference
			switch field {
			case "schema":
				changed.SchemaVersion = 2
			case "generation":
				changed.AssignmentGeneration++
			case "request":
				changed.RequestId = "artifact-changed-001"
			case "execution":
				changed.RunExecutionId = "01K6R7DT00BBBBBBBBBBBBBBBB"
			}
			changedKey, err := ArtifactOperationKey(changed)
			if field == "schema" {
				if err == nil {
					t.Fatal("non-original schema identity admitted")
				}
			} else if err != nil || changedKey == key {
				t.Fatal("distinct reference reused artifact identity", field, err)
			}
		})
	}
}
