// ABOUTME: Verifies compiled MCP stdio through signed daemon IPC and authenticated Worker/D1 work commands.
// ABOUTME: Uses a synthetic provider-shaped process group, exact Keychain cleanup and no live turns.

//go:build darwin && cgo

package agentwork

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"database/sql"
	"encoding/base64"
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
	"sync/atomic"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/auth"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/localmcp"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/runner"
	"github.com/qdis/bfb/internal/supervisor"
	"golang.org/x/sys/unix"
)

var nativeCorrelation = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte("A"), 32))

func nativeFixtureProcess(pid int) (supervisor.Process, error) {
	row, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil || row == nil {
		return supervisor.Process{}, fmt.Errorf("native identity unavailable")
	}
	return supervisor.Process{PID: pid, ParentPID: int(row.Eproc.Ppid), GroupID: int(row.Eproc.Pgid), UID: int(row.Eproc.Ucred.Uid),
		StartIdentity: fmt.Sprintf("%d:%d", row.Proc.P_starttime.Sec, row.Proc.P_starttime.Usec)}, nil
}

func waitFixtureLockFree(root, hash string) error {
	name := filepath.Join(root, "worktree-locks", strings.TrimPrefix(hash, "sha256:")+".lock")
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		fd, err := unix.Open(name, unix.O_RDONLY|unix.O_NOFOLLOW, 0)
		if err != nil {
			return err
		}
		err = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
		_ = unix.Close(fd)
		if err == nil {
			return nil
		}
		time.Sleep(time.Millisecond)
	}
	return fmt.Errorf("fixture lock remained held")
}

// TestMCPProviderProcess is a subprocess fixture, never a real coding provider.
func TestMCPProviderProcess(t *testing.T) {
	if os.Getenv("BFB_A01_PROVIDER_FIXTURE") != "1" {
		t.Skip("provider-shaped subprocess only")
	}
	facts, err := nativeFixtureProcess(os.Getpid())
	if err != nil {
		os.Exit(2)
	}
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
		} else if strings.HasPrefix(line, "__hook:") {
			hook := exec.Command(os.Getenv("BFB_A01_BINARY"), "--data-dir", os.Getenv("BFB_A01_ROOT"), "hook", "ingest", "--provider", "fake")
			for _, entry := range os.Environ() {
				key, _, _ := strings.Cut(entry, "=")
				if !strings.HasPrefix(key, "BFB_A01_") {
					hook.Env = append(hook.Env, entry)
				}
			}
			hook.Stdin = strings.NewReader(strings.TrimPrefix(line, "__hook:"))
			result, err := hook.CombinedOutput()
			if err != nil || !bytes.Contains(result, []byte(`"hook_status":"accepted"`)) {
				fmt.Fprintln(os.Stderr, "trusted hook failed", err, string(result))
				os.Exit(2)
			}
			fmt.Println("HOOKED")
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
	if _, present := payload["agent_comment_request"]; present {
		_, err = daemon.CallAgent(context.Background(), paths, "mcp.v2.add_comment", payload)
	} else {
		_, err = daemon.Call(context.Background(), paths, "mcp.authority", payload)
	}
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
	var loseReply atomic.Pointer[string]
	type historyFault struct {
		db                         *sql.DB
		execution, history, action string
	}
	var duringCloud atomic.Pointer[historyFault]
	type lockFault struct {
		input      io.Writer
		root, hash string
	}
	var releaseDuringCloud atomic.Pointer[lockFault]
	var challengeCount, challengeWindow atomic.Int64
	proxy.ModifyResponse = func(response *http.Response) error {
		path := response.Request.URL.Path
		if strings.HasSuffix(path, "/challenge") && response.StatusCode == 200 {
			challengeWindow.CompareAndSwap(0, time.Now().UnixNano())
			challengeCount.Add(1)
		}
		if response.StatusCode >= 400 && !strings.Contains(path, "/work/") {
			t.Log("synthetic channel denial", filepath.Base(path), response.StatusCode)
		}
		if strings.Contains(path, "/work/") {
			t.Log("synthetic work reply", filepath.Base(path), response.StatusCode)
		}
		if response.StatusCode == 200 && strings.Contains(path, "/work/") {
			if strings.HasSuffix(path, "/work/comment") {
				if fault := releaseDuringCloud.Swap(nil); fault != nil {
					if _, err := io.WriteString(fault.input, "__unlock\n"); err != nil {
						return err
					}
					if err := waitFixtureLockFree(fault.root, fault.hash); err != nil {
						return err
					}
				}
			}
			if fault := duringCloud.Load(); fault != nil && strings.HasSuffix(path, "/work/"+fault.action) && duringCloud.CompareAndSwap(fault, nil) {
				if _, err := fault.db.Exec("INSERT OR REPLACE INTO execution_native_history (execution_id,history_json) VALUES (?,?)", fault.execution, fault.history); err != nil {
					return err
				}
			}
			if action := loseReply.Load(); action != nil && strings.HasSuffix(path, "/work/"+*action) && loseReply.CompareAndSwap(action, nil) {
				_ = response.Body.Close()
				return fmt.Errorf("synthetic committed response loss")
			}
		}
		return nil
	}
	proxy.ErrorHandler = func(writer http.ResponseWriter, _ *http.Request, _ error) {
		writer.WriteHeader(503)
		_, _ = writer.Write([]byte(`{"error":"work_unavailable"}`))
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
	template, err := os.ReadFile(filepath.Join(repo, "protocol/fixtures/v1/valid/launch-claim-result.c09-synthetic.json"))
	if err != nil {
		t.Fatal(err)
	}
	fixture := post("/__a01/seed", map[string]string{"runner": enrollment.RunnerID, "claim_template": string(template)}, false)
	var claim generated.LaunchClaimResult
	if json.Unmarshal(fixture["claim"], &claim) != nil {
		t.Fatal("closed claim missing")
	}
	ids := map[string]string{}
	for key, value := range fixture {
		var id string
		_ = json.Unmarshal(value, &id)
		ids[key] = id
	}
	// The caller deliberately receives only scoped assignment values, not test cookie, key or token.
	lockBinding := func() string {
		data, _ := json.Marshal(supervisor.LockBinding{ExecutionID: ids["execution"], AssignmentGeneration: 1, FencingGeneration: claim.FencingGeneration, PhysicalWorktreeHash: ids["physical"]})
		return string(data)
	}
	provider := exec.CommandContext(ctx, dae, "fixture-supervise", paths.Root, os.Args[0], "-test.run=^TestMCPProviderProcess$", lockBinding())
	for _, key := range []string{"PATH", "TMPDIR", "LANG", "LC_ALL", "DEVELOPER_DIR"} {
		if value, present := os.LookupEnv(key); present {
			provider.Env = append(provider.Env, key+"="+value)
		}
	}
	for key, value := range map[string]string{"BFB_A01_PROVIDER_FIXTURE": "1", "BFB_A01_BINARY": binary, "BFB_A01_ROOT": paths.Root, "BFB_WORKSPACE_ID": ids["workspace"], "BFB_PROJECT_ID": ids["project"], "BFB_TASK_ID": ids["task"], "BFB_RUN_ID": ids["run"], "BFB_RUN_EXECUTION_ID": ids["execution"], "BFB_ASSIGNMENT_GENERATION": "1", "BFB_CHECKOUT_ID": ids["checkout"], "BFB_RUNNER_ID": ids["runner"], "BFB_CORRELATION_TOKEN": nativeCorrelation, "BFB_ARTIFACTS_DIR": directory} {
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
	var owned struct {
		Leader supervisor.Process            `json:"leader"`
		Owner  supervisor.SupervisorIdentity `json:"owner"`
		LockID string                        `json:"lock_id"`
	}
	if json.Unmarshal(line, &owned) != nil || owned.LockID == "" {
		t.Fatal("missing native fixture identity")
	}
	leader := owned.Leader
	group, _ := json.Marshal(leader)
	supervisorJSON, _ := json.Marshal(owned.Owner)
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
		now := claim.Assignment.CreatedAt
		expires := claim.Specification.ExpiresAt
		claimJSON, _ := json.Marshal(claim)
		digest := sha256.Sum256([]byte(ids["launch"]))
		intent := fmt.Sprintf("00000000-0000-4000-8000-%x", digest[:6])
		if _, err := tx.Exec(`INSERT INTO execution_commands (runner_id,command_id,workspace_id,command_kind,expires_at,received_at,claim_key,claim_started_at,state) VALUES (?,?,?,'launch',?,?,?,?,'queued')`, ids["runner"], ids["launch"], ids["workspace"], expires, now, "synthetic", now); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(`INSERT INTO local_execution_assignments (execution_id,assignment_generation,workspace_id,project_id,task_id,run_id,runner_id,checkout_id,launch_id,intent_id,physical_worktree_hash,fencing_generation,claim_json,provider_identity_hash,correlation_token,created_at,expires_at,state,owned_group_json,supervisor_json,local_lock_id) VALUES (?,1,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,'running',?,?,?)`, ids["execution"], ids["workspace"], ids["project"], ids["task"], ids["run"], ids["runner"], ids["checkout"], ids["launch"], intent, ids["physical"], string(claimJSON), "sha256:"+strings.Repeat("a", 64), nativeCorrelation, now, expires, string(group), string(supervisorJSON), owned.LockID); err != nil {
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
	for tool, arguments := range map[string]map[string]any{"bfb_update_task": {"expected_version": 1, "title": "Denied synthetic title"}, "bfb_report_progress": {"summary": "Denied synthetic checkpoint", "percent": 12.5, "confidence": 0.75}, "bfb_propose_task": {"title": "Denied synthetic proposal"}} {
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
	hook := func(session string) {
		t.Helper()
		data, _ := json.Marshal(map[string]string{"kind": "turn_started", "session_id": session, "source_event_id": "a01-turn-before-start"})
		_, _ = io.WriteString(stdin, "__hook:"+string(data)+"\n")
		line, err := reader.ReadString('\n')
		if err != nil || line != "HOOKED\n" {
			t.Fatal("production L06 hook capture failed", err, line)
		}
		var providerName, observedID string
		if err := db.QueryRow("SELECT provider,session_id FROM hook_observed_sessions WHERE execution_id=? AND assignment_generation=1", ids["execution"]).Scan(&providerName, &observedID); err != nil || providerName != "fake" || observedID != session {
			t.Fatal("trusted turn-before-start missing", err)
		}
	}
	restartBoth := func() {
		t.Helper()
		status, err := daemon.Call(ctx, paths, "daemon.status", nil)
		if err != nil {
			t.Fatal(err)
		}
		previousPID := status.Payload["daemon_pid"]
		command("/bin/launchctl", "kickstart", "-k", fmt.Sprintf("gui/%d/%s", os.Getuid(), label))
		wait("restarted signed daemon", func() bool {
			status, err := daemon.Call(ctx, paths, "daemon.status", nil)
			return err == nil && status.Payload["daemon_pid"] != previousPID
		})
		wait("Keychain-backed runner reconnect", func() bool {
			list, err := daemon.Call(ctx, paths, "runner.list", nil)
			if err != nil {
				return false
			}
			data, _ := json.Marshal(list.Payload["enrollments"])
			var entries []runner.Enrollment
			if json.Unmarshal(data, &entries) != nil {
				return false
			}
			for _, entry := range entries {
				if entry.RunnerID == enrollment.RunnerID && entry.State == "online" {
					return true
				}
			}
			return false
		})
		restart("__restart")
	}
	hook("synthetic-native-session")
	// Drop the response only after the actual Hub/D1 commit, then restart both peers.
	action := "session-bind"
	loseReply.Store(&action)
	body := "A01_PRIVATE_BODY_CANARY_" + strings.Repeat("<", 2024)
	if len([]rune(body)) != 2048 {
		t.Fatal("maximum body fixture changed")
	}
	if _, code := call("bfb_add_comment", "native-comment-01", map[string]any{"body": body}); code != "offline_rejected" {
		t.Fatal("lost binding reply not retryable", code)
	}
	afterBinding := post("/__a01/observe", map[string]string{"execution": ids["execution"]}, false)
	var bindings []map[string]any
	_ = json.Unmarshal(afterBinding["bindings"], &bindings)
	if len(bindings) != 1 || string(afterBinding["comments"]) != "[]" {
		t.Fatal("binding loss did not commit exactly the binding")
	}
	sessionID := bindings[0]["provider_session_id"].(string)
	restartBoth()
	firstComment, code := call("bfb_add_comment", "native-comment-01", map[string]any{"body": body})
	if code != "" {
		t.Fatal("binding confirmation retry after both restarts", code)
	}
	action = "comment"
	loseReply.Store(&action)
	secondBody := "Synthetic committed comment response loss"
	if _, code := call("bfb_add_comment", "native-comment-02", map[string]any{"body": secondBody}); code != "offline_rejected" {
		t.Fatal("lost committed comment reply not retryable", code)
	}
	lostComment := post("/__a01/observe", map[string]string{"execution": ids["execution"]}, false)
	var comments, effects []map[string]any
	_ = json.Unmarshal(lostComment["comments"], &comments)
	_ = json.Unmarshal(lostComment["effects"], &effects)
	if len(comments) != 2 || len(effects) != 2 {
		t.Fatal("uncertain comment outcome did not commit one canonical effect")
	}
	restartBoth()
	retried, code := call("bfb_add_comment", "native-comment-02", map[string]any{"body": secondBody})
	if code != "" {
		t.Fatal("comment retry after both restarts", code)
	}
	again, code := call("bfb_add_comment", "native-comment-01", map[string]any{"body": body})
	if code != "" || again["id"] != firstComment["id"] {
		t.Fatal("escaped maximum body replay changed", code)
	}
	if _, code := call("bfb_add_comment", "native-comment-02", map[string]any{"body": "Changed synthetic body"}); code != "request_rejected" {
		t.Fatal("reused write identity lost input binding", code)
	}
	// Even a genuine owned kernel peer cannot replace the daemon-read L06
	// observation while reusing the original committed comment identity.
	changedSession, _ := json.Marshal(map[string]any{"agent_comment_request": generated.AgentCommentLocalRequest{
		Correlation: nativeCorrelation, Request: generated.AgentCommentRequest{
			Reference: generated.AgentWorkRequest{SchemaVersion: 1, RunExecutionId: ids["execution"], AssignmentGeneration: 1, RequestId: "native-comment-02"},
			Binding:   generated.AgentSessionReference{ProviderSessionId: sessionID, Provider: "fake", ObservedSessionId: "synthetic-changed-session"}, Body: secondBody,
		},
	}})
	_, _ = io.WriteString(stdin, "__ipc:"+string(changedSession)+"\n")
	changedReply, changedError := reader.ReadString('\n')
	if changedError != nil || changedReply != "IPC:session_conflict\n" {
		t.Fatal("owned caller changed captured session after restart", changedError, changedReply)
	}
	finalComment := post("/__a01/observe", map[string]string{"execution": ids["execution"]}, false)
	_ = json.Unmarshal(finalComment["comments"], &comments)
	_ = json.Unmarshal(finalComment["effects"], &effects)
	_ = json.Unmarshal(finalComment["bindings"], &bindings)
	if len(comments) != 2 || len(effects) != 2 || len(bindings) != 1 || bindings[0]["provider_session_id"] != sessionID {
		t.Fatal("restarts duplicated conversation/effects")
	}
	foundMaximum := false
	foundLost := false
	for _, comment := range comments {
		if comment["author_human_id"] != nil || comment["author_delegation_id"] != nil {
			t.Fatal("agent impersonated human")
		}
		if comment["id"] == firstComment["id"] && comment["body"] == body {
			foundMaximum = true
		}
		if comment["id"] == retried["id"] && comment["body"] == secondBody {
			foundLost = true
		}
	}
	for _, effect := range effects {
		if effect["run_id"] != ids["run"] || effect["execution_id"] != ids["execution"] || effect["provider_session_id"] != sessionID || effect["source_task_id"] != ids["task"] || effect["target_task_id"] != ids["task"] {
			t.Fatal("untruthful committed provenance")
		}
	}
	if !foundMaximum || !foundLost || bytes.Contains(finalComment["receipts"], []byte("A01_PRIVATE_BODY_CANARY")) || bytes.Contains(finalComment["receipts"], []byte(secondBody)) {
		t.Fatal("body round-trip/receipt boundary failed")
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
	_, err = daemon.Call(ctx, paths, "mcp.get_context", map[string]any{"agent_request": map[string]any{"correlation": nativeCorrelation, "request": map[string]any{"schema_version": 1, "run_execution_id": ids["execution"], "assignment_generation": 1, "request_id": "foreign-peer-01"}}})
	if daemon.AsFailure(err).Code != "peer_denied" {
		t.Fatal("daemon accepted foreign native caller", err)
	}
	for _, attack := range []struct {
		correlation string
		generation  int
		code        string
	}{{"wrong-synthetic-correlation", 1, "correlation_rejected"}, {nativeCorrelation, 2, "assignment_unknown"}} {
		payload, _ := json.Marshal(map[string]any{"agent_request": map[string]any{"correlation": attack.correlation, "request": map[string]any{"schema_version": 1, "run_execution_id": ids["execution"], "assignment_generation": attack.generation, "request_id": "owned-caller-01"}}})
		_, _ = io.WriteString(stdin, "__ipc:"+string(payload)+"\n")
		line, err := reader.ReadString('\n')
		if err != nil || line != "IPC:"+attack.code+"\n" {
			t.Fatal("owned caller boundary not denied", attack.code, err, line)
		}
	}
	freshScope := func() {
		t.Helper()
		// This expanded fixture makes more signed calls than one production
		// minute admits. Pace real traffic; never reset or bypass server budgets.
		if start := challengeWindow.Load(); start != 0 && challengeCount.Load() >= 80 {
			remaining := time.Until(time.Unix(0, start).Add(61 * time.Second))
			if remaining > 0 {
				t.Log("pacing synthetic challenge traffic", challengeCount.Load(), remaining.Round(time.Second))
				timer := time.NewTimer(remaining)
				select {
				case <-timer.C:
				case <-ctx.Done():
					timer.Stop()
					t.Fatal("native challenge pacing timed out")
				}
			}
			challengeWindow.Store(0)
			challengeCount.Store(0)
		}
		if _, err := db.Exec(`UPDATE local_execution_assignments SET state='ended' WHERE execution_id=?`, ids["execution"]); err != nil {
			t.Fatal(err)
		}
		fresh := post("/__a01/seed", map[string]string{"runner": enrollment.RunnerID, "claim_template": string(template)}, false)
		if json.Unmarshal(fresh["claim"], &claim) != nil {
			t.Fatal("fresh claim missing")
		}
		ids = map[string]string{}
		for key, value := range fresh {
			var id string
			_ = json.Unmarshal(value, &id)
			ids[key] = id
		}
		_, _ = io.WriteString(stdin, "__ownership:"+lockBinding()+"\n")
		ownershipLine, ownershipErr := reader.ReadBytes('\n')
		if ownershipErr != nil || json.Unmarshal(ownershipLine, &owned) != nil || owned.LockID == "" || owned.Leader != leader {
			t.Fatal("fresh signed helper lock missing", ownershipErr)
		}
		seedLocal()
		scope, _ := json.Marshal(map[string]string{"BFB_WORKSPACE_ID": ids["workspace"], "BFB_PROJECT_ID": ids["project"], "BFB_TASK_ID": ids["task"], "BFB_RUN_ID": ids["run"], "BFB_RUN_EXECUTION_ID": ids["execution"], "BFB_CHECKOUT_ID": ids["checkout"], "BFB_RUNNER_ID": ids["runner"]})
		_, _ = io.WriteString(stdin, "__scope:"+string(scope)+"\n")
		line, err := reader.ReadString('\n')
		if err != nil || line != "SCOPED\n" {
			t.Fatal("fixture scope switch failed", err, line)
		}
		restart("__start")
	}
	rows := func(observed map[string]json.RawMessage, key string) []map[string]any {
		t.Helper()
		var values []map[string]any
		if err := json.Unmarshal(observed[key], &values); err != nil {
			t.Fatal(err)
		}
		return values
	}
	observedTask := func(observed map[string]json.RawMessage) map[string]any {
		t.Helper()
		var business map[string]any
		if err := json.Unmarshal(observed["business"], &business); err != nil {
			t.Fatal(err)
		}
		return business["task"].(map[string]any)
	}
	privateTitle := "A01_PRIVATE_TITLE_CANARY_"
	privateTitle += strings.Repeat("<", 512-len(privateTitle))
	for _, effect := range []struct{ action, tool, kind string }{
		{"update", "bfb_update_task", "task.update"},
		{"progress", "bfb_report_progress", "progress.report"},
		{"proposal", "bfb_propose_task", "task.propose"},
	} {
		freshScope()
		hook("synthetic-online-" + effect.action)
		before := post("/__a01/observe", map[string]string{"execution": ids["execution"]}, false)
		beforeTask := observedTask(before)
		params := map[string]any{}
		switch effect.action {
		case "update":
			params = map[string]any{"expected_version": 1, "title": privateTitle, "punchline": strings.Repeat(">", 512)}
		case "progress":
			params = map[string]any{"summary": body, "percent": 12.5, "confidence": 0.75}
			for index, invalid := range []map[string]any{
				{"summary": "Synthetic rejected checkpoint", "percent": json.Number("100.00000000000000001")},
				{"summary": "Synthetic rejected checkpoint", "confidence": json.Number("1.00000000000000001")},
				{"summary": "Synthetic rejected checkpoint", "percent": json.Number("1e-324")},
			} {
				if _, code := call(effect.tool, fmt.Sprintf("native-progress-invalid-%d", index), invalid); code != "invalid_params" {
					t.Fatal("compiled stdio rounded forbidden progress", index, code)
				}
			}
			unchanged := post("/__a01/observe", map[string]string{"execution": ids["execution"]}, false)
			if string(unchanged["effects"]) != string(before["effects"]) || string(unchanged["bindings"]) != string(before["bindings"]) || string(unchanged["business"]) != string(before["business"]) {
				t.Fatal("rejected raw progress changed canonical state")
			}
		case "proposal":
			params = map[string]any{"parent_task_id": ids["task"], "title": privateTitle}
		}
		requestID := "native-online-" + effect.action
		action := effect.action
		loseReply.Store(&action)
		if _, code := call(effect.tool, requestID, params); code != "offline_rejected" {
			t.Fatal("committed online write loss not retryable", effect.action, code)
		}
		committed := post("/__a01/observe", map[string]string{"execution": ids["execution"]}, false)
		effects := rows(committed, "effects")
		bindings := rows(committed, "bindings")
		if len(effects) != 1 || len(bindings) != 1 {
			t.Fatal("lost online write did not commit one effect/binding", effect.action)
		}
		origin := effects[0]
		if origin["kind"] != effect.kind || origin["run_id"] != ids["run"] || origin["execution_id"] != ids["execution"] || origin["source_task_id"] != ids["task"] || origin["provider_session_id"] != bindings[0]["provider_session_id"] {
			t.Fatal("online write provenance escaped bound origin", effect.action)
		}
		switch effect.action {
		case "update":
			updated := observedTask(committed)
			if updated["title"] != params["title"] || updated["punchline"] != params["punchline"] || updated["resource_version"] != float64(2) || origin["resulting_task_version"] != float64(2) || origin["target_task_id"] != ids["task"] {
				t.Fatal("compiled update did not retain bounded fields/version")
			}
			for _, key := range []string{"state", "priority", "next_owner_type", "next_owner_id", "next_action_reason", "due_at", "created_by_human_id", "created_by_delegation_id"} {
				if updated[key] != beforeTask[key] {
					t.Fatal("agent erased creator/workflow field", key)
				}
			}
		case "progress":
			comments := rows(committed, "comments")
			if len(comments) != 1 || comments[0]["body"] != body || comments[0]["kind"] != "progress" || comments[0]["author_human_id"] != nil || comments[0]["author_delegation_id"] != nil || origin["percent"] != 12.5 || origin["confidence"] != 0.75 || origin["target_task_id"] != ids["task"] {
				t.Fatal("compiled fractional progress lost payload/attribution")
			}
		case "proposal":
			targets := rows(committed, "targets")
			if len(targets) != 1 || targets[0]["id"] == ids["task"] || targets[0]["id"] != origin["target_task_id"] || targets[0]["parent_task_id"] != ids["task"] || targets[0]["title"] != params["title"] || targets[0]["state"] != "ready" || targets[0]["priority"] != "P2" || targets[0]["created_by_human_id"] != nil || targets[0]["created_by_delegation_id"] != nil {
				t.Fatal("compiled child proposal lost source/target semantics")
			}
		}
		if bytes.Contains(committed["receipts"], []byte("A01_PRIVATE_TITLE_CANARY")) || bytes.Contains(committed["receipts"], []byte("A01_PRIVATE_BODY_CANARY")) {
			t.Fatal("private write content entered receipts")
		}
		restartBoth()
		retried, code := call(effect.tool, requestID, params)
		if code != "" {
			t.Fatal("online write retry after both restarts", effect.action, code)
		}
		if effect.action == "update" && (retried["resource_version"] != float64(2) || retried["id"] != ids["task"]) || effect.action == "progress" && retried["id"] != origin["comment_id"] || effect.action == "proposal" && (retried["id"] != origin["target_task_id"] || retried["state"] != "ready") {
			t.Fatal("retry changed canonical outcome", effect.action)
		}
		unchanged := post("/__a01/observe", map[string]string{"execution": ids["execution"]}, false)
		if string(unchanged["effects"]) != string(committed["effects"]) || string(unchanged["bindings"]) != string(committed["bindings"]) || string(unchanged["business"]) != string(committed["business"]) {
			t.Fatal("restarts repeated online business effects", effect.action)
		}
		restart("__restart")
		changed := map[string]any{}
		for key, value := range params {
			changed[key] = value
		}
		if effect.action == "progress" {
			changed["confidence"] = 0.5
		} else {
			changed["title"] = "Changed synthetic title"
		}
		if _, code := call(effect.tool, requestID, changed); code != "request_rejected" {
			t.Fatal("cache loss forgot online payload fingerprint", effect.action, code)
		}
		if effect.action == "update" {
			if _, code := call(effect.tool, requestID+"-later", map[string]any{"expected_version": 2, "title": "Synthetic later revision"}); code != "" {
				t.Fatal("later task revision failed", code)
			}
			if previous, code := call(effect.tool, requestID, params); code != "" || previous["resource_version"] != float64(2) {
				t.Fatal("committed update reran stale version check", code)
			}
		}
		if effect.action == "proposal" {
			post("/__a01/change", map[string]string{"execution": ids["execution"], "kind": "root_allow"}, false)
			rootParams := map[string]any{"title": "Synthetic permitted root"}
			if root, code := call(effect.tool, requestID+"-root", rootParams); code != "" || root["state"] != "proposed" {
				t.Fatal("root proposal state/policy mismatch", code)
			}
			post("/__a01/change", map[string]string{"execution": ids["execution"], "kind": "root_deny"}, false)
			if _, code := call(effect.tool, requestID+"-root", rootParams); code != "forbidden" {
				t.Fatal("cached root ignored current policy", code)
			}
			if child, code := call(effect.tool, requestID, params); code != "" || child["state"] != "ready" {
				t.Fatal("child replay acquired root-only policy", code)
			}
		}
	}
	for _, closure := range []struct{ kind, code string }{{"session", "capability_closed"}, {"end", "assignment_ended"}, {"result", "capability_closed"}, {"lease", "capability_closed"}, {"history_before", "assignment_ended"}, {"history_during", "assignment_ended"}, {"history_write", "assignment_ended"}, {"lock_before", "assignment_ended"}, {"lock_write", "assignment_ended"}, {"grant", "revoked"}} {
		freshScope()
		requestID := "cached-closure-" + closure.kind
		hook("synthetic-session-" + closure.kind)
		if _, code := call("bfb_add_comment", requestID, map[string]any{"body": "Synthetic cached closure comment"}); code != "" {
			t.Fatal("fresh bound comment failed", closure.kind, code)
		}
		if _, code := call("bfb_get_context", requestID, nil); code != "request_rejected" {
			t.Fatal("cached write identity accepted across tools", closure.kind, code)
		}
		retained, retainedError := supervisor.NewGroup(leader)
		if retainedError != nil {
			t.Fatal(retainedError)
		}
		retained.Unknown = true
		if closure.kind == "lock_before" {
			_, _ = io.WriteString(stdin, "__unlock\n")
			if err := waitFixtureLockFree(paths.Root, ids["physical"]); err != nil {
				t.Fatal(err)
			}
			var state, history string
			if err := db.QueryRow("SELECT assignment.state, history.history_json FROM local_execution_assignments assignment JOIN execution_native_history history ON history.execution_id=assignment.execution_id WHERE assignment.execution_id=?", ids["execution"]).Scan(&state, &history); err != nil || state != "running" || strings.Contains(history, `"uncertain":true`) {
				t.Fatal("free-lock test did not isolate fresh inspection", err, state)
			}
		} else if closure.kind == "lock_write" {
			releaseDuringCloud.Store(&lockFault{input: stdin, root: paths.Root, hash: ids["physical"]})
		} else if closure.kind == "history_before" {
			retained.HadEscape = true
			history, _ := json.Marshal(map[string]any{"uncertain": true, "group": retained})
			if _, err := db.Exec("INSERT OR REPLACE INTO execution_native_history (execution_id,history_json) VALUES (?,?)", ids["execution"], string(history)); err != nil {
				t.Fatal(err)
			}
		} else if closure.kind == "history_during" || closure.kind == "history_write" {
			retained.Incomplete = true
			history, _ := json.Marshal(map[string]any{"uncertain": true, "group": retained})
			action := "bound-authority"
			if closure.kind == "history_write" {
				action = "comment"
			}
			duringCloud.Store(&historyFault{db: db, execution: ids["execution"], history: string(history), action: action})
		} else {
			post("/__a01/change", map[string]string{"execution": ids["execution"], "kind": closure.kind}, false)
		}
		if closure.kind == "history_write" || closure.kind == "lock_write" {
			requestID += "-new"
		}
		if _, code := call("bfb_add_comment", requestID, map[string]any{"body": "Synthetic cached closure comment"}); code != closure.code {
			t.Fatal("cached comment skipped current bound authority", closure.kind, code)
		}
		if closure.kind == "history_write" || closure.kind == "lock_write" {
			committed := post("/__a01/observe", map[string]string{"execution": ids["execution"]}, false)
			var retainedComments, retainedEffects []map[string]any
			_ = json.Unmarshal(committed["comments"], &retainedComments)
			_ = json.Unmarshal(committed["effects"], &retainedEffects)
			if len(retainedComments) != 2 || len(retainedEffects) != 2 {
				t.Fatal("post-commit denial incorrectly lost the canonical effect")
			}
		}
		if _, code := call("bfb_get_task", "sticky-closure-"+closure.kind, nil); code != "capability_closed" {
			t.Fatal("authority denial not sticky", closure.kind, code)
		}
	}
	t.Log("A01_NATIVE_PROOF_COMPLETE")
}
