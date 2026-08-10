// ABOUTME: Runs the shared golden fixture matrix through the Go wire codec.
// ABOUTME: Requires the same accept/reject diagnostic categories as TypeScript.

package protocol_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/qdis/bfb/internal/protocol"
)

type matrixEntry struct {
	Path     string  `json:"path"`
	Schema   string  `json:"schema"`
	Expect   string  `json:"expect"`
	Category *string `json:"category"`
}

type matrix struct {
	Fixtures []matrixEntry `json:"fixtures"`
}

func TestFixtureMatrix(t *testing.T) {
	root, err := protocol.RepositoryRoot()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := protocol.LoadFixtureMatrix(root)
	if err != nil {
		t.Fatal(err)
	}
	var m matrix
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if len(m.Fixtures) == 0 {
		t.Fatal("fixture matrix is empty")
	}

	for _, entry := range m.Fixtures {
		entry := entry
		t.Run(entry.Path, func(t *testing.T) {
			input, err := os.ReadFile(protocol.FixturePath(root, entry.Path))
			if err != nil {
				t.Fatal(err)
			}
			result := protocol.DecodeWireDocument(entry.Schema, input)
			if entry.Expect == "accept" {
				if !result.OK {
					t.Fatalf("expected accept, got %#v", result.Error)
				}
				again := protocol.DecodeWireDocument(entry.Schema, []byte(result.JSON))
				if !again.OK {
					t.Fatalf("re-encode decode failed: %#v", again.Error)
				}
				if again.JSON != result.JSON {
					t.Fatalf("stable re-encode mismatch")
				}
				return
			}
			if result.OK {
				t.Fatalf("expected reject")
			}
			if entry.Category == nil {
				t.Fatal("reject fixture missing category")
			}
			if result.Error == nil || result.Error.Category != *entry.Category {
				t.Fatalf("category want %s got %#v", *entry.Category, result.Error)
			}
		})
	}
}

func TestGeneratedCatalogNonEmpty(t *testing.T) {
	if protocol.ProtocolHead() != "bfb-wire/1" {
		t.Fatalf("unexpected protocol head %s", protocol.ProtocolHead())
	}
	if len(protocol.DocumentNames()) < 10 {
		t.Fatalf("expected generated document names, got %v", protocol.DocumentNames())
	}
	// Ensure generated package file exists for Swift/hand-off consumers.
	root, err := protocol.RepositoryRoot()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "internal/protocol/generated/types.go")); err != nil {
		t.Fatal(err)
	}
}
