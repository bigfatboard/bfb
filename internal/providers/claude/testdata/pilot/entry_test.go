// ABOUTME: Exercises the candidate entry point's silent unscoped hook before signed binding inspection.
// ABOUTME: Runs only isolated test executables and rejects partial bindings or non-hook commands without services.

package main

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMain(tests *testing.M) {
	if os.Getenv("BFB_PILOT_ENTRY_TEST") == "1" {
		main()
		os.Exit(0)
	}
	os.Exit(tests.Run())
}

func TestCandidateUnscopedClaudeHookSkipsBindingAndInput(t *testing.T) {
	for _, input := range []string{"", "{malformed", strings.Repeat("x", 65537), `{"hook_event_name":"SessionStart"}`, `{"hook_event_name":"PreToolUse","tool_name":"Bash"}`} {
		t.Run("input", func(t *testing.T) {
			root := t.TempDir()
			stdout, stderr, err := runCandidateEntry(t, root, []string{"hook", "ingest", "--provider", "claude"}, nil, input)
			if err != nil || stdout != "" || stderr != "" {
				t.Fatalf("unscoped hook failed: err=%v stdout=%q stderr=%q", err, stdout, stderr)
			}
			assertCandidateEntryCreatedNoFiles(t, root)
		})
	}
}

func TestCandidateEarlyNoopRejectsPartialBindingAndOtherCommands(t *testing.T) {
	keys := []string{"BFB_WORKSPACE_ID", "BFB_PROJECT_ID", "BFB_TASK_ID", "BFB_RUN_ID", "BFB_RUN_EXECUTION_ID", "BFB_ASSIGNMENT_GENERATION", "BFB_CHECKOUT_ID", "BFB_CORRELATION_TOKEN", "BFB_ARTIFACTS_DIR"}
	for _, key := range keys {
		for _, value := range []string{"", "malformed"} {
			t.Run(key+"/"+value, func(t *testing.T) {
				root := t.TempDir()
				stdout, _, err := runCandidateEntry(t, root, []string{"hook", "ingest", "--provider", "claude"}, []string{key + "=" + value}, `{}`)
				if err == nil || stdout != "" {
					t.Fatal("candidate bypassed binding for partial authority", err, stdout)
				}
				assertCandidateEntryCreatedNoFiles(t, root)
			})
		}
	}
	for _, arguments := range [][]string{
		{"mcp", "stdio"}, {"provider", "doctor", "claude"}, {"hook", "ingest"},
		{"hook", "ingest", "--provider", "fake"}, {"hook", "ingest", "--provider", "claude", "extra"},
		{"--json", "hook", "ingest", "--provider", "claude"},
		{"--data-dir", "/tmp/other-state", "hook", "ingest", "--provider", "claude"},
	} {
		root := t.TempDir()
		stdout, _, err := runCandidateEntry(t, root, arguments, nil, `{}`)
		if err == nil || stdout != "" {
			t.Fatal("candidate bypassed binding for a non-vendor command", arguments, err, stdout)
		}
		assertCandidateEntryCreatedNoFiles(t, root)
	}
}

func runCandidateEntry(t *testing.T, root string, arguments, scope []string, input string) (string, string, error) {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	environment := []string{}
	for _, value := range os.Environ() {
		key, _, _ := strings.Cut(value, "=")
		if key == "HOME" || key == "PATH" || key == "GORACE" || strings.HasPrefix(key, "BFB_") {
			continue
		}
		environment = append(environment, value)
	}
	environment = append(environment, "BFB_PILOT_ENTRY_TEST=1", "HOME="+filepath.Join(root, "outside-home"), "BFB_CLAUDE_HOME="+filepath.Join(root, "other-profile"), "PATH="+filepath.Join(root, "missing-provider"), "GORACE=atexit_sleep_ms=0")
	environment = append(environment, scope...)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, executable, arguments...)
	command.Env = environment
	command.Stdin = strings.NewReader(input)
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	err = command.Run()
	if ctx.Err() != nil {
		t.Fatal("candidate entry timed out")
	}
	return stdout.String(), stderr.String(), err
}

func assertCandidateEntryCreatedNoFiles(t *testing.T, root string) {
	t.Helper()
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatal("candidate entry touched home, provider or private state", entries, err)
	}
}
