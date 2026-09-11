// ABOUTME: Exercises checkout CLI and RPC over the real same-user daemon socket.
// ABOUTME: Checks semantic request rejection, canonical responses and diagnostic path redaction.

package checkout

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qdis/bfb/internal/cli"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

func TestCheckoutCLIAndRPCStaySanitized(t *testing.T) {
	ctx := context.Background()
	paths := fixturePaths(t)
	methods := daemon.NewRegistry()
	must(t, RegisterRPC(methods))
	server, err := daemon.Start(ctx, paths, methods)
	must(t, err)
	defer server.Close()
	commands := cli.NewRegistry()
	cli.RegisterCheckout(commands)
	run := func(exit int, args ...string) generated.LocalRpcEnvelope {
		t.Helper()
		var output bytes.Buffer
		got := commands.Execute(ctx, append([]string{"--json", "--data-dir", paths.Root}, args...), nil, &output)
		if got != exit {
			t.Fatalf("CLI exit %d wanted %d: %s", got, exit, output.String())
		}
		if !protocol.DecodeWireDocument("local-rpc", output.Bytes()).OK {
			t.Fatal("noncanonical CLI response")
		}
		var result generated.LocalRpcEnvelope
		must(t, json.Unmarshal(output.Bytes(), &result))
		assertSanitized(t, result, paths.Root)
		return result
	}
	root := fixtureRepository(t, true)
	result := run(0, "checkout", "link", "--workspace", workspaceID, "--runner", runnerID, "--project", projectID, "--repository", "github.com/qdis/bfb", "--label", "CLI fixture", "--default", root)
	assertSanitized(t, result, root)
	summary := result.Payload["checkout"].(map[string]any)
	id := summary["checkout_id"].(string)
	if summary["is_default"] != true {
		t.Fatal("CLI lost default option")
	}
	run(0, "checkout", "verify", id)
	page := run(0, "checkout", "list", "--workspace", workspaceID, "--limit", "1")
	if len(page.Payload["checkouts"].([]any)) != 1 {
		t.Fatal("CLI list lost registration")
	}
	run(2, "checkout", "link", "--unknown", root)
	run(2, "checkout", "verify")
	run(2, "checkout", "list", "--limit", "26")
	for _, input := range []struct {
		method  string
		payload map[string]any
	}{
		{"checkout.link", map[string]any{"label": "incomplete"}},
		{"checkout.list", map[string]any{"is_default": true}},
		{"checkout.verify", map[string]any{"checkout_id": id, "limit": 1}},
		{"checkout.unlink", map[string]any{}},
		{"checkout.list", map[string]any{"local_path": root}},
	} {
		_, err = daemon.Call(ctx, paths, input.method, input.payload)
		requireFailure(t, err, "invalid_request")
	}
	must(t, os.Rename(root, root+"-moved"))
	blocked := run(4, "checkout", "verify", id)
	if blocked.Error == nil || blocked.Error.Code != "checkout_path_missing" {
		t.Fatal("typed block reason lost")
	}
	listed := run(0, "checkout", "list")
	assertSanitized(t, listed, root)
	if listed.Payload["checkouts"].([]any)[0].(map[string]any)["status"] != "blocked" {
		t.Fatal("RPC failed to persist validation failure")
	}
	run(0, "checkout", "unlink", id)
	run(0, "checkout", "unlink", id)
	empty := run(0, "checkout", "list")
	if len(empty.Payload["checkouts"].([]any)) != 0 {
		t.Fatal("unlinked checkout still listed")
	}
	entries, err := os.ReadDir(paths.Logs)
	must(t, err)
	for _, entry := range entries {
		data, err := os.ReadFile(filepath.Join(paths.Logs, entry.Name()))
		must(t, err)
		for _, private := range []string{root, "synthetic-secret", paths.Root} {
			if strings.Contains(string(data), private) {
				t.Fatal("local path or credentials leaked in logs")
			}
		}
	}
}

func TestCheckoutResponseRejectsLocalPath(t *testing.T) {
	response := daemon.Response("checkout.link", daemon.NewRequestID(), map[string]any{"local_path": "/synthetic/private/checkout"}, nil)
	_, err := daemon.EncodeEnvelope(response)
	requireFailure(t, err, "invalid_request")
}
