// ABOUTME: Exercises artifact publication through the real same-user daemon socket.
// ABOUTME: Synthetic origins prove payload mapping without secrets in diagnostics.

package artifact

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qdis/bfb/internal/daemon"
)

func fixturePaths(t *testing.T) daemon.Paths {
	t.Helper()
	root, err := os.MkdirTemp("/tmp", "bfb-artifact-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	paths, err := daemon.StatePaths(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := paths.Prepare(); err != nil {
		t.Fatal(err)
	}
	return paths
}

func TestDaemonPublishRoundTrip(t *testing.T) {
	ctx := context.Background()
	paths := fixturePaths(t)
	methods := daemon.NewRegistry()
	if err := RegisterRPC(methods); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, method := range methods.Methods() {
		found = found || method == "artifact.publish"
	}
	if !found {
		t.Fatal("artifact.publish is not registered")
	}
	server, err := daemon.Start(ctx, paths, methods)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	fake := &fakeOrigins{secret: "synthetic-grant-secret-0123456789abcdef"}
	control, artifacts := startFakes(t, fake)
	file := filepath.Join(t.TempDir(), "review.md")
	if err := os.WriteFile(file, syntheticContent, 0600); err != nil {
		t.Fatal(err)
	}
	cookieFile := filepath.Join(t.TempDir(), "cookie")
	if err := os.WriteFile(cookieFile, []byte("synthetic-cookie\n"), 0600); err != nil {
		t.Fatal(err)
	}
	secret, err := readSecretForTest(cookieFile)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := daemon.Call(ctx, paths, "artifact.publish", map[string]any{
		"control_url": control.URL, "artifacts_url": artifacts.URL,
		"workspace_id":    testWorkspace,
		"artifact_format": "markdown", "artifact_role": "review",
		"artifact_path": file, "artifact_cookie": secret,
	})
	if err != nil {
		t.Fatal(err)
	}
	if envelope.Payload["version_id"] != testVersion {
		t.Fatalf("bad daemon result: %v", envelope.Payload)
	}
	if strings.Contains(envelope.Payload["r2_key"].(string), testWorkspace) == false {
		t.Fatalf("r2 key lost workspace prefix: %v", envelope.Payload)
	}
}

func TestDaemonPublishRejectsUnknownFields(t *testing.T) {
	ctx := context.Background()
	paths := fixturePaths(t)
	methods := daemon.NewRegistry()
	if err := RegisterRPC(methods); err != nil {
		t.Fatal(err)
	}
	server, err := daemon.Start(ctx, paths, methods)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	_, err = daemon.Call(ctx, paths, "artifact.publish", map[string]any{
		"control_url": "http://127.0.0.1:1", "artifacts_url": "http://127.0.0.1:1",
		"workspace_id": "w", "artifact_format": "markdown", "artifact_role": "review",
		"artifact_path": t.TempDir(), "r2_key": "evil",
	})
	if err == nil {
		t.Fatal("unknown field reached publication")
	}
	if failure, ok := err.(*daemon.Failure); !ok || failure.Code != "invalid_request" {
		t.Fatalf("untyped daemon error: %v", err)
	}
}

func readSecretForTest(path string) (string, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(content)), nil
}
