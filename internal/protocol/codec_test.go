// ABOUTME: Runs the shared golden fixture matrix through the Go wire codec.
// ABOUTME: Requires the same accept/reject diagnostic categories as TypeScript.

package protocol_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
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
	Protocol      string        `json:"protocol"`
	SchemaVersion int           `json:"schema_version"`
	Fixtures      []matrixEntry `json:"fixtures"`
}

type fixtureOutcome struct {
	OK       bool   `json:"ok"`
	JSON     string `json:"json"`
	Category string `json:"category"`
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
	if m.Protocol != "bfb-wire/1" || m.SchemaVersion != 1 {
		t.Fatalf("unexpected matrix head %q/%d", m.Protocol, m.SchemaVersion)
	}

	listed := make([]string, 0, len(m.Fixtures))
	seen := make(map[string]bool, len(m.Fixtures))
	goOutcomes := make(map[string]fixtureOutcome, len(m.Fixtures))
	for _, entry := range m.Fixtures {
		if seen[entry.Path] {
			t.Fatalf("duplicate matrix fixture %s", entry.Path)
		}
		seen[entry.Path] = true
		listed = append(listed, entry.Path)
	}
	var onDisk []string
	for _, directory := range []string{"valid", "invalid"} {
		entries, err := os.ReadDir(filepath.Join(root, "protocol", "fixtures", "v1", directory))
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			if !entry.IsDir() && filepath.Ext(entry.Name()) == ".json" {
				onDisk = append(onDisk, directory+"/"+entry.Name())
			}
		}
	}
	sort.Strings(listed)
	sort.Strings(onDisk)
	if len(listed) != len(onDisk) {
		t.Fatalf("matrix lists %d fixtures, disk has %d", len(listed), len(onDisk))
	}
	for i := range listed {
		if listed[i] != onDisk[i] {
			t.Fatalf("matrix inventory mismatch at %d: %q != %q", i, listed[i], onDisk[i])
		}
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
				goOutcomes[entry.Path] = fixtureOutcome{OK: true, JSON: result.JSON}
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
			diagnosticJSON, err := json.Marshal(result.Error)
			if err != nil {
				t.Fatal(err)
			}
			diagnostic := protocol.DecodeWireDocument("typed-error", diagnosticJSON)
			if !diagnostic.OK {
				t.Fatalf("codec returned a non-canonical diagnostic: %#v", diagnostic.Error)
			}
			goOutcomes[entry.Path] = fixtureOutcome{OK: false, Category: result.Error.Category}
		})
	}

	tsx := filepath.Join(root, "node_modules", ".bin", "tsx")
	command := exec.Command(tsx, "packages/protocol-ts/test/canonical-fixtures.ts")
	command.Dir = root
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("TypeScript differential runner failed: %v\n%s", err, output)
	}
	var typeScriptOutcomes map[string]fixtureOutcome
	if err := json.Unmarshal(output, &typeScriptOutcomes); err != nil {
		t.Fatalf("decode TypeScript differential output: %v\n%s", err, output)
	}
	if len(typeScriptOutcomes) != len(goOutcomes) {
		t.Fatalf("differential outcome count: TypeScript %d Go %d", len(typeScriptOutcomes), len(goOutcomes))
	}
	for fixture, goOutcome := range goOutcomes {
		typeScriptOutcome, exists := typeScriptOutcomes[fixture]
		if !exists {
			t.Fatalf("TypeScript outcome missing %s", fixture)
		}
		if typeScriptOutcome != goOutcome {
			t.Fatalf("differential mismatch for %s: TypeScript %#v Go %#v", fixture, typeScriptOutcome, goOutcome)
		}
	}
}

func TestRejectsMalformedUTF8AndByteOrderMark(t *testing.T) {
	malformed := protocol.DecodeWireDocument("event-envelope", []byte{'{', '"', 0xff})
	if malformed.OK || malformed.Error == nil || malformed.Error.Code != "invalid_unicode" {
		t.Fatalf("unexpected malformed UTF-8 result %#v", malformed.Error)
	}

	root, err := protocol.RepositoryRoot()
	if err != nil {
		t.Fatal(err)
	}
	valid, err := os.ReadFile(protocol.FixturePath(root, "valid/event-envelope.heartbeat.json"))
	if err != nil {
		t.Fatal(err)
	}
	withBOM := append([]byte{0xef, 0xbb, 0xbf}, valid...)
	bom := protocol.DecodeWireDocument("event-envelope", withBOM)
	if bom.OK || bom.Error == nil || bom.Error.Code != "json_parse_failed" {
		t.Fatalf("unexpected BOM result %#v", bom.Error)
	}
}

func TestRejectsWireDocumentAboveByteBound(t *testing.T) {
	result := protocol.DecodeWireDocument("event-envelope", make([]byte, 1_048_577))
	if result.OK || result.Error == nil || result.Error.Category != "bound_exceeded" || result.Error.Code != "max_bytes" {
		t.Fatalf("unexpected oversized wire result %#v", result.Error)
	}
}

func TestBoundsStructuralWorkBeforeSchemaValidation(t *testing.T) {
	var object bytes.Buffer
	object.WriteByte('{')
	for index := 0; index < 4_097; index++ {
		if index > 0 {
			object.WriteByte(',')
		}
		fmt.Fprintf(&object, "%q:%d", fmt.Sprintf("k%d", index), index)
	}
	object.WriteByte('}')
	result := protocol.DecodeWireDocument("event-envelope", object.Bytes())
	if result.OK || result.Error == nil || result.Error.Category != "bound_exceeded" || result.Error.Code != "max_items" {
		t.Fatalf("unexpected structural bound result %#v", result.Error)
	}

	object.Truncate(object.Len() - 1)
	object.WriteString(",\"surrogate\":\"\\uD800\"}")
	unicodeResult := protocol.DecodeWireDocument("event-envelope", object.Bytes())
	if unicodeResult.OK || unicodeResult.Error == nil || unicodeResult.Error.Category != "schema_invalid" || unicodeResult.Error.Code != "invalid_unicode" {
		t.Fatalf("unexpected hostile Unicode result %#v", unicodeResult.Error)
	}

	numericArray := []byte("[" + strings.Repeat("0,", 100_000) + "0]")
	arrayResult := protocol.DecodeWireDocument("event-envelope", numericArray)
	if arrayResult.OK || arrayResult.Error == nil || arrayResult.Error.Category != "type_mismatch" {
		t.Fatalf("unexpected root array result %#v", arrayResult.Error)
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

func TestDiagnosticPathsAreEscapedAndBounded(t *testing.T) {
	root, err := protocol.RepositoryRoot()
	if err != nil {
		t.Fatal(err)
	}
	input, err := os.ReadFile(protocol.FixturePath(root, "valid/event-envelope.heartbeat.json"))
	if err != nil {
		t.Fatal(err)
	}
	var object map[string]any
	if err := json.Unmarshal(input, &object); err != nil {
		t.Fatal(err)
	}

	object["a/b~c"] = true
	escapedInput, err := json.Marshal(object)
	if err != nil {
		t.Fatal(err)
	}
	escaped := protocol.DecodeWireDocument("event-envelope", escapedInput)
	if escaped.OK || escaped.Error == nil || escaped.Error.Path == nil || *escaped.Error.Path != "/a~1b~0c" {
		t.Fatalf("unexpected escaped diagnostic %#v", escaped.Error)
	}

	delete(object, "a/b~c")
	object[strings.Repeat("x", 300)] = true
	boundedInput, err := json.Marshal(object)
	if err != nil {
		t.Fatal(err)
	}
	bounded := protocol.DecodeWireDocument("event-envelope", boundedInput)
	if bounded.OK || bounded.Error == nil || bounded.Error.Path != nil {
		t.Fatalf("unexpected bounded diagnostic %#v", bounded.Error)
	}
}
