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

func TestAdversarialDifferentialCorpus(t *testing.T) {
	// Mirrors packages/protocol-ts/test/adversarial-parity.test.ts concerns.
	type adversarialCase struct {
		path     string
		schema   string
		category string
		concern  string
	}
	cases := []adversarialCase{
		{"invalid/event-envelope.fractional-cursor.json", "event-envelope", "type_mismatch", "fractional_integer"},
		{"invalid/event-envelope.fractional-schema-version.json", "event-envelope", "type_mismatch", "fractional_integer"},
		{"invalid/event-envelope.cursor-below-min.json", "event-envelope", "bound_exceeded", "bound"},
		{"invalid/event-envelope.unknown-actor-type.json", "event-envelope", "type_mismatch", "enum"},
		{"invalid/event-envelope.missing-actor-type.json", "event-envelope", "missing_field", "required_nested"},
		{"invalid/runner-enrollment.duplicate-project-ids.json", "runner-enrollment", "schema_invalid", "uniqueness"},
		{"invalid/runner-enrollment.unknown-status.json", "runner-enrollment", "type_mismatch", "enum"},
		{"invalid/launch-specification.missing-nested-provider.json", "launch-specification", "missing_field", "required_nested"},
		{"invalid/launch-specification.duplicate-capabilities.json", "launch-specification", "schema_invalid", "uniqueness"},
		{"invalid/launch-specification.unknown-effort.json", "launch-specification", "type_mismatch", "enum"},
		{"invalid/checkout-summary.missing-status.json", "checkout-summary", "missing_field", "required_nested"},
		{"invalid/checkout-summary.unknown-status.json", "checkout-summary", "type_mismatch", "enum"},
		{"invalid/runner-event-submission.missing-capture-origin.json", "runner-event-submission", "missing_field", "required_nested"},
		{"invalid/runner-event-submission.disallowed-kind.json", "runner-event-submission", "unknown_kind", "enum"},
		{"invalid/local-rpc.unknown-direction.json", "local-rpc", "type_mismatch", "enum"},
	}

	root, err := protocol.RepositoryRoot()
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, entry := range cases {
		seen[entry.concern] = true
		entry := entry
		t.Run(entry.concern+"/"+entry.path, func(t *testing.T) {
			input, err := os.ReadFile(protocol.FixturePath(root, entry.path))
			if err != nil {
				t.Fatal(err)
			}
			result := protocol.DecodeWireDocument(entry.schema, input)
			if result.OK {
				t.Fatalf("expected reject for %s", entry.path)
			}
			if result.Error == nil || result.Error.Category != entry.category {
				t.Fatalf("category want %s got %#v", entry.category, result.Error)
			}
		})
	}
	for _, concern := range []string{"fractional_integer", "enum", "bound", "uniqueness", "required_nested"} {
		if !seen[concern] {
			t.Fatalf("missing adversarial concern %s", concern)
		}
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
