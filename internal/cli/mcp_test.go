// ABOUTME: Proves bfb mcp stdio activates a capability from the L06 hook-journal binding.
// ABOUTME: Uses synthetic identities and the real OS inspector; no test reaches the network.

package cli

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/localmcp"
	_ "modernc.org/sqlite"
)

// seedBoundAssignment writes one active assignment whose supervisor matches
// the real parent process, plus the L06 trusted binding row for it. The peer
// check inspects our actual parent, so the row must mirror OSInspector.
func seedBoundAssignment(t *testing.T, path string) {
	t.Helper()
	facts, err := localmcp.OSInspector().Inspect()
	if err != nil {
		t.Fatalf("inspector unavailable: %v", err)
	}
	if facts.PID <= 0 || facts.StartIdentity == "" {
		t.Fatalf("inspector misses parent identity: %+v", facts)
	}
	supervisor, err := json.Marshal(map[string]any{
		"process": map[string]any{"pid": facts.PID, "start_identity": facts.StartIdentity},
	})
	if err != nil {
		t.Fatal(err)
	}
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
 task_id, run_id, runner_id, checkout_id, supervisor_json)
VALUES (?, 7, 'running', ?, ?, ?, ?, ?, ?, ?, ?)`,
		testExecution, testToken, testWorkspace, testProject, testTask, testRun, testRunner, testCheckout, string(supervisor)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE hook_observed_sessions (
execution_id TEXT NOT NULL, assignment_generation INTEGER NOT NULL,
provider TEXT NOT NULL, session_id TEXT NOT NULL, bound_at TEXT NOT NULL,
PRIMARY KEY (execution_id, assignment_generation))`); err != nil {
		t.Fatal(err)
	}
	boundAt := time.Now().UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano)
	if _, err := db.Exec(`INSERT INTO hook_observed_sessions
(execution_id, assignment_generation, provider, session_id, bound_at)
VALUES (?, 7, 'fake', 'synthetic-mcp-session-001', ?)`, testExecution, boundAt); err != nil {
		t.Fatal(err)
	}
}

func executeMCP(t *testing.T, dataDir, stdin string) (int, string) {
	t.Helper()
	registry := NewRegistry()
	RegisterMCP(registry)
	var output bytes.Buffer
	code := registry.Execute(context.Background(), []string{"--data-dir", dataDir, "mcp", "stdio"}, strings.NewReader(stdin), &output)
	return code, output.String()
}

// mcpResultLine splits stdout into JSON-RPC envelopes, one per line.
func mcpResultLine(t *testing.T, output string, count int) []map[string]any {
	t.Helper()
	lines := strings.Split(strings.TrimSpace(output), "\n")
	if len(lines) != count {
		t.Fatalf("expected %d stdout lines, got:\n%s", count, output)
	}
	values := make([]map[string]any, 0, len(lines))
	for _, line := range lines {
		var value map[string]any
		if err := json.Unmarshal([]byte(line), &value); err != nil {
			t.Fatalf("stdout is not JSON-RPC: %v\n%s", err, output)
		}
		if value["jsonrpc"] != "2.0" {
			t.Fatalf("line is not JSON-RPC: %s", line)
		}
		values = append(values, value)
	}
	return values
}

func mcpErrorCode(value map[string]any) string {
	failure, _ := value["error"].(map[string]any)
	data, _ := failure["data"].(map[string]any)
	code, _ := data["bfb_code"].(string)
	return code
}

func mcpToolText(t *testing.T, value map[string]any) map[string]any {
	t.Helper()
	result, _ := value["result"].(map[string]any)
	content, _ := result["content"].([]any)
	if len(content) != 1 {
		t.Fatalf("tool result has no text content: %v", value)
	}
	entry, _ := content[0].(map[string]any)
	text, _ := entry["text"].(string)
	var decoded map[string]any
	if err := json.Unmarshal([]byte(text), &decoded); err != nil {
		t.Fatalf("tool text is not JSON: %v", err)
	}
	return decoded
}

func TestMCPStdioActivatesBoundSession(t *testing.T) {
	submitEnv(t, nil)
	dataDir := shortDataDir(t)
	seedBoundAssignment(t, dataDir+"/state.sqlite")
	stdin := "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}\n" +
		"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"bfb_add_comment\",\"arguments\":{\"body\":\"Synthetic comment\",\"request_id\":\"mcp-bind-0001\"}}}\n"
	code, output := executeMCP(t, dataDir, stdin)
	if code != 0 {
		t.Fatalf("mcp stdio failed: %d %s", code, output)
	}
	values := mcpResultLine(t, output, 2)
	if _, ok := values[0]["result"]; !ok {
		t.Fatalf("handshake failed: %s", output)
	}
	receipt := mcpToolText(t, values[1])
	if receipt["status"] != "pending_sync" || receipt["request_id"] != "mcp-bind-0001" ||
		receipt["tool"] != "bfb_add_comment" || receipt["expires_at"] == nil {
		t.Fatalf("bound mutation was not journaled: %s", output)
	}
	if strings.Contains(output, testToken) || strings.Contains(output, "Synthetic comment") {
		t.Fatalf("receipt leaks request material: %s", output)
	}
}

func TestMCPStdioRejectsMutationWhileUnbound(t *testing.T) {
	submitEnv(t, nil)
	dataDir := shortDataDir(t)
	seedAssignments(t, dataDir+"/state.sqlite", "running", testToken)
	// Seed the supervisor identity without any binding row: peer verification
	// passes but activation must still fail closed.
	facts, err := localmcp.OSInspector().Inspect()
	if err != nil {
		t.Fatalf("inspector unavailable: %v", err)
	}
	supervisor, err := json.Marshal(map[string]any{
		"process": map[string]any{"pid": facts.PID, "start_identity": facts.StartIdentity},
	})
	if err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", "file:"+dataDir+"/state.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE local_execution_assignments SET supervisor_json = ? WHERE execution_id = ?`, string(supervisor), testExecution); err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	_ = db.Close()
	stdin := "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}\n" +
		"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"bfb_add_comment\",\"arguments\":{\"body\":\"Synthetic comment\",\"request_id\":\"mcp-bind-0002\"}}}\n"
	code, output := executeMCP(t, dataDir, stdin)
	if code != 0 {
		t.Fatalf("mcp stdio failed: %d %s", code, output)
	}
	values := mcpResultLine(t, output, 2)
	if mcpErrorCode(values[1]) != "session_not_bound" {
		t.Fatalf("unbound mutation must fail closed: %s", output)
	}
}
