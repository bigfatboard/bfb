// ABOUTME: Tests result-only wire shapes and original business bytes against shared deterministic fixtures.
// ABOUTME: Enforces separate capture domains, bounded receipts and frozen older protocol lanes.

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

func TestResultDocumentFixtures(t *testing.T) {
	root, err := protocol.RepositoryRoot()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "protocol/fixtures/v5/local-agent-result-rpc.json"))
	if err != nil {
		t.Fatal(err)
	}
	var matrix struct {
		Owner    string `json:"owner_command"`
		Document string `json:"document"`
		Version  int    `json:"schema_version"`
		Fixtures []struct {
			Name, Document, JSON string
			Accept               bool
			Hash                 string `json:"canonical_sha256"`
			Business             string `json:"business_json"`
			BusinessHash         string `json:"business_sha256"`
			TranscriptHash       string `json:"transcript_sha256"`
		}
	}
	if json.Unmarshal(data, &matrix) != nil || matrix.Owner != "pnpm protocol:generate" || matrix.Document != "local-agent-result-rpc" || matrix.Version != 5 || len(matrix.Fixtures) < 60 || protocol.ProtocolHead() != "bfb-wire/1" {
		t.Fatal("invalid result fixture catalog")
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
			again := protocol.DecodeWireDocument(fixture.Document, []byte(decoded.JSON))
			if !again.OK || again.JSON != decoded.JSON {
				t.Fatal("canonical re-encoding changed optional presence", again.Error)
			}
			var target any
			switch fixture.Document {
			case "agent-result-request":
				target = &generated.AgentResultRequest{}
			case "agent-result-local-request":
				target = &generated.AgentResultLocalRequest{}
			case "agent-result-result":
				target = &generated.AgentResultResult{}
			case "agent-result-confirmation-request":
				target = &generated.AgentResultConfirmationRequest{}
			case "agent-result-confirmation-result":
				target = &generated.AgentResultConfirmationResult{}
			case "agent-result-capture":
				target = &generated.AgentResultCapture{}
			case "agent-result-replay-request":
				target = &generated.AgentResultReplayRequest{}
			case "agent-result-receipt":
				target = &generated.AgentResultReceipt{}
			case "local-agent-result-rpc":
				target = &generated.LocalAgentResultRpcEnvelope{}
			}
			if target == nil || json.Unmarshal([]byte(decoded.JSON), target) != nil {
				t.Fatal("generated type cannot consume accepted fixture")
			}
			encoded, err := json.Marshal(target)
			if err != nil {
				t.Fatal(err)
			}
			typed := protocol.DecodeWireDocument(fixture.Document, encoded)
			if !typed.OK || typed.JSON != decoded.JSON {
				t.Fatal("generated type lost null or optional presence", typed.Error)
			}
			if fixture.Business != "" {
				business, err := protocol.CanonicalAgentWriteRequest("result.submit", []byte(fixture.JSON))
				if err != nil || business != fixture.Business || fmt.Sprintf("%x", sha256.Sum256([]byte(business))) != fixture.BusinessHash {
					t.Fatal("original business bytes changed", err)
				}
			}
			if fixture.TranscriptHash != "" {
				delete(decoded.Value, "signature")
				unsigned, _ := json.Marshal(decoded.Value)
				canonical, err := protocol.NormalizeJSON(unsigned)
				if err != nil || fmt.Sprintf("%x", sha256.Sum256([]byte("BFB-AGENT-RESULT-CAPTURE-V1\n"+canonical+"\n"))) != fixture.TranscriptHash {
					t.Fatal("result capture transcript mismatch", err)
				}
			}
		})
	}
}
