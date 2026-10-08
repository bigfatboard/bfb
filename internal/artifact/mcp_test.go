// ABOUTME: Verifies the run-scoped MCP tool definition and argument handling.
// ABOUTME: Synthetic servers prove the A01 seam without any MCP transport.

package artifact

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestToolDefinitionIsStable(t *testing.T) {
	definition := ToolDefinition()
	if definition["name"] != ToolName || ToolName != "bfb_publish_artifact" {
		t.Fatalf("tool name changed: %v", definition["name"])
	}
	encoded, err := json.Marshal(definition)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		InputSchema struct {
			Type                 string   `json:"type"`
			Required             []string `json:"required"`
			AdditionalProperties bool     `json:"additionalProperties"`
			Properties           map[string]struct {
				Enum []string `json:"enum"`
			} `json:"properties"`
		} `json:"inputSchema"`
	}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.InputSchema.Type != "object" || decoded.InputSchema.AdditionalProperties {
		t.Fatal("tool schema is not a closed object")
	}
	for _, field := range []string{"workspace_id", "format", "role", "path"} {
		found := false
		for _, required := range decoded.InputSchema.Required {
			found = found || required == field
		}
		if !found {
			t.Fatalf("required field %s missing", field)
		}
	}
	if len(decoded.InputSchema.Properties["format"].Enum) != 9 {
		t.Fatal("format enum changed without a contract update")
	}
}

func toolArguments(workspace, path string) []byte {
	encoded, err := json.Marshal(map[string]any{
		"workspace_id": workspace, "format": "markdown", "role": "review", "path": path,
	})
	if err != nil {
		panic("synthetic tool arguments are invalid")
	}
	return encoded
}

func TestInvokePublishRejectsUnknownFields(t *testing.T) {
	client := &Client{}
	evil := map[string]any{
		"workspace_id": "w", "format": "markdown", "role": "review", "path": "p",
		"r2_key": "evil",
	}
	encoded, err := json.Marshal(evil)
	if err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]byte{
		encoded,
		[]byte(`{"workspace_id":"w","format":"markdown","role":"review"}`),
		[]byte(`{"workspace_id":"w","format":"exe","role":"review","path":"p"}`),
		[]byte(`not json`),
	} {
		if _, err := client.InvokePublish(context.Background(), args); err == nil {
			t.Fatalf("bad tool args accepted: %s", args)
		} else if failure, ok := err.(*Error); !ok || failure.Code != "invalid_request" {
			t.Fatalf("untyped tool error for %s: %v", args, err)
		}
	}
}

func TestInvokePublishesFile(t *testing.T) {
	fake := &fakeOrigins{secret: "synthetic-grant-secret-0123456789abcdef"}
	control, artifacts := startFakes(t, fake)
	path := filepath.Join(t.TempDir(), "review.md")
	if err := os.WriteFile(path, syntheticContent, 0600); err != nil {
		t.Fatal(err)
	}
	encoded, err := testClient(control, artifacts, fake).InvokePublish(
		context.Background(), toolArguments(testWorkspace, path),
	)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["content_hash"] != syntheticDigest() || decoded["version_id"] != testVersion {
		t.Fatalf("bad tool result: %s", encoded)
	}
	if strings.Contains(string(encoded), fake.secret) {
		t.Fatal("grant secret leaked into the tool result")
	}
}

func TestInvokePublishSurfacesRejection(t *testing.T) {
	fake := &fakeOrigins{secret: "s", createStatus: http.StatusForbidden}
	control, artifacts := startFakes(t, fake)
	path := filepath.Join(t.TempDir(), "review.md")
	if err := os.WriteFile(path, syntheticContent, 0600); err != nil {
		t.Fatal(err)
	}
	_, err := testClient(control, artifacts, fake).InvokePublish(
		context.Background(), toolArguments(testWorkspace, path),
	)
	failure, ok := err.(*Error)
	if !ok || failure.Code != "request_rejected" {
		t.Fatalf("bad tool mapping: %v", err)
	}
}

func quote(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
