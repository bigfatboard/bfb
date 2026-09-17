// ABOUTME: Proves run submit journals one idempotent pending_sync operation for the bound run.
// ABOUTME: Uses synthetic identities only; no test reaches the network or the daemon database.

package cli

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

const (
	testWorkspace = "01SYNTHETICWS00000000000001"
	testProject   = "01SYNTHETICPR00000000000001"
	testTask      = "01SYNTHETICTA00000000000001"
	testRun       = "01SYNTHETICRU00000000000001"
	testExecution = "01SYNTHETICEX00000000000001"
	testCheckout  = "01SYNTHETICCO00000000000001"
	testRunner    = "01SYNTHETICRN00000000000001"
	testToken     = "synthetic-cli-correlation-001"
)

func submitEnv(t *testing.T, extra map[string]string) {
	t.Helper()
	for key, value := range map[string]string{
		"BFB_WORKSPACE_ID":          testWorkspace,
		"BFB_PROJECT_ID":            testProject,
		"BFB_TASK_ID":               testTask,
		"BFB_RUN_ID":                testRun,
		"BFB_RUN_EXECUTION_ID":      testExecution,
		"BFB_ASSIGNMENT_GENERATION": "7",
		"BFB_CHECKOUT_ID":           testCheckout,
		"BFB_CORRELATION_TOKEN":     testToken,
		"BFB_ARTIFACTS_DIR":         t.TempDir(),
		"BFB_RUNNER_ID":             testRunner,
	} {
		t.Setenv(key, value)
	}
	for key, value := range extra {
		t.Setenv(key, value)
	}
}

// shortDataDir returns a short user-only state directory: the Darwin socket
// limit rejects the long test-qualified t.TempDir paths.
func shortDataDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "bfbrun")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func seedAssignments(t *testing.T, path, state, token string) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE local_execution_assignments (
execution_id TEXT, assignment_generation INTEGER, state TEXT, correlation_token TEXT,
workspace_id TEXT, project_id TEXT, task_id TEXT, run_id TEXT, runner_id TEXT, checkout_id TEXT,
supervisor_json TEXT, owned_group_json TEXT)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO local_execution_assignments
(execution_id, assignment_generation, state, correlation_token, workspace_id, project_id,
 task_id, run_id, runner_id, checkout_id)
VALUES (?, 7, ?, ?, ?, ?, ?, ?, ?, ?)`,
		testExecution, state, token, testWorkspace, testProject, testTask, testRun, testRunner, testCheckout); err != nil {
		t.Fatal(err)
	}
}

func submitArgs() []string {
	return []string{
		"run", "submit",
		"--summary", "Synthetic CLI result",
		"--limitations", "Synthetic CLI limitation",
		"--evidence-ref", "comment:synthetic-cli-comment@1",
		"--git-branch", "main",
		"--git-commit", strings.Repeat("c", 40),
		"--git-dirty=false",
		"--request-id", "cli-submit-001",
	}
}

func executeRun(t *testing.T, dataDir string, args []string) (int, string) {
	t.Helper()
	registry := NewRegistry()
	RegisterRun(registry)
	var output bytes.Buffer
	words := append([]string{"--data-dir", dataDir}, args...)
	code := registry.Execute(context.Background(), words, nil, &output)
	return code, output.String()
}

func decodeLine(t *testing.T, output string) map[string]any {
	t.Helper()
	lines := strings.Split(strings.TrimSpace(output), "\n")
	if len(lines) != 1 {
		t.Fatalf("expected exactly one stdout line, got:\n%s", output)
	}
	var value map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &value); err != nil {
		t.Fatalf("stdout is not JSON: %v", err)
	}
	return value
}

func TestRunSubmitJournalsPendingSync(t *testing.T) {
	submitEnv(t, nil)
	dataDir := shortDataDir(t)
	seedAssignments(t, dataDir+"/state.sqlite", "running", testToken)
	code, output := executeRun(t, dataDir, submitArgs())
	if code != 0 {
		t.Fatalf("run submit failed: %d %s", code, output)
	}
	receipt := decodeLine(t, output)
	if receipt["status"] != "pending_sync" || receipt["request_id"] != "cli-submit-001" ||
		receipt["tool"] != "bfb_submit_result" || receipt["expires_at"] == nil {
		t.Fatalf("unexpected receipt: %s", output)
	}
	if strings.Contains(output, "Synthetic CLI result") || strings.Contains(output, testToken) {
		t.Fatalf("receipt leaks submission material: %s", output)
	}
	again, repeated := executeRun(t, dataDir, submitArgs())
	if again != 0 {
		t.Fatalf("repeat failed: %d %s", again, repeated)
	}
	second := decodeLine(t, repeated)
	if second["expires_at"] != receipt["expires_at"] || second["request_id"] != receipt["request_id"] {
		t.Fatalf("repeat created a second operation: %s vs %s", repeated, output)
	}
}

func TestRunSubmitRejectsUntrustedInput(t *testing.T) {
	cases := []struct {
		name  string
		state string
		token string
		extra map[string]string
		args  []string
		code  string
	}{
		{"unknown assignment", "running", testToken, nil,
			[]string{"run", "submit", "--summary", "x", "--request-id", "cli-neg-001"}, "storage_failed"},
		{"wrong correlation", "running", "another-correlation", nil, submitArgs(), "correlation_rejected"},
		{"ended assignment", "ended", testToken, nil, submitArgs(), "assignment_ended"},
		{"missing summary", "running", testToken, nil,
			[]string{"run", "submit", "--request-id", "cli-neg-002"}, "invalid_request"},
		{"short request id", "running", testToken, nil,
			[]string{"run", "submit", "--summary", "x", "--request-id", "short"}, "invalid_request"},
		{"unknown flag", "running", testToken, nil,
			[]string{"run", "submit", "--summary", "x", "--request-id", "cli-neg-003", "--workspace", "other"}, "invalid_request"},
		{"bad evidence ref", "running", testToken, nil,
			[]string{"run", "submit", "--summary", "x", "--request-id", "cli-neg-004", "--evidence-ref", "no-separator"}, "invalid_request"},
		{"bad commit", "running", testToken, nil,
			[]string{"run", "submit", "--summary", "x", "--request-id", "cli-neg-005", "--git-commit", "short"}, "invalid_params"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			submitEnv(t, tc.extra)
			dataDir := shortDataDir(t)
			if tc.name != "unknown assignment" {
				seedAssignments(t, dataDir+"/state.sqlite", tc.state, tc.token)
			}
			code, output := executeRun(t, dataDir, tc.args)
			if code == 0 {
				t.Fatalf("untrusted input accepted: %s", output)
			}
			value := decodeLine(t, output)
			failure, _ := value["error"].(map[string]any)
			if failure["code"] != tc.code {
				t.Fatalf("expected code %s, got: %s", tc.code, output)
			}
			if strings.Contains(output, testToken) || strings.Contains(output, "synthetic-cli") {
				t.Fatalf("rejection leaks submission material: %s", output)
			}
		})
	}
}

func TestRunSubmitRefusesBearerEnvironment(t *testing.T) {
	submitEnv(t, map[string]string{"BFB_RUNNER_TOKEN": "synthetic-bearer"})
	dataDir := shortDataDir(t)
	seedAssignments(t, dataDir+"/state.sqlite", "running", testToken)
	code, output := executeRun(t, dataDir, submitArgs())
	if code == 0 {
		t.Fatal("bearer-polluted environment accepted")
	}
	value := decodeLine(t, output)
	failure, _ := value["error"].(map[string]any)
	if failure["code"] != "invalid_request" {
		t.Fatalf("unexpected code: %s", output)
	}
	if strings.Contains(output, "synthetic-bearer") {
		t.Fatalf("rejection leaks bearer material: %s", output)
	}
}
