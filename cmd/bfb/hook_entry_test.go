// ABOUTME: Checks the real CLI entry point leaves unrelated Claude hooks silent and state-free.
// ABOUTME: Uses isolated test subprocesses to retain failure for partial bindings and other commands.

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

var hookEntryBindingKeys = []string{
	"BFB_WORKSPACE_ID", "BFB_PROJECT_ID", "BFB_TASK_ID", "BFB_RUN_ID",
	"BFB_RUN_EXECUTION_ID", "BFB_ASSIGNMENT_GENERATION", "BFB_CHECKOUT_ID",
	"BFB_CORRELATION_TOKEN", "BFB_ARTIFACTS_DIR",
}

func TestMain(tests *testing.M) {
	if os.Getenv("BFB_CLI_ENTRY_TEST") == "1" {
		main()
		os.Exit(0)
	}
	os.Exit(tests.Run())
}

func TestUnscopedClaudeHookEntryDoesNotResolveHomeOrServices(t *testing.T) {
	for _, home := range []string{"", "missing-home", strings.Repeat("long-home", 30)} {
		for _, input := range []string{"", "{malformed", strings.Repeat("x", 65537), `{"hook_event_name":"PreToolUse","tool_name":"Write"}`, `{"hook_event_name":"SessionStart"}`} {
			t.Run("environment", func(t *testing.T) {
				root := t.TempDir()
				actualHome := home
				if home != "" {
					actualHome = filepath.Join(root, home)
				}
				stdout, stderr, err := runHookEntry(t, root, actualHome, []string{"hook", "ingest", "--provider", "claude"}, nil, input)
				if err != nil || stdout != "" || stderr != "" {
					t.Fatalf("unscoped hook performed work: err=%v stdout=%q stderr=%q", err, stdout, stderr)
				}
				assertHookEntryCreatedNoFiles(t, root)
			})
		}
	}
}

func TestHookEntryKeepsPartialBindingAndMalformedArgumentsClosed(t *testing.T) {
	for _, key := range hookEntryBindingKeys {
		for _, value := range []string{"", "malformed"} {
			t.Run(key+"/"+value, func(t *testing.T) {
				root := t.TempDir()
				stdout, stderr, err := runHookEntry(t, root, "", []string{"hook", "ingest", "--provider", "claude"}, []string{key + "=" + value}, `{}`)
				if err == nil || stdout+stderr == "" || strings.Contains(stdout+stderr, "hookSpecificOutput") {
					t.Fatal("partial binding bypassed normal validation", err, stdout, stderr)
				}
				assertHookEntryCreatedNoFiles(t, root)
			})
		}
	}
	for _, arguments := range [][]string{
		{"mcp", "stdio"}, {"hook", "ingest"}, {"hook", "ingest", "--provider", "fake"},
		{"hook", "ingest", "--provider", "claude", "extra"},
		{"--json", "hook", "ingest", "--provider", "claude"},
	} {
		root := t.TempDir()
		_, _, err := runHookEntry(t, root, "", arguments, nil, `{}`)
		if err == nil {
			t.Fatal("non-vendor command bypassed ordinary dispatch", arguments)
		}
		assertHookEntryCreatedNoFiles(t, root)
	}
}

func runHookEntry(t *testing.T, root, home string, arguments, scope []string, input string) (string, string, error) {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	environment := []string{}
	for _, value := range os.Environ() {
		key, _, _ := strings.Cut(value, "=")
		if key == "HOME" || key == "PATH" || key == "XDG_CONFIG_HOME" || key == "BFB_CLAUDE_HOME" || key == "BFB_CLI_ENTRY_TEST" || key == "GORACE" || strings.HasPrefix(key, "BFB_") {
			continue
		}
		environment = append(environment, value)
	}
	environment = append(environment, "BFB_CLI_ENTRY_TEST=1", "HOME="+home, "PATH="+filepath.Join(root, "missing-provider"), "BFB_CLAUDE_HOME="+filepath.Join(root, "unrelated-profile"), "GORACE=atexit_sleep_ms=0")
	environment = append(environment, scope...)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, executable, arguments...)
	command.Env, command.Stdin = environment, strings.NewReader(input)
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	err = command.Run()
	if ctx.Err() != nil {
		t.Fatal("CLI entry timed out")
	}
	return stdout.String(), stderr.String(), err
}

func assertHookEntryCreatedNoFiles(t *testing.T, root string) {
	t.Helper()
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatal("hook entry created user or provider state", entries, err)
	}
}
