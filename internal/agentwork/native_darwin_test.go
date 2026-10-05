// ABOUTME: Verifies compiled MCP stdio through signed daemon IPC and authenticated Worker/D1 reads.
// ABOUTME: Uses a synthetic provider-shaped process group, exact Keychain cleanup and no live turns.

//go:build darwin && cgo

package agentwork

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"database/sql"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/auth"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/localmcp"
	"github.com/qdis/bfb/internal/runner"
	"golang.org/x/sys/unix"
)

// TestMCPProviderProcess is a subprocess fixture, never a real coding provider.
func TestMCPProviderProcess(t *testing.T) {
	if os.Getenv("BFB_A01_PROVIDER_FIXTURE") != "1" {
		t.Skip("provider-shaped subprocess only")
	}
	row, err := unix.SysctlKinfoProc("kern.proc.pid", os.Getpid())
	if err != nil || row == nil {
		os.Exit(2)
	}
	facts := map[string]any{"pid": os.Getpid(), "group_id": int(row.Eproc.Pgid), "start_identity": fmt.Sprintf("%d:%d", row.Proc.P_starttime.Sec, row.Proc.P_starttime.Usec)}
	data, _ := json.Marshal(facts)
	fmt.Println(string(data))
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 65536)
	var child *exec.Cmd
	var input io.WriteCloser
	start := func() {
		child = exec.Command(os.Getenv("BFB_A01_BINARY"), "--data-dir", os.Getenv("BFB_A01_ROOT"), "mcp", "stdio")
		for _, entry := range os.Environ() {
			key, _, _ := strings.Cut(entry, "=")
			if !strings.HasPrefix(key, "BFB_A01_") {
				child.Env = append(child.Env, entry)
			}
		}
		child.Stdout, child.Stderr = os.Stdout, os.Stderr
		input, err = child.StdinPipe()
		if err != nil || child.Start() != nil {
			os.Exit(2)
		}
		fmt.Println("READY")
	}
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "__ipc:") {
			probe := exec.Command(os.Args[0], "-test.run=^TestMCPIPCProcess$")
			probe.Env = append(os.Environ(), "BFB_A01_IPC_FIXTURE=1")
			probe.Stdin = strings.NewReader(strings.TrimPrefix(line, "__ipc:"))
			probe.Stdout, probe.Stderr = os.Stdout, os.Stderr
			if probe.Run() != nil {
				os.Exit(2)
			}
		} else if strings.HasPrefix(line, "__scope:") {
			if child != nil {
				_ = input.Close()
				if child.Wait() != nil {
					os.Exit(2)
				}
				child = nil
				input = nil
			}
			var scope map[string]string
			if json.Unmarshal([]byte(strings.TrimPrefix(line, "__scope:")), &scope) != nil {
				os.Exit(2)
			}
			for key, value := range scope {
				if !strings.HasPrefix(key, "BFB_") || os.Setenv(key, value) != nil {
					os.Exit(2)
				}
			}
			fmt.Println("SCOPED")
		} else if line == "__start" || line == "__restart" {
			if child != nil {
				_ = input.Close()
				if child.Wait() != nil {
					os.Exit(2)
				}
			}
			start()
		} else if input == nil {
			os.Exit(2)
		} else if _, err := io.WriteString(input, line+"\n"); err != nil {
			os.Exit(2)
		}
	}
	if child != nil {
		_ = input.Close()
		if child.Wait() != nil {
			os.Exit(2)
		}
	}
	os.Exit(0)
}

func TestMCPIPCProcess(t *testing.T) {
	if os.Getenv("BFB_A01_IPC_FIXTURE") != "1" {
		t.Skip("owned caller subprocess only")
	}
	paths, err := daemon.StatePaths(os.Getenv("BFB_A01_ROOT"))
	if err != nil {
		os.Exit(2)
	}
	data, err := io.ReadAll(io.LimitReader(os.Stdin, 2048))
	if err != nil {
		os.Exit(2)
	}
	var payload map[string]any
	if json.Unmarshal(data, &payload) != nil {
		os.Exit(2)
	}
	_, err = daemon.Call(context.Background(), paths, "mcp.authority", payload)
	code := "success"
	if err != nil {
		code = daemon.AsFailure(err).Code
	}
	fmt.Println("IPC:" + code)
	os.Exit(0)
}

func TestNativeAgentWork(t *testing.T) {
	target := os.Getenv("BFB_A01_TEST_URL")
	if target == "" {
		t.Skip("run through tools/local-mcp/native.ts")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	upstream, err := url.Parse(target)
	if err != nil || upstream.Hostname() != "127.0.0.1" && upstream.Hostname() != "localhost" {
		t.Fatal("Worker must be loopback")
	}
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	proxy.Transport = &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}} // Wrangler development certificate only.
	proxy.Director = func(request *http.Request) {
		request.URL.Scheme = upstream.Scheme
		request.URL.Host = upstream.Host
		request.Host = "bfb.channel.test"
	}
	server := httptest.NewTLSServer(proxy)
	defer server.Close()
	directory, err := os.MkdirTemp("", "bfb-a01-native-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(directory)
	paths, err := daemon.StatePaths(filepath.Join(directory, "s"))
	if err != nil || paths.Prepare() != nil {
		t.Fatal("private state setup failed", err)
	}
	config, _ := json.Marshal(map[string]string{"ProxyAddress": server.Listener.Addr().String(), "Certificate": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}))})
	if err := os.WriteFile(filepath.Join(paths.Root, "fixture.json"), config, 0600); err != nil {
		t.Fatal(err)
	}
	repo, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	command := func(name string, args ...string) []byte {
		t.Helper()
		cmd := exec.CommandContext(ctx, name, args...)
		cmd.Dir = repo
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("%s failed: %v: %s", filepath.Base(name), err, output)
		}
		return output
	}
	identity := regexp.MustCompile(`(?m)^\s*\d+\) ([A-F0-9]{40}) "Apple Development:`).FindSubmatch(command("security", "find-identity", "-v", "-p", "codesigning"))
	if identity == nil {
		t.Fatal("signed native test requires an Apple development identity")
	}
	dae, binary := filepath.Join(directory, "daemon"), filepath.Join(directory, "bfb")
	command("go", "build", "-o", dae, "./internal/agentwork/testdata/daemon")
	command("go", "build", "-o", binary, "./cmd/bfb")
	command("codesign", "--force", "--sign", string(identity[1]), "--identifier", auth.DaemonSigningIdentifier, "--options", "runtime", dae)
	label := "com.tenira.bfb.a01." + strings.ToLower(daemon.NewRequestID())
	var enrollment runner.Enrollment
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 20*time.Second)
		defer stop()
		_ = exec.CommandContext(cleanup, "/bin/launchctl", "bootout", fmt.Sprintf("gui/%d/%s", os.Getuid(), label)).Run()
		if enrollment.RunnerID != "" {
			if out, err := exec.CommandContext(cleanup, dae, "cleanup", enrollment.WorkspaceID, enrollment.RunnerID).CombinedOutput(); err != nil {
				t.Errorf("exact Keychain cleanup failed: %v: %s", err, out)
			}
		}
	}()
	if err := daemon.Install(ctx, paths, dae, filepath.Join(directory, "agents"), label); err != nil {
		t.Fatal(err)
	}
	wait := func(label string, check func() bool) {
		t.Helper()
		deadline := time.Now().Add(25 * time.Second)
		for time.Now().Before(deadline) {
			if check() {
				return
			}
			select {
			case <-ctx.Done():
				t.Fatal("fixture cancelled", label)
			case <-time.After(100 * time.Millisecond):
			}
		}
		t.Fatal("timed out", label)
	}
	wait("signed daemon", func() bool { _, err := daemon.Call(ctx, paths, "daemon.status", nil); return err == nil })
	post := func(path string, body any, browser bool) map[string]json.RawMessage {
		t.Helper()
		data, _ := json.Marshal(body)
		request, _ := http.NewRequestWithContext(ctx, "POST", server.URL+path, bytes.NewReader(data))
		request.Header.Set("Content-Type", "application/json")
		if browser {
			request.Header.Set("Origin", "https://bfb.channel.test")
			request.Header.Set("Sec-Fetch-Site", "same-origin")
			request.Header.Set("Cookie", os.Getenv("BFB_A01_TEST_COOKIE"))
			request.Header.Set("X-BFB-CSRF", os.Getenv("BFB_A01_TEST_CSRF"))
		}
		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		data, _ = io.ReadAll(io.LimitReader(response.Body, 65536))
		var result map[string]json.RawMessage
		if response.StatusCode < 200 || response.StatusCode >= 300 || json.Unmarshal(data, &result) != nil {
			t.Fatalf("fixture %s rejected: %d %s", path, response.StatusCode, data)
		}
		return result
	}
	response, err := daemon.Call(ctx, paths, "runner.enroll", map[string]any{"app_origin": "https://bfb.channel.test", "workspace_id": os.Getenv("BFB_A01_TEST_WORKSPACE"), "device_label": "Synthetic A01 Mac"})
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(response.Payload["enrollment"])
	if json.Unmarshal(data, &enrollment) != nil {
		t.Fatal("invalid public enrollment")
	}
	extra := map[string]any{"workspace_id": enrollment.WorkspaceID, "runner_id": enrollment.RunnerID, "action": "runner.enroll", "device_label": enrollment.Label, "public_key": enrollment.PublicKey, "project_ids": []string{os.Getenv("BFB_A01_TEST_PROJECT")}}
	proof := post("/__test/proof", extra, false)
	var proofID string
	_ = json.Unmarshal(proof["proof"], &proofID)
	post("/api/v1/workspaces/"+enrollment.WorkspaceID+"/runners", map[string]any{"runner_id": enrollment.RunnerID, "device_label": enrollment.Label, "public_key": enrollment.PublicKey, "project_ids": extra["project_ids"], "step_up_proof_id": proofID}, true)
	wait("authenticated runner", func() bool {
		observed := post("/__test/observe", map[string]any{"workspace_id": enrollment.WorkspaceID, "runner_id": enrollment.RunnerID}, false)
		return string(observed["connection"]) != "null"
	})
	fixture := post("/__a01/seed", map[string]string{"runner": enrollment.RunnerID}, false)
	ids := map[string]string{}
	for key, value := range fixture {
		var id string
		_ = json.Unmarshal(value, &id)
		ids[key] = id
	}
	// The caller deliberately receives only scoped assignment values, not test cookie, key or token.
	provider := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestMCPProviderProcess$")
	provider.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	for _, key := range []string{"PATH", "TMPDIR", "LANG", "LC_ALL", "DEVELOPER_DIR"} {
		if value, present := os.LookupEnv(key); present {
			provider.Env = append(provider.Env, key+"="+value)
		}
	}
	for key, value := range map[string]string{"BFB_A01_PROVIDER_FIXTURE": "1", "BFB_A01_BINARY": binary, "BFB_A01_ROOT": paths.Root, "BFB_WORKSPACE_ID": ids["workspace"], "BFB_PROJECT_ID": ids["project"], "BFB_TASK_ID": ids["task"], "BFB_RUN_ID": ids["run"], "BFB_RUN_EXECUTION_ID": ids["execution"], "BFB_ASSIGNMENT_GENERATION": "1", "BFB_CHECKOUT_ID": ids["checkout"], "BFB_RUNNER_ID": ids["runner"], "BFB_CORRELATION_TOKEN": "a01-synthetic-correlation", "BFB_ARTIFACTS_DIR": directory} {
		provider.Env = append(provider.Env, key+"="+value)
	}
	for _, entry := range provider.Env {
		key, value, _ := strings.Cut(entry, "=")
		if strings.Contains(key, "COOKIE") || strings.Contains(key, "CSRF") || strings.Contains(key, "SECRET") || strings.Contains(key, "CREDENTIAL") || strings.Contains(key, "BEARER") || strings.Contains(key, "KEY") || strings.Contains(key, "TOKEN") && key != "BFB_CORRELATION_TOKEN" || value == os.Getenv("BFB_A01_TEST_COOKIE") || value == os.Getenv("BFB_A01_TEST_CSRF") {
			t.Fatal("credential entered provider environment")
		}
	}
	stdin, err := provider.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := provider.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	provider.Stderr = os.Stderr
	if err := provider.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = stdin.Close()
		if err := provider.Wait(); err != nil {
			t.Error("provider fixture failed", err)
		}
	}()
	reader := bufio.NewReaderSize(stdout, 65537)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var leader map[string]any
	if json.Unmarshal(line, &leader) != nil {
		t.Fatal("missing native fixture identity")
	}
	group, _ := json.Marshal(map[string]any{"leader": leader})
	db, err := sql.Open("sqlite", "file:"+paths.Database+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	seedLocal := func() {
		t.Helper()
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		now := time.Now().UTC().Format(time.RFC3339Nano)
		expires := time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339Nano)
		if _, err := tx.Exec(`INSERT INTO execution_commands (runner_id,command_id,workspace_id,command_kind,expires_at,received_at,claim_key,claim_started_at,state) VALUES (?,?,?,'launch',?,?,?,?,'queued')`, ids["runner"], ids["launch"], ids["workspace"], expires, now, "synthetic", now); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(`INSERT INTO local_execution_assignments (execution_id,assignment_generation,workspace_id,project_id,task_id,run_id,runner_id,checkout_id,launch_id,intent_id,physical_worktree_hash,fencing_generation,claim_json,provider_identity_hash,correlation_token,created_at,expires_at,state,owned_group_json) VALUES (?,1,?,?,?,?,?,?,?,?,?,1,'{}','synthetic','a01-synthetic-correlation',?,?,'running',?)`, ids["execution"], ids["workspace"], ids["project"], ids["task"], ids["run"], ids["runner"], ids["checkout"], ids["launch"], daemon.NewRequestID(), ids["physical"], now, expires, string(group)); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(`UPDATE execution_commands SET state='complete' WHERE runner_id=? AND command_id=?`, ids["runner"], ids["launch"]); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}
	seedLocal()
	write := func(value any) {
		t.Helper()
		data, _ := json.Marshal(value)
		if _, err := stdin.Write(append(data, '\n')); err != nil {
			t.Fatal(err)
		}
	}
	restart := func(marker string) {
		t.Helper()
		_, _ = io.WriteString(stdin, marker+"\n")
		line, err := reader.ReadString('\n')
		if err != nil || line != "READY\n" {
			t.Fatal("MCP startup failed", err, line)
		}
		write(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
		line, err = reader.ReadString('\n')
		if err != nil || !strings.Contains(line, "local-mcp/2") {
			t.Fatal("compiled v2 initialize failed", err, line)
		}
	}
	call := func(tool, id string, extra map[string]any) (map[string]any, string) {
		t.Helper()
		args := map[string]any{"request_id": id}
		for key, value := range extra {
			args[key] = value
		}
		write(map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": map[string]any{"name": tool, "arguments": args}})
		line, err := reader.ReadBytes('\n')
		if err != nil {
			t.Fatal("MCP reply missing", err)
		}
		var reply map[string]any
		if json.Unmarshal(line, &reply) != nil {
			t.Fatal("stdout not JSON-RPC")
		}
		if failure, ok := reply["error"].(map[string]any); ok {
			return nil, failure["data"].(map[string]any)["bfb_code"].(string)
		}
		result := reply["result"].(map[string]any)
		text := result["content"].([]any)[0].(map[string]any)["text"].(string)
		var body map[string]any
		if json.Unmarshal([]byte(text), &body) != nil {
			t.Fatal("tool text not JSON")
		}
		return body, ""
	}
	restart("__start")
	contextResult, code := call("bfb_get_context", "native-context-1", nil)
	if code != "" {
		t.Fatal("production context read", code)
	}
	items := contextResult["context"].([]any)
	deliveries := contextResult["deliveries"].([]any)
	if len(items) != 2 || len(deliveries) != 2 || contextResult["delivery"] != nil {
		t.Fatal("per-item context shape lost", contextResult)
	}
	for index, item := range items {
		value := item.(map[string]any)
		delivery := deliveries[index].(map[string]any)
		if value["audience"] == "human" || delivery["content_hash"] != value["content_hash"] || delivery["context_version"] != value["version"] || delivery["run_id"] != ids["run"] {
			t.Fatal("untruthful context delivery", index)
		}
	}
	task, code := call("bfb_get_task", "native-task-001", nil)
	if code != "" || task["task"].(map[string]any)["id"] != ids["task"] {
		t.Fatal("production task read", code)
	}
	if _, code := call("bfb_add_comment", "native-write-01", map[string]any{"body": "Synthetic denied mutation"}); code != "session_not_bound" {
		t.Fatal("unbound mutation not denied", code)
	}
	beforeWrite := post("/__a01/observe", map[string]string{"execution": ids["execution"]}, false)
	for tool, arguments := range map[string]map[string]any{"bfb_update_task": {"expected_version": 1, "title": "Denied synthetic title"}, "bfb_propose_task": {"title": "Denied synthetic proposal"}} {
		if _, code := call(tool, "native-write-"+tool, arguments); code != "session_not_bound" {
			t.Fatal("unbound mutation not denied", tool, code)
		}
	}
	afterWrite := post("/__a01/observe", map[string]string{"execution": ids["execution"]}, false)
	if string(beforeWrite["business"]) != string(afterWrite["business"]) || !strings.Contains(string(afterWrite["business"]), `"comments":0`) {
		t.Fatal("unbound mutations changed business state")
	}
	if _, code := call("bfb_get_context", "native-bound-01", map[string]any{"task_id": daemon.NewRequestID()}); code != "boundary_escape" {
		t.Fatal("foreign task not rejected", code)
	}
	if _, code := call("bfb_get_task", "native-context-1", nil); code != "request_rejected" {
		t.Fatal("cross-tool request reuse not rejected", code)
	}
	restart("__restart")
	replayed, code := call("bfb_get_context", "native-context-1", nil)
	if code != "" {
		t.Fatal("cloud replay failed", code)
	}
	a, _ := json.Marshal(contextResult)
	b, _ := json.Marshal(replayed)
	if !bytes.Equal(a, b) {
		t.Fatal("cloud replay changed delivery identities")
	}
	observed := post("/__a01/observe", map[string]string{"execution": ids["execution"]}, false)
	var committed []localmcp.ContextDelivery
	_ = json.Unmarshal(observed["deliveries"], &committed)
	if len(committed) != 2 || string(observed["sessions"]) != "{\"count\":0}" {
		t.Fatal("bootstrap invented session or repeated delivery", string(observed["sessions"]), len(committed))
	}
	post("/__a01/oversize", map[string]string{"execution": ids["execution"]}, false)
	if _, code := call("bfb_get_context", "native-oversize-01", nil); code != "request_rejected" {
		t.Fatal("oversized escaped context not denied", code)
	}
	oversized := post("/__a01/observe", map[string]string{"execution": ids["execution"]}, false)
	if string(oversized["deliveries"]) != string(observed["deliveries"]) {
		t.Fatal("oversized context committed partial deliveries")
	}
	// Knowing the correlation is insufficient outside the verified kernel group.
	_, err = daemon.Call(ctx, paths, "mcp.get_context", map[string]any{"agent_request": map[string]any{"correlation": "a01-synthetic-correlation", "request": map[string]any{"schema_version": 1, "run_execution_id": ids["execution"], "assignment_generation": 1, "request_id": "foreign-peer-01"}}})
	if daemon.AsFailure(err).Code != "peer_denied" {
		t.Fatal("daemon accepted foreign native caller", err)
	}
	for _, attack := range []struct {
		correlation string
		generation  int
		code        string
	}{{"wrong-synthetic-correlation", 1, "correlation_rejected"}, {"a01-synthetic-correlation", 2, "assignment_unknown"}} {
		payload, _ := json.Marshal(map[string]any{"agent_request": map[string]any{"correlation": attack.correlation, "request": map[string]any{"schema_version": 1, "run_execution_id": ids["execution"], "assignment_generation": attack.generation, "request_id": "owned-caller-01"}}})
		_, _ = io.WriteString(stdin, "__ipc:"+string(payload)+"\n")
		line, err := reader.ReadString('\n')
		if err != nil || line != "IPC:"+attack.code+"\n" {
			t.Fatal("owned caller boundary not denied", attack.code, err, line)
		}
	}
	for _, closure := range []struct{ kind, code string }{{"end", "assignment_ended"}, {"result", "capability_closed"}, {"lease", "capability_closed"}, {"grant", "revoked"}} {
		if _, err := db.Exec(`UPDATE local_execution_assignments SET state='ended' WHERE execution_id=?`, ids["execution"]); err != nil {
			t.Fatal(err)
		}
		fresh := post("/__a01/seed", map[string]string{"runner": enrollment.RunnerID}, false)
		ids = map[string]string{}
		for key, value := range fresh {
			var id string
			_ = json.Unmarshal(value, &id)
			ids[key] = id
		}
		seedLocal()
		scope, _ := json.Marshal(map[string]string{"BFB_WORKSPACE_ID": ids["workspace"], "BFB_PROJECT_ID": ids["project"], "BFB_TASK_ID": ids["task"], "BFB_RUN_ID": ids["run"], "BFB_RUN_EXECUTION_ID": ids["execution"], "BFB_CHECKOUT_ID": ids["checkout"], "BFB_RUNNER_ID": ids["runner"]})
		_, _ = io.WriteString(stdin, "__scope:"+string(scope)+"\n")
		line, err := reader.ReadString('\n')
		if err != nil || line != "SCOPED\n" {
			t.Fatal("fixture scope switch failed", err, line)
		}
		restart("__start")
		requestID := "cached-closure-" + closure.kind
		if _, code := call("bfb_get_context", requestID, nil); code != "" {
			t.Fatal("fresh context failed", closure.kind, code)
		}
		post("/__a01/change", map[string]string{"execution": ids["execution"], "kind": closure.kind}, false)
		if _, code := call("bfb_get_context", requestID, nil); code != closure.code {
			t.Fatal("cached context skipped current authority", closure.kind, code)
		}
		if _, code := call("bfb_get_task", "sticky-closure-"+closure.kind, nil); code != "capability_closed" {
			t.Fatal("authority denial not sticky", closure.kind, code)
		}
	}
	t.Log("A01_NATIVE_PROOF_COMPLETE")
}
