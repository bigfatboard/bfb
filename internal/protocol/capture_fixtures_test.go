// ABOUTME: Runs the daemon capture contract fixtures through the production Go codec.
// ABOUTME: Verifies required nullable tags, business hash parity and signed transcript bounds.

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

func TestCaptureDocumentFixtures(t *testing.T) {
	root, err := protocol.RepositoryRoot()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "protocol/fixtures/v3/local-agent-work-rpc.json"))
	if err != nil {
		t.Fatal(err)
	}
	var matrix struct {
		Owner    string `json:"owner_command"`
		Document string `json:"document"`
		Version  int    `json:"schema_version"`
		Fixtures []struct {
			Name            string `json:"name"`
			Document        string `json:"document"`
			JSON            string `json:"json"`
			Accept          bool   `json:"accept"`
			CanonicalHash   string `json:"canonical_sha256"`
			Command         string `json:"command_name"`
			OriginalRequest string `json:"original_request_json"`
			BusinessJSON    string `json:"business_json"`
			BusinessHash    string `json:"business_sha256"`
			TranscriptHash  string `json:"transcript_sha256"`
			ErrorCategory   string `json:"error_category"`
		} `json:"fixtures"`
	}
	if err := json.Unmarshal(data, &matrix); err != nil {
		t.Fatal(err)
	}
	if matrix.Document != "local-agent-work-rpc" || matrix.Version != 3 || matrix.Owner != "pnpm protocol:generate" || len(matrix.Fixtures) == 0 {
		t.Fatal("invalid capture fixture catalog")
	}
	if protocol.ProtocolHead() != "bfb-wire/1" {
		t.Fatal("global protocol head changed")
	}
	hash := func(value string) string { return fmt.Sprintf("%x", sha256.Sum256([]byte(value))) }
	seen := make(map[string]bool)
	for _, fixture := range matrix.Fixtures {
		if seen[fixture.Name] {
			t.Fatal("duplicate fixture name", fixture.Name)
		}
		seen[fixture.Name] = true
		t.Run(fixture.Name, func(t *testing.T) {
			result := protocol.DecodeWireDocument(fixture.Document, []byte(fixture.JSON))
			if result.OK != fixture.Accept {
				t.Fatalf("accept=%v got %#v", fixture.Accept, result.Error)
			}
			if !result.OK {
				if fixture.ErrorCategory != "" && result.Error.Category != fixture.ErrorCategory {
					t.Fatalf("category %s != %s", result.Error.Category, fixture.ErrorCategory)
				}
				return
			}
			if hash(result.JSON) != fixture.CanonicalHash {
				t.Fatalf("wire canonical hash mismatch: %s != %s", hash(result.JSON), fixture.CanonicalHash)
			}
			again := protocol.DecodeWireDocument(fixture.Document, []byte(result.JSON))
			if !again.OK || again.JSON != result.JSON {
				t.Fatal("unstable v3 re-encoding", again.Error)
			}
			if fixture.Command != "" {
				business, err := protocol.CanonicalAgentWriteRequest(fixture.Command, []byte(fixture.OriginalRequest))
				if err != nil {
					t.Fatal(err)
				}
				if business != fixture.BusinessJSON || hash(business) != fixture.BusinessHash {
					t.Fatalf("business bytes/hash mismatch: %q != %q", business, fixture.BusinessJSON)
				}
				capture := result.Value["capture"].(map[string]any)
				if capture["operation"].(map[string]any)["payload_hash"] != "sha256:"+fixture.BusinessHash {
					t.Fatal("capture digest does not bind original business bytes")
				}
			}
			if fixture.TranscriptHash != "" {
				capture := result.Value
				if fixture.Document != "agent-work-capture" {
					capture = result.Value["capture"].(map[string]any)
				}
				unsigned := make(map[string]any, len(capture)-1)
				for key, value := range capture {
					if key != "signature" {
						unsigned[key] = value
					}
				}
				encoded, err := json.Marshal(unsigned)
				if err != nil {
					t.Fatal(err)
				}
				canonical, err := protocol.NormalizeJSON(encoded)
				if err != nil {
					t.Fatal(err)
				}
				transcript := "BFB-AGENT-WORK-CAPTURE-V1\n" + canonical + "\n"
				if len(transcript) > 8192 || hash(transcript) != fixture.TranscriptHash {
					t.Fatal("capture transcript mismatch or overflow")
				}
			}
			var target any
			switch fixture.Document {
			case "agent-work-capture":
				target = &generated.AgentWorkCapture{}
			case "agent-work-receipt":
				target = &generated.AgentWorkReceipt{}
			case "agent-work-replay-request":
				target = &generated.AgentWorkReplayRequest{}
			case "agent-capture-confirmation-request":
				target = &generated.AgentCaptureConfirmationRequest{}
			case "agent-capture-confirmation-result":
				target = &generated.AgentCaptureConfirmationResult{}
			case "local-agent-work-rpc":
				target = &generated.LocalAgentWorkRpcEnvelope{}
			}
			if target != nil {
				if err := json.Unmarshal([]byte(result.JSON), target); err != nil {
					t.Fatal(err)
				}
				encoded, err := json.Marshal(target)
				if err != nil {
					t.Fatal(err)
				}
				typed := protocol.DecodeWireDocument(fixture.Document, encoded)
				if !typed.OK || typed.JSON != result.JSON {
					t.Fatal("typed Go fields dropped required nullable or original fields", typed.Error)
				}
			}
		})
	}
}

func TestCanonicalAgentWriteRejectsUnsafeInput(t *testing.T) {
	if _, err := protocol.CanonicalAgentWriteRequest("agent_run.sign", []byte("{}")); err == nil {
		t.Fatal("unknown command accepted")
	}
	if _, err := protocol.CanonicalAgentWriteRequest("agent_run.progress", []byte("{\"reference\":{\"schema_version\":1,\"run_execution_id\":\"01K6R7DT00AAAAAAAAAAAAAAAA\",\"assignment_generation\":1,\"request_id\":\"fixture-request-01\"},\"binding\":{\"provider_session_id\":\"01K6R7DT00BBBBBBBBBBBBBBBB\",\"provider\":\"fake\",\"observed_session_id\":\"synthetic-session\"},\"summary\":\"Synthetic\",\"percent\":100.00000000000000001}")); err == nil {
		t.Fatal("raw rounded progress accepted")
	}
}
