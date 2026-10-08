// ABOUTME: Runs the closed online attention fixtures through the production Go codec.
// ABOUTME: Checks canonical parity, required nullable fields and frozen older envelope boundaries.

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

func TestAttentionDocumentFixtures(t *testing.T) {
	root, err := protocol.RepositoryRoot()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "protocol/fixtures/v4/local-agent-attention-rpc.json"))
	if err != nil {
		t.Fatal(err)
	}
	var matrix struct {
		Owner    string `json:"owner_command"`
		Document string `json:"document"`
		Version  int    `json:"schema_version"`
		Fixtures []struct {
			Name     string `json:"name"`
			Document string `json:"document"`
			JSON     string `json:"json"`
			Accept   bool   `json:"accept"`
			Hash     string `json:"canonical_sha256"`
		} `json:"fixtures"`
	}
	if err := json.Unmarshal(data, &matrix); err != nil {
		t.Fatal(err)
	}
	if matrix.Owner != "pnpm protocol:generate" || matrix.Document != "local-agent-attention-rpc" || matrix.Version != 4 || len(matrix.Fixtures) == 0 || protocol.ProtocolHead() != "bfb-wire/1" {
		t.Fatal("invalid separate attention fixture catalog")
	}
	seen := make(map[string]bool)
	for _, fixture := range matrix.Fixtures {
		if seen[fixture.Name] {
			t.Fatal("duplicate fixture name", fixture.Name)
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
				t.Fatal("cross-language canonical hash mismatch")
			}
			var target any
			switch fixture.Document {
			case "agent-attention-request":
				target = &generated.AgentAttentionRequest{}
			case "agent-attention-read-request":
				target = &generated.AgentAttentionReadRequest{}
			case "agent-attention-record":
				target = &generated.AgentAttentionRecord{}
			case "agent-attention-origin":
				target = &generated.AgentAttentionOrigin{}
			case "agent-attention-result":
				target = &generated.AgentAttentionResult{}
			case "agent-attention-local-request":
				target = &generated.AgentAttentionLocalRequest{}
			case "agent-attention-read-local-request":
				target = &generated.AgentAttentionReadLocalRequest{}
			case "local-agent-attention-rpc":
				target = &generated.LocalAgentAttentionRpcEnvelope{}
			default:
				t.Fatal("unexpected accepted document", fixture.Document)
			}
			if json.Unmarshal([]byte(decoded.JSON), target) != nil {
				t.Fatal("generated type cannot consume accepted document")
			}
			encoded, err := json.Marshal(target)
			if err != nil {
				t.Fatal(err)
			}
			again := protocol.DecodeWireDocument(fixture.Document, encoded)
			if !again.OK || again.JSON != decoded.JSON {
				t.Fatal("generated nullable tags or canonical re-encoding changed accepted input", again.Error)
			}
		})
	}
}
