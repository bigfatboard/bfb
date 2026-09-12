// ABOUTME: Verifies that named Go launch configuration survives shared-schema references and JSON decoding.
// ABOUTME: A missing generated field must fail protocol acceptance before a provider silently loses its policy.

package protocol_test

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

func TestLaunchConfigurationTypedRoundTrip(t *testing.T) {
	root, err := protocol.RepositoryRoot()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(protocol.FixturePath(root, "valid/launch-specification.c09-synthetic.json"))
	if err != nil {
		t.Fatal(err)
	}
	var specification generated.LaunchSpecification
	if err := json.Unmarshal(data, &specification); err != nil {
		t.Fatal(err)
	}
	config := specification.ExecutionConfig
	if config.Provider != "fake" || config.Model != "synthetic" || config.Mode != "interactive" || config.FilesystemPolicy != "read_only" || config.ApprovalPolicy != "never" || len(config.RequiredCapabilities) == 0 {
		t.Fatal("typed launch lost its adapter or restrictive policy")
	}
	roundTrip, err := json.Marshal(specification)
	if err != nil {
		t.Fatal(err)
	}
	want, got := protocol.DecodeWireDocument("launch-specification", data), protocol.DecodeWireDocument("launch-specification", roundTrip)
	if !want.OK || !got.OK || want.JSON != got.JSON {
		t.Fatal("typed launch did not retain its entire wire configuration")
	}
}
