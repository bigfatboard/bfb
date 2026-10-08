// ABOUTME: Runs every generated v2 agent document fixture through the production Go codec.
// ABOUTME: Proves mixed versions and undeclared fields fail without changing general v1 acceptance.

package protocol_test

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
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
			Name                string `json:"name"`
			Document            string `json:"document"`
			JSON                string `json:"json"`
			Accept              bool   `json:"accept"`
			CanonicalHash       string `json:"canonical_sha256"`
			ProgressRequestHash string `json:"progress_request_sha256"`
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
				if fixture.CanonicalHash != "" {
					if hash := fmt.Sprintf("%x", sha256.Sum256([]byte(result.JSON))); hash != fixture.CanonicalHash {
						t.Fatalf("canonical TypeScript/Go hash mismatch: %s != %s", hash, fixture.CanonicalHash)
					}
					var request any = result.Value
					switch fixture.Document {
					case "agent-progress-local-request":
						request = result.Value["request"]
					case "local-agent-rpc":
						request = result.Value["payload"].(map[string]any)["agent_progress_request"].(map[string]any)["request"]
					}
					encoded, err := json.Marshal(request)
					if err != nil {
						t.Fatal(err)
					}
					typed := protocol.DecodeWireDocument("agent-progress-request", encoded)
					if !typed.OK {
						t.Fatal("normalized typed progress request rejected", typed.Error)
					}
					if hash := fmt.Sprintf("%x", sha256.Sum256([]byte(typed.JSON))); hash != fixture.ProgressRequestHash {
						t.Fatalf("typed progress fingerprint mismatch: %s != %s", hash, fixture.ProgressRequestHash)
					}
				}
			}
		})
	}
}

func TestParseWireInteger(t *testing.T) {
	for _, test := range []struct {
		source string
		value  int64
		valid  bool
	}{
		{"3", 3, true},
		{"3.0", 3, true},
		{"30e-1", 3, true},
		{"-0e9999999999", 0, true},
		{"9007199254740991", 9007199254740991, true},
		{"-9007199254740991", -9007199254740991, true},
		{"3.00000000000000001", 0, false},
		{"9007199254740992", 0, false},
		{"1e-324", 0, false},
		{"1e9999999999", 0, false},
		{"NaN", 0, false},
	} {
		t.Run(test.source, func(t *testing.T) {
			value, valid := protocol.ParseWireInteger(test.source)
			if valid != test.valid || (valid && value != test.value) {
				t.Fatalf("value=%d valid=%v, expected value=%d valid=%v", value, valid, test.value, test.valid)
			}
		})
	}
}
