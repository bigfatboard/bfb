// ABOUTME: Validates shared telemetry, capability and real acknowledgement fixtures through Go.
// ABOUTME: Pins canonical hashes and nullable generated round trips without widening frozen v1.

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

func TestTelemetryDocumentFixtures(t *testing.T) {
	root, err := protocol.RepositoryRoot()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "protocol/fixtures/v2/runner-telemetry-submission.json"))
	if err != nil {
		t.Fatal(err)
	}
	var matrix struct {
		Owner    string `json:"owner_command"`
		Version  int    `json:"schema_version"`
		Fixtures []struct {
			Name, Document, JSON string
			Accept               bool
			Hash                 string `json:"canonical_sha256"`
		} `json:"fixtures"`
	}
	if err := json.Unmarshal(data, &matrix); err != nil {
		t.Fatal(err)
	}
	if matrix.Owner != "pnpm protocol:generate" || matrix.Version != 2 || len(matrix.Fixtures) == 0 || protocol.ProtocolHead() != "bfb-wire/1" {
		t.Fatal("invalid telemetry catalog")
	}
	for _, fixture := range matrix.Fixtures {
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
			case "runner-telemetry-submission":
				target = &generated.RunnerTelemetrySubmission{}
			case "runner-event-capabilities":
				target = &generated.RunnerEventCapabilities{}
			case "runner-event-ingest-result":
				target = &generated.RunnerEventIngestResult{}
			default:
				t.Fatal("unexpected accepted document")
			}
			if err := json.Unmarshal([]byte(decoded.JSON), target); err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(target)
			if err != nil {
				t.Fatal(err)
			}
			again := protocol.DecodeWireDocument(fixture.Document, encoded)
			if !again.OK || again.JSON != decoded.JSON {
				t.Fatal("generated round trip changed bytes", again.Error)
			}
		})
	}
}
