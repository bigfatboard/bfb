// ABOUTME: Verifies artifact CLI flag mapping and file-based credential handling.
// ABOUTME: A stubbed daemon call proves secrets never travel in process arguments.

package cli

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
)

func stubPublish(seen map[string]any) PublishFunc {
	return func(_ context.Context, _ daemon.Paths, method string, payload map[string]any) (generated.LocalRpcEnvelope, error) {
		if method != "artifact.publish" {
			return generated.LocalRpcEnvelope{}, &daemon.Failure{Code: "unknown_method"}
		}
		for key, value := range payload {
			seen[key] = value
		}
		return daemon.Response("artifact.publish", daemon.NewRequestID(), map[string]any{
			"artifact_id":   "01JBFB0ART1FACT01000000000",
			"version_id":    "01JBFB0VERS10N010000000000",
			"content_hash":  "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
			"artifact_size": 18,
			"r2_key":        "workspaces/01JBFB0W0RKSPACE0000000000/artifacts/sha256/synthetic",
		}, nil), nil
	}
}

func TestArtifactPublishMapsFlags(t *testing.T) {
	registry := NewRegistry()
	seen := map[string]any{}
	RegisterArtifact(registry, stubPublish(seen))
	cookieFile := filepath.Join(t.TempDir(), "cookie")
	if err := os.WriteFile(cookieFile, []byte("synthetic-cookie\n"), 0600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	code := registry.Execute(context.Background(), []string{
		"--json", "artifact", "publish",
		"--control-url", "https://bfb.example.test",
		"--artifacts-url", "https://artifacts.bfb.example.test",
		"--workspace", "workspace-synthetic",
		"--format", "markdown", "--role", "review",
		"--file", cookieFile,
		"--cookie-file", cookieFile,
	}, nil, &output)
	if code != 0 {
		t.Fatalf("publish failed: %d %s", code, output.String())
	}
	for key, value := range map[string]any{
		"control_url":     "https://bfb.example.test",
		"workspace_id":    "workspace-synthetic",
		"artifact_format": "markdown",
		"artifact_role":   "review",
		"artifact_cookie": "synthetic-cookie",
	} {
		if seen[key] != value {
			t.Fatalf("payload %s = %v", key, seen[key])
		}
	}
	if _, ok := seen["artifact_bearer"]; ok {
		t.Fatal("unset bearer leaked into the payload")
	}
}

func TestArtifactPublishRejectsBadInput(t *testing.T) {
	registry := NewRegistry()
	RegisterArtifact(registry, stubPublish(map[string]any{}))
	base := []string{
		"artifact", "publish",
		"--control-url", "https://bfb.example.test",
		"--artifacts-url", "https://artifacts.bfb.example.test",
		"--workspace", "workspace-synthetic",
		"--format", "markdown", "--role", "review",
		"--file", "review.md",
	}
	for _, args := range [][]string{
		{"artifact", "publish"},
		append(append([]string{}, base...), "--cookie", "inline-secret"),
		append(append([]string{}, base...), "--bearer", "inline-secret"),
		append(append([]string{}, base...), "--cookie-file", filepath.Join(t.TempDir(), "missing")),
		{"artifact", "publish", "--format", "markdown"},
	} {
		var output bytes.Buffer
		if code := registry.Execute(context.Background(), args, nil, &output); code != 2 {
			t.Fatalf("%v exited %d, not 2: %s", args, code, output.String())
		}
		if strings.Contains(output.String(), "inline-secret") {
			t.Fatal("credential echoed into CLI output")
		}
	}
}
