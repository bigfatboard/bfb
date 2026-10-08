// ABOUTME: Checks Claude hook stdout bootstrap only after a trusted durable local receipt.
// ABOUTME: Uses isolated SQLite assignments and synthetic hook inputs without provider turns.

package cli_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/cli"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/journal"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers/claude"
)

type claudeHookAssignment struct{ value journal.Assignment }

var claudeHookBindingKeys = []string{
	"BFB_WORKSPACE_ID", "BFB_PROJECT_ID", "BFB_TASK_ID", "BFB_RUN_ID",
	"BFB_RUN_EXECUTION_ID", "BFB_ASSIGNMENT_GENERATION", "BFB_CHECKOUT_ID",
	"BFB_CORRELATION_TOKEN", "BFB_ARTIFACTS_DIR",
}

func clearClaudeHookBinding(t *testing.T) {
	t.Helper()
	for _, key := range claudeHookBindingKeys {
		t.Setenv(key, "")
		if err := os.Unsetenv(key); err != nil {
			t.Fatal(err)
		}
	}
}

type unreadClaudeHookInput struct {
	reader io.Reader
	reads  int
}

func (input *unreadClaudeHookInput) Read(data []byte) (int, error) {
	input.reads++
	return input.reader.Read(data)
}

func TestUnscopedClaudeHookIsSilentWithoutReadingOrOpeningState(t *testing.T) {
	clearClaudeHookBinding(t)
	root, err := os.MkdirTemp("/tmp", "bfb-unscoped-hook-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	t.Setenv("HOME", filepath.Join(root, "outside-home"))
	t.Setenv("PATH", filepath.Join(root, "missing-provider"))
	t.Setenv("BFB_CLAUDE_HOME", filepath.Join(root, "different-profile"))
	providers, err := provider.NewRegistry([]provider.Descriptor{claude.Descriptor()})
	if err != nil {
		t.Fatal(err)
	}
	registry := cli.NewRegistry()
	cli.RegisterHook(registry, providers, func(*sql.DB) (journal.Assignments, journal.Observers) {
		t.Fatal("unscoped hook resolved a journal backend")
		return nil, nil
	})
	for _, raw := range []string{"", "{malformed", strings.Repeat("x", provider.MaxHookBytes+1), `{"hook_event_name":"PreToolUse","tool_name":"Write"}`, `{"hook_event_name":"SessionStart"}`} {
		input := &unreadClaudeHookInput{reader: strings.NewReader(raw)}
		var output, diagnostics bytes.Buffer
		exit := registry.ExecuteWithStderr(context.Background(), []string{"hook", "ingest", "--provider", "claude"}, input, &output, &diagnostics)
		if exit != 0 || output.Len() != 0 || diagnostics.Len() != 0 || input.reads != 0 {
			t.Fatalf("unscoped hook did work: exit=%d stdout=%q stderr=%q reads=%d", exit, output.String(), diagnostics.String(), input.reads)
		}
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatal("unscoped hook created local state", entries, err)
	}
}

func TestClaudeHookPartialBindingNeverBecomesUnscoped(t *testing.T) {
	clearClaudeHookBinding(t)
	providers, err := provider.NewRegistry([]provider.Descriptor{claude.Descriptor()})
	if err != nil {
		t.Fatal(err)
	}
	registry := cli.NewRegistry()
	cli.RegisterHook(registry, providers, func(*sql.DB) (journal.Assignments, journal.Observers) {
		t.Fatal("partial binding opened a journal backend")
		return nil, nil
	})
	for _, key := range claudeHookBindingKeys {
		for _, value := range []string{"", "malformed"} {
			t.Run(key+"/"+value, func(t *testing.T) {
				t.Setenv(key, value)
				arguments := []string{"hook", "ingest", "--provider", "claude"}
				if cli.IsUnscopedClaudeHook(arguments) {
					t.Fatal("present partial correlation was treated as unscoped")
				}
				var output, diagnostics bytes.Buffer
				exit := registry.ExecuteWithStderr(context.Background(), arguments, strings.NewReader(`{"hook_event_name":"PreToolUse","tool_name":"Bash"}`), &output, &diagnostics)
				if exit != 2 || output.Len() != 0 || diagnostics.String() != "bfb hook ingest: invalid_request\n" {
					t.Fatalf("partial binding did not fail closed: exit=%d stdout=%q stderr=%q", exit, output.String(), diagnostics.String())
				}
			})
		}
	}
}

func TestUnscopedClaudeHookOnlyMatchesExactVendorCommand(t *testing.T) {
	clearClaudeHookBinding(t)
	for _, arguments := range [][]string{
		nil, {"mcp", "stdio"}, {"hook", "status"}, {"hook", "ingest"},
		{"hook", "ingest", "--provider", "fake"}, {"hook", "ingest", "--provider", "claude", "extra"},
		{"--json", "hook", "ingest", "--provider", "claude"},
		{"--data-dir", "/tmp/other-state", "hook", "ingest", "--provider", "claude"},
	} {
		if cli.IsUnscopedClaudeHook(arguments) {
			t.Fatalf("non-vendor command bypassed binding: %q", arguments)
		}
	}
	providers, _ := provider.NewRegistry([]provider.Descriptor{claude.Descriptor()})
	registry := cli.NewRegistry()
	cli.RegisterHook(registry, providers, func(*sql.DB) (journal.Assignments, journal.Observers) {
		t.Fatal("explicit diagnostic command opened state without correlation")
		return nil, nil
	})
	var output, diagnostics bytes.Buffer
	exit := registry.ExecuteWithStderr(context.Background(), []string{"--json", "hook", "ingest", "--provider", "claude"}, strings.NewReader(`{}`), &output, &diagnostics)
	if exit != 2 || !protocol.DecodeWireDocument("local-rpc", output.Bytes()).OK || diagnostics.Len() != 0 || strings.Contains(output.String(), "hookSpecificOutput") {
		t.Fatal("explicit JSON diagnostic contract was bypassed", exit, output.String(), diagnostics.String())
	}
}

func (a *claudeHookAssignment) ByExecution(context.Context, string, int64) (journal.Assignment, error) {
	return a.value, nil
}

func (a *claudeHookAssignment) ByIntent(context.Context, string) (journal.Assignment, error) {
	return a.value, nil
}

func TestClaudeHookBootstrapRequiresTrustedReceipt(t *testing.T) {
	for _, source := range []string{"startup", "resume", "clear", "compact", "fork"} {
		t.Run(source, func(t *testing.T) {
			root, err := os.MkdirTemp("/tmp", "bfb-claude-hook-")
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
			state, err := daemon.OpenStore(context.Background(), paths)
			if err != nil {
				t.Fatal(err)
			}
			_ = state.Close()
			assignment := &claudeHookAssignment{value: journal.Assignment{
				ExecutionID: "01JBFB0EXECXXXX00000000000", Generation: 1, RunnerID: "01JBFB0RVNNER1D00000000000",
				WorkspaceID: "01JBFB0W0RKSPACE0000000000", ProjectID: "01JBFB0PR0JECT000000000000", TaskID: "01JBFB0TASKXXXX00000000000", RunID: "01JBFB0RVNXXXX000000000000",
				Provider: "claude", Token: "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE", CreatedAt: time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano),
			}}
			providers, err := provider.NewRegistry([]provider.Descriptor{claude.Descriptor()})
			if err != nil {
				t.Fatal(err)
			}
			registry := cli.NewRegistry()
			cli.RegisterHook(registry, providers, func(*sql.DB) (journal.Assignments, journal.Observers) { return assignment, nil })
			t.Setenv("BFB_RUN_EXECUTION_ID", assignment.value.ExecutionID)
			t.Setenv("BFB_ASSIGNMENT_GENERATION", "1")
			t.Setenv("BFB_CORRELATION_TOKEN", assignment.value.Token)
			t.Setenv("BFB_WORKSPACE_ID", assignment.value.WorkspaceID)
			t.Setenv("BFB_PROJECT_ID", assignment.value.ProjectID)
			t.Setenv("BFB_TASK_ID", assignment.value.TaskID)
			t.Setenv("BFB_RUN_ID", assignment.value.RunID)
			var output, diagnostics bytes.Buffer
			run := func(raw string, wantContext bool, wantStatus string) {
				t.Helper()
				output.Reset()
				diagnostics.Reset()
				exit := registry.ExecuteWithStderr(context.Background(), []string{"--data-dir", paths.Root, "hook", "ingest", "--provider", "claude"}, strings.NewReader(raw), &output, &diagnostics)
				if exit != 0 || !strings.Contains(diagnostics.String(), "bfb hook ingest: "+wantStatus) {
					t.Fatalf("unexpected hook disposition: exit=%d diagnostics=%q", exit, diagnostics.String())
				}
				if !wantContext {
					if output.Len() != 0 {
						t.Fatal("untrusted or non-SessionStart hook produced bootstrap output")
					}
					return
				}
				var decoded map[string]any
				if err := json.Unmarshal(output.Bytes(), &decoded); err != nil {
					t.Fatal(err)
				}
				expected := `{"hookSpecificOutput":{"additionalContext":` + quoteJSON(provider.InitialInstruction) + `,"hookEventName":"SessionStart"}}` + "\n"
				if output.String() != expected {
					t.Fatal("bootstrap is not the exact constant vendor response")
				}
				for _, private := range []string{assignment.value.Token, assignment.value.ExecutionID, assignment.value.TaskID, "private-hook-canary", "initialUserMessage"} {
					if strings.Contains(output.String()+diagnostics.String(), private) {
						t.Fatal("private hook data or implicit turn leaked")
					}
				}
			}
			start := `{"hook_event_name":"SessionStart","session_id":"33333333-3333-4333-8333-333333333333","source":"` + source + `","prompt":"private-hook-canary"}`
			run(start, true, "accepted")
			run(start, true, "duplicate")
			output.Reset()
			if exit := registry.Execute(context.Background(), []string{"--json", "--data-dir", paths.Root, "hook", "ingest", "--provider", "claude"}, strings.NewReader(start), &output); exit != 0 || !protocol.DecodeWireDocument("local-rpc", output.Bytes()).OK || strings.Contains(output.String(), "hookSpecificOutput") {
				t.Fatal("explicit JSON CLI diagnostics lost their stable envelope")
			}
			run(`{"hook_event_name":"UserPromptSubmit","session_id":"33333333-3333-4333-8333-333333333333","prompt_id":"synthetic-turn","prompt":"private-hook-canary"}`, false, "accepted")
			run(strings.ReplaceAll(start, "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"), false, "quarantined")
			t.Setenv("BFB_CORRELATION_TOKEN", "wrong-synthetic-token")
			run(start, false, "rejected")
			t.Setenv("BFB_CORRELATION_TOKEN", assignment.value.Token)
			assignment.value.WindowEndsAt = time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano)
			run(start, false, "rejected")
			// A durable inbox capture is not a verified session receipt. Force
			// the actual SQLite insert failure for a fresh assignment identity.
			state, err = daemon.OpenStore(context.Background(), paths)
			if err != nil {
				t.Fatal(err)
			}
			_, err = state.DB.Exec(`CREATE TRIGGER synthetic_hook_insert_failure BEFORE INSERT ON hook_journal BEGIN SELECT RAISE(ABORT, 'synthetic hook storage failure'); END`)
			_ = state.Close()
			if err != nil {
				t.Fatal(err)
			}
			assignment.value.ExecutionID = "01JBFB0EXECXXXX00000000001"
			assignment.value.WindowEndsAt = ""
			t.Setenv("BFB_RUN_EXECUTION_ID", assignment.value.ExecutionID)
			run(start, false, "inbox")
		})
	}
}

func quoteJSON(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
