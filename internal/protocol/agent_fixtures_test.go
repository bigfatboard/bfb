// ABOUTME: Runs every generated v2 agent document fixture through the production Go codec.
// ABOUTME: Proves mixed versions and undeclared fields fail without changing general v1 acceptance.

package protocol_test

import (
	"encoding/json"
	"github.com/qdis/bfb/internal/protocol"
	"os"
	"path/filepath"
	"testing"
)

func TestAgentDocumentFixtures(t *testing.T) {
	root, err := protocol.RepositoryRoot()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "protocol/fixtures/v2/local-agent-rpc.json"))
	if err != nil {
		t.Fatal(err)
	}
	var matrix struct {
		Document string `json:"document"`
		Version  int    `json:"schema_version"`
		Fixtures []struct {
			Name     string `json:"name"`
			Document string `json:"document"`
			JSON     string `json:"json"`
			Accept   bool   `json:"accept"`
		} `json:"fixtures"`
	}
	if err := json.Unmarshal(data, &matrix); err != nil {
		t.Fatal(err)
	}
	if matrix.Document != "local-agent-rpc" || matrix.Version != 2 || len(matrix.Fixtures) == 0 {
		t.Fatal("invalid agent fixture catalog")
	}
	for _, fixture := range matrix.Fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			result := protocol.DecodeWireDocument(fixture.Document, []byte(fixture.JSON))
			if result.OK != fixture.Accept {
				t.Fatalf("accept=%v got %#v", fixture.Accept, result.Error)
			}
			if result.OK {
				again := protocol.DecodeWireDocument(fixture.Document, []byte(result.JSON))
				if !again.OK || again.JSON != result.JSON {
					t.Fatal("unstable v2 re-encoding", again.Error)
				}
			}
		})
	}
}
