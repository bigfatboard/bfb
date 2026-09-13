// ABOUTME: Verifies fixed helper dispatch rejects cloud IDs and additional execution arguments before native work.
// ABOUTME: Keeps hidden entry points out of public help and private inputs out of diagnostic responses.

package cli

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/qdis/bfb/internal/daemon"
)

func TestExecutionCommandsRejectUntrustedArguments(t *testing.T) {
	registry := NewRegistry()
	RegisterDaemon(registry, nil)
	run := func(context.Context, daemon.Paths, string) error {
		t.Error("malformed input reached helper")
		return nil
	}
	RegisterExecution(registry, run, run, run)
	for _, command := range []string{"__launch", "__exec", "execution recover"} {
		for _, arguments := range [][]string{
			nil, {"01K00000000000000000000001"}, {"synthetic-command"},
			{"00000000-0000-4000-8000-000000000001", "synthetic-argv"},
			{"00000000-0000-4000-8000-000000000001\nsynthetic-command"},
		} {
			var output bytes.Buffer
			words := append([]string{"--json"}, strings.Fields(command)...)
			if code := registry.Execute(context.Background(), append(words, arguments...), nil, &output); code != 2 || !strings.Contains(output.String(), "invalid_request") {
				t.Fatalf("%s accepted extra execution authority: %d %s", command, code, output.String())
			}
			if strings.Contains(output.String(), "synthetic-") || strings.Contains(output.String(), "000000000001") {
				t.Fatal("private helper arguments leaked")
			}
		}
	}
	var output bytes.Buffer
	if registry.Execute(context.Background(), nil, nil, &output) != 0 || strings.Contains(output.String(), "__launch") || strings.Contains(output.String(), "__exec") || !strings.Contains(output.String(), "execution recover") {
		t.Fatal("public help omitted recovery or exposed private commands")
	}
}

func TestExecutionCommandsDispatchOnlyTheirBoundHandler(t *testing.T) {
	registry := NewRegistry()
	intent := "00000000-0000-4000-8000-000000000001"
	seen := ""
	RegisterExecution(registry,
		func(_ context.Context, _ daemon.Paths, id string) error { seen = "launch:" + id; return nil },
		func(_ context.Context, _ daemon.Paths, id string) error { seen = "exec:" + id; return nil },
		func(_ context.Context, _ daemon.Paths, id string) error { seen = "recover:" + id; return nil })
	for _, name := range []string{"launch", "exec", "recover"} {
		var output bytes.Buffer
		words := []string{"--json", "__" + name, intent}
		if name == "recover" {
			words = []string{"--json", "execution", "recover", intent}
		}
		if registry.Execute(context.Background(), words, nil, &output) != 0 || seen != name+":"+intent {
			t.Fatal("fixed helper routed to another handler", name)
		}
	}
}
