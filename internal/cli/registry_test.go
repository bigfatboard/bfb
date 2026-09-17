// ABOUTME: Tests stable CLI dispatch, JSON envelopes and leaf-handler errors.
// ABOUTME: Verifies unavailable features fail visibly without leaking local arguments or paths.

package cli

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
)

func TestBuiltinDispatchAndExitCodes(t *testing.T) {
	registry := NewRegistry()
	RegisterDaemon(registry, nil)
	for _, fixture := range []struct {
		args []string
		exit int
		code string
	}{
		{[]string{"--json"}, 0, ""},
		{[]string{"--json", "hook", "ingest"}, 4, "not_implemented"},
		{[]string{"--json", "__launch", "synthetic-token"}, 2, "unknown_method"},
		{[]string{"--json", "unknown", "synthetic-private"}, 2, "unknown_method"},
		{[]string{"--json", "daemon", "status", "unexpected"}, 2, "invalid_request"},
		{[]string{"--json", "daemon", "logs", "--lines", "201"}, 2, "invalid_request"},
		{[]string{"--json", "--data-dir", "/", "daemon", "status"}, 3, "unsafe_state"},
	} {
		var output bytes.Buffer
		exit := registry.Execute(context.Background(), fixture.args, strings.NewReader(""), &output)
		if exit != fixture.exit {
			t.Fatalf("%v: exit %d, %s", fixture.args, exit, output.String())
		}
		decoded := protocol.DecodeWireDocument("local-rpc", output.Bytes())
		if !decoded.OK {
			t.Fatalf("invalid CLI envelope: %s", output.String())
		}
		if fixture.code != "" && !strings.Contains(output.String(), fixture.code) {
			t.Fatal("missing diagnostic", output.String())
		}
		if strings.Contains(output.String(), "synthetic") {
			t.Fatal("private argument leaked")
		}
	}
}

func TestMCPStdioKeepsStdoutPureWithoutEnv(t *testing.T) {
	registry := NewRegistry()
	RegisterDaemon(registry, nil)
	RegisterMCP(registry)
	var output bytes.Buffer
	// No BFB_* environment: startup refuses before serving, stdout stays empty.
	exit := registry.Execute(context.Background(), []string{"mcp", "stdio"}, strings.NewReader(""), &output)
	if exit != 2 {
		t.Fatalf("exit %d, output %q", exit, output.String())
	}
	if output.Len() != 0 {
		t.Fatalf("raw stdio wrote to stdout: %q", output.String())
	}
}

func TestLeafRegistrationAndHelp(t *testing.T) {
	registry := NewRegistry()
	called := false
	command := Command{Path: "fixture show", Method: "fixture.show", Summary: "Show fixture", Run: func(_ context.Context, in Invocation) (map[string]any, error) {
		called = len(in.Args) == 1 && in.Args[0] == "value"
		return map[string]any{"status": "running"}, nil
	}}
	if registry.Register(command) != nil || registry.Register(command) == nil {
		t.Fatal("duplicate command accepted")
	}
	var output bytes.Buffer
	if exit := registry.Execute(context.Background(), []string{"fixture", "show", "value", "--json"}, nil, &output); exit != 0 || !called {
		t.Fatal("leaf dispatch failed", output.String())
	}
	output.Reset()
	if exit := registry.Execute(context.Background(), nil, nil, &output); exit != 0 || !strings.Contains(output.String(), "fixture show") {
		t.Fatal("help failed")
	}
	for _, code := range []struct {
		code string
		exit int
	}{{"peer_denied", 3}, {"daemon_offline", 4}, {"storage_failed", 5}, {"already_running", 6}} {
		if got := daemon.ExitCode(&daemon.Failure{Code: code.code}); got != code.exit {
			t.Fatalf("exit %s: %d", code.code, got)
		}
	}
}

func TestLeafCannotLeakUncontractedPayload(t *testing.T) {
	registry := NewRegistry()
	if err := registry.Register(Command{Path: "fixture leak", Method: "fixture.leak", Run: func(context.Context, Invocation) (map[string]any, error) {
		return map[string]any{"private_content": "synthetic-secret"}, nil
	}}); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if exit := registry.Execute(context.Background(), []string{"--json", "fixture", "leak"}, nil, &output); exit != 5 {
		t.Fatalf("unvalidated output: %d", exit)
	}
	if strings.Contains(output.String(), "synthetic-secret") || !protocol.DecodeWireDocument("local-rpc", output.Bytes()).OK {
		t.Fatal("unsafe output envelope")
	}
}
