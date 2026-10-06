// ABOUTME: Exercises the shared autonomous permission fixtures through current and old-enum Go readers.
// ABOUTME: Keeps manual compatibility and typed full-access round trips distinct from provider certification.

package protocol_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
	jsonschema "github.com/santhosh-tekuri/jsonschema/v6"
)

func TestAutonomousPermissionFixtures(t *testing.T) {
	root, err := protocol.RepositoryRoot()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "protocol/fixtures/v1/claude-autonomy.json"))
	if err != nil {
		t.Fatal(err)
	}
	var matrix struct {
		Owner    string `json:"owner_command"`
		Fixtures []struct {
			Name, Document, JSON string
			Accept               bool
			LegacyAccept         bool `json:"legacy_accept"`
		} `json:"fixtures"`
	}
	if err := json.Unmarshal(data, &matrix); err != nil {
		t.Fatal(err)
	}
	if matrix.Owner != "pnpm protocol:generate" || len(matrix.Fixtures) != 6 {
		t.Fatal("invalid autonomy fixture owner")
	}
	legacy := jsonschema.NewCompiler()
	legacy.DefaultDraft(jsonschema.Draft2020)
	legacy.AssertFormat()
	additions := regexp.MustCompile(`,\s*"(?:full_access|filesystem\.full_access)"`)
	for _, id := range generated.SchemaResourceIDs {
		source := additions.ReplaceAllString(generated.SchemaResources[id], "")
		var schema any
		if err := json.Unmarshal([]byte(source), &schema); err != nil {
			t.Fatal(err)
		}
		if err := legacy.AddResource(id, schema); err != nil {
			t.Fatal(err)
		}
	}
	for _, fixture := range matrix.Fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			current := protocol.DecodeWireDocument(fixture.Document, []byte(fixture.JSON))
			if current.OK != fixture.Accept {
				t.Fatal("current reader acceptance mismatch", current.Error)
			}
			oldReader, err := legacy.Compile(generated.SchemaIDByDocument[fixture.Document])
			if err != nil {
				t.Fatal(err)
			}
			var value any
			if err := json.Unmarshal([]byte(fixture.JSON), &value); err != nil {
				t.Fatal(err)
			}
			if (oldReader.Validate(value) == nil) != fixture.LegacyAccept {
				t.Fatal("old reader accepted new permission vocabulary")
			}
			if !current.OK {
				return
			}
			var target any = &generated.RunnerInventory{}
			if fixture.Document == "launch-specification" {
				target = &generated.LaunchSpecification{}
			}
			if err := json.Unmarshal([]byte(current.JSON), target); err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(target)
			if err != nil {
				t.Fatal(err)
			}
			again := protocol.DecodeWireDocument(fixture.Document, encoded)
			if !again.OK || again.JSON != current.JSON {
				t.Fatal("typed permission round trip changed", again.Error)
			}
		})
	}
}
