// ABOUTME: Checks Claude hook stdout bootstrap only after a trusted durable local receipt.
// ABOUTME: Uses isolated SQLite assignments and synthetic hook inputs without provider turns.

package cli_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"os"
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
