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
	RegisterExecution(registry, run, run)
	for _, command := range []string{"__launch", "__exec"} {
		for _, arguments := range [][]string{
			nil, {"01K00000000000000000000001"}, {"synthetic-command"},
			{"00000000-0000-4000-8000-000000000001", "synthetic-argv"},
			{"00000000-0000-4000-8000-000000000001\nsynthetic-command"},
		} {
			var output bytes.Buffer
			if code := registry.Execute(context.Background(), append([]string{"--json", command}, arguments...), nil, &output); code != 2 || !strings.Contains(output.String(), "invalid_request") {
				t.Fatalf("%s accepted extra execution authority: %d %s", command, code, output.String())
			}
			if strings.Contains(output.String(), "synthetic-") || strings.Contains(output.String(), "000000000001") {
				t.Fatal("private helper arguments leaked")
			}
		}
	}
	var output bytes.Buffer
	if registry.Execute(context.Background(), nil, nil, &output) != 0 || strings.Contains(output.String(), "__launch") || strings.Contains(output.String(), "__exec") {
		t.Fatal("private commands exposed in public help")
	}
}

func TestExecutionCommandsDispatchOnlyTheirBoundHandler(t *testing.T) {
	registry := NewRegistry()
	intent := "00000000-0000-4000-8000-000000000001"
	seen := ""
	RegisterExecution(registry,
		func(_ context.Context, _ daemon.Paths, id string) error { seen = "launch:" + id; return nil },
		func(_ context.Context, _ daemon.Paths, id string) error { seen = "exec:" + id; return nil })
	for _, name := range []string{"launch", "exec"} {
		var output bytes.Buffer
		if registry.Execute(context.Background(), []string{"--json", "__" + name, intent}, nil, &output) != 0 || seen != name+":"+intent {
			t.Fatal("fixed helper routed to another handler", name)
		}
	}
}
