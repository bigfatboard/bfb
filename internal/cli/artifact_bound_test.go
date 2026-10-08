// ABOUTME: Tests credential-free bound artifact CLI parsing and one-line failure framing.
// ABOUTME: Preserves the separate human mode while rejecting mixed scope, secrets and unsafe local paths.

package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestBoundArtifactArgumentsPreserveOptionalAbsence(t *testing.T) {
	args := []string{"--request-id", "artifact-cli-001", "--file", "nested/review.md", "--format", "markdown", "--role", "review"}
	params, id, err := parseBoundArtifactArgs(args)
	if err != nil || id != "artifact-cli-001" || params["path"] != "nested/review.md" || params["format"] != "markdown" {
		t.Fatal("valid bound args rejected", err)
	}
	if _, present := params["artifact_id"]; present {
		t.Fatal("omitted artifact selector substituted")
	}
	for _, extra := range [][]string{
		{"--control-url", "https://control.example.test"}, {"--artifacts-url", "https://artifacts.example.test"}, {"--workspace", "synthetic"}, {"--run-id", "synthetic"},
		{"--cookie-file", "private-canary"}, {"--bearer-file", "private-canary"}, {"--file", "../review.md"}, {"--artifact-id", "invalid"}, {"--request-id", "duplicate-request"}, {"--unknown=x"},
	} {
		if _, _, err := parseBoundArtifactArgs(append(append([]string(nil), args...), extra...)); err == nil {
			t.Fatal("mixed/invalid bound mode accepted", extra)
		}
	}
	params, _, err = parseBoundArtifactArgs([]string{"--request-id=artifact-cli-002", "--file=review.md", "--format=markdown", "--role=review", "--artifact-id=01K6R7DT00AAAAAAAAAAAAAAAA"})
	if err != nil || params["artifact_id"] != "01K6R7DT00AAAAAAAAAAAAAAAA" {
		t.Fatal("explicit selection lost", err)
	}
	if !boundArtifactMode(args) || !boundArtifactMode([]string{"--request-id=x"}) || boundArtifactMode([]string{"--run-id", "x"}) {
		t.Fatal("bound mode selection ambiguous")
	}
}

func TestBoundArtifactMixedInputHasOneRedactedErrorLineAndNoLegacyCall(t *testing.T) {
	seen := map[string]any{}
	registry := NewRegistry()
	RegisterArtifact(registry, stubPublish(seen))
	var output bytes.Buffer
	code := registry.Execute(context.Background(), []string{"artifact", "publish", "--request-id", "artifact-cli-001", "--file", "review.md", "--format", "markdown", "--role", "review", "--bearer-file", "private-canary"}, nil, &output)
	if code != 2 || len(seen) != 0 || strings.Contains(output.String(), "private-canary") || strings.Count(output.String(), "\n") != 1 {
		t.Fatal("bound input leaked or called legacy client", code, output.String())
	}
	var line struct{ Error struct{ Code string } }
	if json.Unmarshal(output.Bytes(), &line) != nil || line.Error.Code != "invalid_request" {
		t.Fatal("closed one-line error missing", output.String())
	}
}
