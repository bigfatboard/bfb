// ABOUTME: Validates the separately versioned root lease observations through the Go wire boundary.
// ABOUTME: Pins canonical generated round trips and denies release, strict-reader and downgrade claims.

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

func TestRootLeaseDocumentFixtures(t *testing.T) {
	root, err := protocol.RepositoryRoot()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "protocol/fixtures/v2/checkout-root-lease-observation.json"))
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
	if matrix.Owner != "pnpm protocol:generate" || matrix.Version != 2 || len(matrix.Fixtures) == 0 {
		t.Fatal("invalid root lease catalog")
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
			var target generated.CheckoutRootLeaseObservation
			if err := json.Unmarshal([]byte(decoded.JSON), &target); err != nil {
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
