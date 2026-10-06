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
	"errors"
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
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers"
	"github.com/qdis/bfb/internal/providers/fake"
	"github.com/qdis/bfb/internal/runner"
	"github.com/qdis/bfb/internal/supervisor"
	"golang.org/x/sys/unix"
)

var nativeCorrelation = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte("A"), 32))

// Only this synthetic executable answers fake-provider probes. The running
// provider-shaped child remains the same native image verified by L05.
func TestMain(tests *testing.M) {
	if os.Getenv("BFB_A01_PROVIDER_FIXTURE") == "1" && len(os.Args) == 2 {
		switch os.Args[1] {
		case "--version":
			fmt.Println("bfb-fake-provider 1.0.0")
			os.Exit(0)
		case "--probe":
			data, _ := json.Marshal(map[string]any{"healthy": true, "capabilities": fake.Capabilities()})
			fmt.Println(string(data))
			os.Exit(0)
		}
	}
	os.Exit(tests.Run())
}

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
		if strings.HasPrefix(line, "__submit:") {
			var args []string
			if json.Unmarshal([]byte(strings.TrimPrefix(line, "__submit:")), &args) != nil {
				os.Exit(2)
			}
			command := exec.Command(os.Getenv("BFB_A01_BINARY"), append([]string{"--data-dir", os.Getenv("BFB_A01_ROOT"), "run", "submit"}, args...)...)
			for _, entry := range os.Environ() {
				key, _, _ := strings.Cut(entry, "=")
				if !strings.HasPrefix(key, "BFB_A01_") {
					command.Env = append(command.Env, entry)
				}
			}
			output, err := command.Output()
			status := 0
			if err != nil {
				var exit *exec.ExitError
				if !errors.As(err, &exit) {
					os.Exit(2)
				}
				status = exit.ExitCode()
			}
			if !json.Valid(bytes.TrimSpace(output)) {
				os.Exit(2)
			}
			data, _ := json.Marshal(map[string]any{"status": status, "output": json.RawMessage(bytes.TrimSpace(output))})
			fmt.Println("CLI:" + string(data))
		} else if strings.HasPrefix(line, "__ipc:") {
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
		} else if line == "__stop" {
			if child != nil {
				_ = input.Close()
				if child.Wait() != nil {
					os.Exit(2)
				}
				child, input = nil, nil
			}
			fmt.Println("STOPPED")
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
	ctx, cancel := context.WithTimeout(context.Background(), 9*time.Minute)
	defer cancel()
	attentionScenario := os.Getenv("BFB_A02_NATIVE_SCENARIO") == "1"
	resultScenario := os.Getenv("BFB_A03_NATIVE_SCENARIO") == "1"
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
	var workOutage atomic.Bool
	var resultProofOutage atomic.Bool
	var outageOnLoss atomic.Bool
	var replayResponses atomic.Int64
	var resultConfirmations atomic.Int64
	var businessRequests atomic.Int64
	var attentionReads atomic.Int64
	var slowAttentionRead atomic.Bool
	type historyFault struct {
		db                         *sql.DB
		execution, history, action string
	}
	var duringCloud atomic.Pointer[historyFault]
	type lockFault struct {
		input      io.Writer
		root, hash string
		action     string
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
			if strings.HasSuffix(path, "/work/result-confirmation") {
				resultConfirmations.Add(1)
			}
			if strings.HasSuffix(path, "/work/attention-get") && slowAttentionRead.Swap(false) {
				timer := time.NewTimer(32 * time.Second)
				defer timer.Stop()
				select {
				case <-timer.C:
				case <-response.Request.Context().Done():
					_ = response.Body.Close()
					return response.Request.Context().Err()
				}
			}
			if strings.HasSuffix(path, "/work/replay") || strings.HasSuffix(path, "/work/result-replay") {
				replayResponses.Add(1)
			}
			if fault := releaseDuringCloud.Load(); fault != nil {
				action := fault.action
				if action == "" {
					action = "comment"
				}
				if strings.HasSuffix(path, "/work/"+action) && releaseDuringCloud.CompareAndSwap(fault, nil) {
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
				if outageOnLoss.Swap(false) {
					workOutage.Store(true)
				}
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
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if workOutage.Load() && strings.Contains(request.URL.Path, "/work/") || resultProofOutage.Load() && strings.HasSuffix(request.URL.Path, "/work/result-confirmation") {
			writer.WriteHeader(503)
			_, _ = writer.Write([]byte(`{"error":"work_unavailable"}`))
			return
		}
		if strings.HasSuffix(request.URL.Path, "/work/attention-get") {
			attentionReads.Add(1)
		}
		for _, action := range []string{"comment", "update", "progress", "proposal", "replay", "attention-request", "result-submit", "result-replay"} {
			if strings.HasSuffix(request.URL.Path, "/work/"+action) {
				businessRequests.Add(1)
			}
		}
		proxy.ServeHTTP(writer, request)
	}))
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
	config, _ := json.Marshal(map[string]string{"ProxyAddress": server.Listener.Addr().String(), "Certificate": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw})), "ProviderExecutable": os.Args[0]})
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
	post("/__a01/configure", map[string]string{"offline": "deny"}, false)
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
	registry, err := provider.NewRegistry(providers.Descriptors())
	if err != nil {
		t.Fatal(err)
	}
	installation := provider.Installation{Executable: os.Args[0], IntegrationHash: provider.Hash(nil), Environment: []string{"BFB_A01_PROVIDER_FIXTURE=1", "PATH=" + os.Getenv("PATH")}}
	probe, err := registry.Probe(ctx, "fake", installation, time.Now())
	if err != nil || probe.Status != "healthy" {
		t.Fatal("synthetic native image probe", err)
	}
	providerIdentity, err := registry.IdentityHash(probe)
	if err != nil {
		t.Fatal(err)
	}
	var templateClaim generated.LaunchClaimResult
	if json.Unmarshal(template, &templateClaim) != nil {
		t.Fatal("synthetic claim template")
	}
	templateClaim.Snapshot.ProviderManifestId, templateClaim.Snapshot.ProviderVersion = probe.ManifestID, probe.Version
	template, _ = json.Marshal(templateClaim)
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
	workDB, err := sql.Open("sqlite", "file:"+filepath.Join(paths.Root, "local-mcp-journal.sqlite")+"?mode=rw&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	defer workDB.Close()
	type persistedWork struct {
		key, state, effect, request, capture, fingerprint string
		dispatched                                        sql.NullInt64
		reason, outcome                                   sql.NullString
	}
	workRow := func(requestID string) persistedWork {
		t.Helper()
		var row persistedWork
		if err := workDB.QueryRow(`SELECT i.operation_key,d.state,d.effect,i.request_json,i.capture_json,i.fingerprint,d.ever_dispatched_ns,d.reason_code,d.outcome_json
FROM work_intents i JOIN work_delivery d USING(operation_key) WHERE json_extract(i.request_json,'$.reference.request_id')=?`, requestID).Scan(&row.key, &row.state, &row.effect, &row.request, &row.capture, &row.fingerprint, &row.dispatched, &row.reason, &row.outcome); err != nil {
			t.Fatal("durable native work disposition", requestID, err)
		}
		return row
	}
	seedLocal := func(renewLease bool) {
		t.Helper()
		inventoryPath := filepath.Join(paths.Root, "fixture-inventory.json")
		if err := os.WriteFile(inventoryPath+".next", fixture["inventory"], 0600); err != nil {
			t.Fatal("synthetic inventory persistence", err)
		}
		if err := os.Rename(inventoryPath+".next", inventoryPath); err != nil {
			t.Fatal(err)
		}
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
		if _, err := tx.Exec(`INSERT INTO execution_commands (runner_id,command_id,workspace_id,command_kind,expires_at,received_at,claim_key,claim_started_at,state) VALUES (?,?,?,'launch',?,?,?,?,'queued')`, ids["runner"], ids["launch"], ids["workspace"], expires, now, ids["claim_key"], now); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(`INSERT INTO local_execution_assignments (execution_id,assignment_generation,workspace_id,project_id,task_id,run_id,runner_id,checkout_id,launch_id,intent_id,physical_worktree_hash,fencing_generation,claim_json,provider_identity_hash,correlation_token,created_at,expires_at,state,owned_group_json,supervisor_json,local_lock_id) VALUES (?,1,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,'running',?,?,?)`, ids["execution"], ids["workspace"], ids["project"], ids["task"], ids["run"], ids["runner"], ids["checkout"], ids["launch"], intent, ids["physical"], string(claimJSON), providerIdentity, nativeCorrelation, now, expires, string(group), string(supervisorJSON), owned.LockID); err != nil {
			t.Fatal(err)
		}
		commandState := "complete"
		if renewLease {
			commandState = "waiting"
		}
		if _, err := tx.Exec(`UPDATE execution_commands SET state=? WHERE runner_id=? AND command_id=?`, commandState, ids["runner"], ids["launch"]); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
		files, err := supervisor.OpenAssignmentFiles(paths.Root)
		if err != nil {
			t.Fatal(err)
		}
		_, err = files.Prepare(supervisor.LocalAssignment{IntentID: intent, State: "intent_ready", ProviderIdentityHash: providerIdentity, Claim: claim}, registry, probe, repo)
		_ = files.Close()
		if err != nil {
			t.Fatal("synthetic authenticated image preparation", err)
		}
		finalIdentity, _ := json.Marshal(map[string]any{"supervisor": generated.SupervisorIdentity{Pid: int64(owned.Owner.Process.PID), StartIdentity: owned.Owner.Process.StartIdentity, ExecutableHash: owned.Owner.ExecutableHash}, "local_lock_id": owned.LockID})
		post("/__a01/pin", map[string]string{"execution": ids["execution"], "final_identity": string(finalIdentity)}, false)
		if _, err := daemon.Call(ctx, paths, "runner.wake", map[string]any{"runner_id": ids["runner"]}); err != nil {
			t.Fatal("synthetic runner inventory wake", err)
		}
		wait("signed synthetic checkout inventory", func() bool {
			observed := post("/__test/observe", map[string]string{"workspace_id": ids["workspace"], "runner_id": ids["runner"]}, false)
			var inventory generated.RunnerInventory
			return json.Unmarshal(observed["inventory"], &inventory) == nil && len(inventory.Checkouts) == 1 && inventory.Checkouts[0].CheckoutId == ids["checkout"] && inventory.Checkouts[0].PhysicalWorktreeHash == ids["physical"] && inventory.Checkouts[0].RepositoryConfigHash == claim.Snapshot.RepositoryConfigHash
		})
	}
	seedLocal(attentionScenario || resultScenario)
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
	submitCLI := func(args []string) (map[string]any, int) {
		t.Helper()
		data, err := json.Marshal(args)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(stdin, "__submit:"+string(data)+"\n")
		line, err := reader.ReadString('\n')
		if err != nil || !strings.HasPrefix(line, "CLI:") {
			t.Fatal("owned fresh one-shot CLI failed", err)
		}
		var response struct {
			Status int            `json:"status"`
			Output map[string]any `json:"output"`
		}
		if json.Unmarshal([]byte(strings.TrimPrefix(line, "CLI:")), &response) != nil || response.Output == nil {
			t.Fatal("CLI stdout was not one bounded JSON outcome")
		}
		return response.Output, response.Status
	}
	receipt := func(result map[string]any, code, tool, requestID, state, certainty string, reason any) {
		t.Helper()
		data, err := json.Marshal(result)
		if code != "" || err != nil || !protocol.DecodeWireDocument("agent-work-receipt", data).OK || result["tool"] != tool || result["request_id"] != requestID || result["delivery_state"] != state || result["effect_certainty"] != certainty || result["reason_code"] != reason {
			t.Fatal("untruthful bounded work receipt", code, string(data))
		}
		if result["id"] != nil || result["body"] != nil || result["capture"] != nil || result["origin"] != nil {
			t.Fatal("receipt disclosed private outcome or authority")
		}
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
	stopMCP := func() {
		t.Helper()
		_, _ = io.WriteString(stdin, "__stop\n")
		line, err := reader.ReadString('\n')
		if err != nil || line != "STOPPED\n" {
			t.Fatal("compiled MCP did not exit", err, line)
		}
	}
	restartDaemon := func() {
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
	}
	restartBoth := func() { t.Helper(); restartDaemon(); restart("__restart") }
	freshScope := func(renewLease bool) {
		t.Helper()
		// Pace real traffic; never reset or bypass server budgets.
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
		if _, err := db.Exec(`UPDATE execution_commands SET state='complete' WHERE runner_id=? AND command_id=?`, ids["runner"], ids["launch"]); err != nil {
			t.Fatal(err)
		}
		fresh := post("/__a01/seed", map[string]string{"runner": enrollment.RunnerID, "claim_template": string(template)}, false)
		fixture = fresh
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
		seedLocal(renewLease)
		scope, _ := json.Marshal(map[string]string{"BFB_WORKSPACE_ID": ids["workspace"], "BFB_PROJECT_ID": ids["project"], "BFB_TASK_ID": ids["task"], "BFB_RUN_ID": ids["run"], "BFB_RUN_EXECUTION_ID": ids["execution"], "BFB_CHECKOUT_ID": ids["checkout"], "BFB_RUNNER_ID": ids["runner"]})
		_, _ = io.WriteString(stdin, "__scope:"+string(scope)+"\n")
		line, err := reader.ReadString('\n')
		if err != nil || line != "SCOPED\n" {
			t.Fatal("fixture scope switch failed", err, line)
		}
		restart("__start")
	}
	if resultScenario {
		runNativeResults(t, nativeResultFixture{
			ctx: ctx, workDB: workDB, server: server,
			ids: func() map[string]string { return ids }, call: call, submitCLI: submitCLI,
			post: post, restart: restart, restartDaemon: restartDaemon, stopMCP: stopMCP,
			freshScope: freshScope, hook: hook, wait: wait, paths: paths,
			outage: &workOutage, proofOutage: &resultProofOutage, outageOnLoss: &outageOnLoss,
			loseReply: &loseReply, businessRequests: &businessRequests,
			confirmations: &resultConfirmations, replayResponses: &replayResponses,
			snapshot: func() string { return claim.Specification.ConfigSnapshotId },
			postflightRelease: func(action string) {
				releaseDuringCloud.Store(&lockFault{input: stdin, root: paths.Root, hash: ids["physical"], action: action})
			},
			unlock: func() {
				_, _ = io.WriteString(stdin, "__unlock\n")
				if err := waitFixtureLockFree(paths.Root, ids["physical"]); err != nil {
					t.Fatal(err)
				}
			},
		})
		return
	}
	if attentionScenario {
		runNativeAttention(t, nativeAttentionFixture{
			ctx: ctx, workDB: workDB, server: server,
			ids: func() map[string]string { return ids }, call: call, post: post, restart: restart,
			restartDaemon: restartDaemon, stopMCP: stopMCP, freshScope: freshScope, hook: hook,
			outage: &workOutage, loseReply: &loseReply, businessRequests: &businessRequests,
			reads: &attentionReads, slowRead: &slowAttentionRead,
			postflightRelease: func(action string) {
				releaseDuringCloud.Store(&lockFault{input: stdin, root: paths.Root, hash: ids["physical"], action: action})
			},
		})
		return
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
	lost, code := call("bfb_add_comment", "native-comment-02", map[string]any{"body": secondBody})
	receipt(lost, code, "bfb_add_comment", "native-comment-02", "delivery_blocked", "possibly_applied", "work_unavailable")
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
		freshScope(false)
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
		lost, code := call(effect.tool, requestID, params)
		receipt(lost, code, effect.tool, requestID, "delivery_blocked", "possibly_applied", "work_unavailable")
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
		if _, code := call(effect.tool, requestID, changed); code != "request_conflict" {
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
			denied, code := call(effect.tool, requestID+"-root", rootParams)
			receipt(denied, code, effect.tool, requestID+"-root", "delivery_blocked", "confirmed", "forbidden")
			if child, code := call(effect.tool, requestID, params); code != "" || child["state"] != "ready" {
				t.Fatal("child replay acquired root-only policy", code)
			}
		}
	}
	// A lost online-only outcome is never autonomously delivered, including
	// after restart and a later genuine policy grant. Only explicit retry can
	// seek its original cached result under current authority.
	freshScope(false)
	hook("synthetic-online-only-isolation")
	action = "comment"
	loseReply.Store(&action)
	onlineUnknown, code := call("bfb_add_comment", "native-online-only-isolation", map[string]any{"body": "Synthetic online-only uncertain commit"})
	receipt(onlineUnknown, code, "bfb_add_comment", "native-online-only-isolation", "delivery_blocked", "possibly_applied", "work_unavailable")
	only := workRow("native-online-only-isolation")
	var capture generated.AgentWorkCapture
	if json.Unmarshal([]byte(only.capture), &capture) != nil || capture.AdmissionMode != "online_only" {
		t.Fatal("denied policy acquired offline mode")
	}
	stopMCP()
	requestsBefore := businessRequests.Load()
	restartDaemon()
	drainInterval := func() {
		t.Helper()
		timer := time.NewTimer(4200 * time.Millisecond)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			t.Fatal("native drain interval timed out")
		}
	}
	drainInterval()
	if current := workRow("native-online-only-isolation"); current.state != "open" || current.effect != "unknown" || current.outcome.Valid || current.capture != only.capture || businessRequests.Load() != requestsBefore {
		t.Fatal("online-only row auto-drained after exit/restart")
	}

	// Only the disposable fixture grants an explicit, proof-bound offline policy.
	// No unsigned provider-side journal or persisted timing receipt activates it.
	post("/__a01/configure", map[string]string{"offline": "allow"}, false)
	drainInterval()
	if current := workRow("native-online-only-isolation"); current.state != "open" || current.effect != "unknown" || current.outcome.Valid || current.capture != only.capture || businessRequests.Load() != requestsBefore {
		t.Fatal("later policy enablement upgraded online-only capture")
	}
	freshScope(true)
	hook("synthetic-offline-restart")
	if _, code := call("bfb_add_comment", "native-offline-prime", map[string]any{"body": "Synthetic confirmed activation"}); code != "" {
		t.Fatal("offline activation", code)
	}
	leaseOf := func() map[string]any {
		t.Helper()
		observed := post("/__a01/observe", map[string]string{"execution": ids["execution"]}, false)
		var lease map[string]any
		if json.Unmarshal(observed["lease"], &lease) != nil {
			t.Fatal("canonical lease missing")
		}
		return lease
	}
	wait("ordinary initial native lease renewal", func() bool {
		lease := leaseOf()
		return lease["state"] == "live" && lease["execution_id"] == ids["execution"] && lease["fencing_generation"] == float64(1) && lease["observation_sequence"].(float64) > 0 && lease["expires_at"].(string) > claim.LeaseExpiresAt
	})
	workOutage.Store(true)
	offlineBody := "  Synthetic durable offline intent \u2028 <>&  "
	pending, code := call("bfb_add_comment", "native-offline-restart", map[string]any{"body": offlineBody})
	receipt(pending, code, "bfb_add_comment", "native-offline-restart", "pending_sync", "not_attempted", nil)
	admitted := workRow("native-offline-restart")
	if json.Unmarshal([]byte(admitted.capture), &capture) != nil || capture.AdmissionMode != "offline_admitted" || len(capture.Signature) != 86 || capture.IntentExpiresAt == nil || admitted.state != "open" || admitted.effect != "never_sent" || admitted.dispatched.Valid || admitted.outcome.Valid || pending["operation_key"] != admitted.key {
		t.Fatal("offline receipt lacks durable signed never-sent intent")
	}
	if !strings.Contains(admitted.request, offlineBody) {
		t.Fatal("capture changed original whitespace or Unicode business bytes")
	}
	beforeReplay := post("/__a01/observe", map[string]string{"execution": ids["execution"]}, false)
	if len(rows(beforeReplay, "comments")) != 1 || len(rows(beforeReplay, "effects")) != 1 {
		t.Fatal("outage sent a business effect")
	}
	stopMCP()
	beforeRenewal := leaseOf()
	oldExpiry := beforeRenewal["expires_at"].(string)
	oldSequence := beforeRenewal["observation_sequence"].(float64)
	oldReplays := replayResponses.Load()
	restartDaemon()
	wait("ordinary same-owner lease renewal after daemon restart", func() bool {
		lease := leaseOf()
		return lease["state"] == "live" && lease["execution_id"] == ids["execution"] && lease["fencing_generation"] == beforeRenewal["fencing_generation"] && lease["observation_sequence"].(float64) > oldSequence && lease["expires_at"].(string) > oldExpiry
	})
	stillPending := workRow("native-offline-restart")
	if stillPending.effect != "never_sent" || stillPending.dispatched.Valid || stillPending.capture != admitted.capture || stillPending.fingerprint != admitted.fingerprint {
		t.Fatal("restart reconstructed or dispatched offline intent during outage")
	}
	workOutage.Store(false)
	wait("daemon-only autonomous signed replay", func() bool { return workRow("native-offline-restart").state == "applied" })
	applied := workRow("native-offline-restart")
	if applied.effect != "applied" || !applied.dispatched.Valid || !applied.outcome.Valid || applied.key != admitted.key || applied.capture != admitted.capture || applied.fingerprint != admitted.fingerprint || replayResponses.Load() <= oldReplays {
		t.Fatal("autonomous replay changed immutable capture or lacked authenticated Worker replay")
	}
	committedOffline := post("/__a01/observe", map[string]string{"execution": ids["execution"]}, false)
	if len(rows(committedOffline, "comments")) != 2 || len(rows(committedOffline, "effects")) != 2 {
		t.Fatal("autonomous replay did not create one effect")
	}
	var originalOutcome generated.AgentCommentResult
	if json.Unmarshal([]byte(applied.outcome.String), &originalOutcome) != nil {
		t.Fatal("committed offline result missing")
	}
	restart("__start")
	if repeated, code := call("bfb_add_comment", "native-offline-restart", map[string]any{"body": offlineBody}); code != "" || repeated["id"] != originalOutcome.Id {
		t.Fatal("original offline identity retry changed outcome", code)
	}
	if observed := post("/__a01/observe", map[string]string{"execution": ids["execution"]}, false); string(observed["effects"]) != string(committedOffline["effects"]) || string(observed["business"]) != string(committedOffline["business"]) {
		t.Fatal("explicit retry duplicated autonomous effect")
	}

	// Fail only the actual local acknowledgement UPDATE, after the real cloud
	// write succeeds. Remove that synthetic fault, never the retained intent.
	freshScope(false)
	hook("synthetic-ack-restart")
	if _, err := workDB.Exec(`CREATE TRIGGER a01_fixture_ack_loss BEFORE UPDATE OF state ON work_delivery
WHEN NEW.state='applied' AND OLD.state='open' AND (SELECT json_extract(request_json,'$.reference.request_id') FROM work_intents WHERE operation_key=NEW.operation_key)='native-ack-loss'
BEGIN SELECT RAISE(ABORT,'synthetic acknowledgment failure'); END`); err != nil {
		t.Fatal(err)
	}
	ackBody := "Synthetic canonical write with local acknowledgement loss"
	if _, code := call("bfb_add_comment", "native-ack-loss", map[string]any{"body": ackBody}); code != "storage_failed" {
		t.Fatal("failed durable acknowledgment looked successful", code)
	}
	unknownAck := workRow("native-ack-loss")
	ackCommitted := post("/__a01/observe", map[string]string{"execution": ids["execution"]}, false)
	if unknownAck.state != "open" || unknownAck.effect != "unknown" || !unknownAck.dispatched.Valid || unknownAck.outcome.Valid || len(rows(ackCommitted, "comments")) != 1 || len(rows(ackCommitted, "effects")) != 1 {
		t.Fatal("ack failure lost dispatch uncertainty or canonical effect")
	}
	stopMCP()
	if _, err := workDB.Exec("DROP TRIGGER a01_fixture_ack_loss"); err != nil {
		t.Fatal(err)
	}
	restartDaemon()
	wait("uncertain local acknowledgment recovery", func() bool { return workRow("native-ack-loss").state == "applied" })
	knownAck := workRow("native-ack-loss")
	if knownAck.key != unknownAck.key || knownAck.capture != unknownAck.capture || knownAck.fingerprint != unknownAck.fingerprint {
		t.Fatal("ack recovery replaced original identity")
	}
	if observed := post("/__a01/observe", map[string]string{"execution": ids["execution"]}, false); string(observed["effects"]) != string(ackCommitted["effects"]) || string(observed["business"]) != string(ackCommitted["business"]) {
		t.Fatal("ack restart repeated real business effect")
	}
	restart("__start")
	if _, code := call("bfb_add_comment", "native-ack-loss", map[string]any{"body": ackBody}); code != "" {
		t.Fatal("original ack identity unavailable after recovery", code)
	}

	// A failure of the real dispatch-marker UPDATE must send no business
	// request. The already-admitted signed never-sent row remains recoverable.
	freshScope(false)
	hook("synthetic-marker-failure")
	if _, code := call("bfb_add_comment", "native-marker-prime", map[string]any{"body": "Synthetic marker activation"}); code != "" {
		t.Fatal("marker activation", code)
	}
	workOutage.Store(true)
	markerBody := "Synthetic never-sent marker failure"
	markerPending, code := call("bfb_add_comment", "native-marker-loss", map[string]any{"body": markerBody})
	receipt(markerPending, code, "bfb_add_comment", "native-marker-loss", "pending_sync", "not_attempted", nil)
	markerBefore := workRow("native-marker-loss")
	if _, err := workDB.Exec(`CREATE TRIGGER a01_fixture_marker_loss BEFORE UPDATE OF ever_dispatched_ns ON work_delivery
WHEN OLD.ever_dispatched_ns IS NULL AND NEW.ever_dispatched_ns IS NOT NULL AND (SELECT json_extract(request_json,'$.reference.request_id') FROM work_intents WHERE operation_key=NEW.operation_key)='native-marker-loss'
BEGIN SELECT RAISE(ABORT,'synthetic dispatch marker failure'); END`); err != nil {
		t.Fatal(err)
	}
	requestsBefore = businessRequests.Load()
	workOutage.Store(false)
	if _, code := call("bfb_add_comment", "native-marker-loss", map[string]any{"body": markerBody}); code != "storage_failed" {
		t.Fatal("failed durable marker looked successful", code)
	}
	markerAfter := workRow("native-marker-loss")
	if markerAfter.state != "open" || markerAfter.effect != "never_sent" || markerAfter.dispatched.Valid || markerAfter.outcome.Valid || markerAfter.capture != markerBefore.capture || markerAfter.key != markerBefore.key || businessRequests.Load() != requestsBefore {
		t.Fatal("marker failure lost durable state or sent business request")
	}
	if observed := post("/__a01/observe", map[string]string{"execution": ids["execution"]}, false); len(rows(observed, "comments")) != 1 || len(rows(observed, "effects")) != 1 {
		t.Fatal("marker failure created canonical effect")
	}
	stopMCP()
	if _, err := workDB.Exec("DROP TRIGGER a01_fixture_marker_loss"); err != nil {
		t.Fatal(err)
	}
	restartDaemon()
	wait("never-sent marker recovery", func() bool { return workRow("native-marker-loss").state == "applied" })
	if current := workRow("native-marker-loss"); current.capture != markerBefore.capture || current.key != markerBefore.key {
		t.Fatal("marker recovery replaced signed intent")
	}
	if observed := post("/__a01/observe", map[string]string{"execution": ids["execution"]}, false); len(rows(observed, "comments")) != 2 || len(rows(observed, "effects")) != 2 {
		t.Fatal("marker recovery did not apply exactly once")
	}
	restart("__start")

	for _, closure := range []string{"session", "lock", "policy"} {
		freshScope(false)
		hook("synthetic-never-sent-" + closure)
		if _, code := call("bfb_add_comment", "native-queued-prime-"+closure, map[string]any{"body": "Synthetic queued activation"}); code != "" {
			t.Fatal("queued activation", closure, code)
		}
		workOutage.Store(true)
		requestID := "native-queued-closed-" + closure
		queuedBody := "Synthetic queued denied before dispatch"
		queued, code := call("bfb_add_comment", requestID, map[string]any{"body": queuedBody})
		receipt(queued, code, "bfb_add_comment", requestID, "pending_sync", "not_attempted", nil)
		beforeDeny := workRow(requestID)
		stopMCP()
		reason := "capability_closed"
		if closure == "session" {
			post("/__a01/change", map[string]string{"execution": ids["execution"], "kind": "session"}, false)
		} else if closure == "lock" {
			reason = "assignment_ended"
			_, _ = io.WriteString(stdin, "__unlock\n")
			if err := waitFixtureLockFree(paths.Root, ids["physical"]); err != nil {
				t.Fatal(err)
			}
		} else {
			reason = "policy_rejected"
			var previous generated.AgentWorkCapture
			if json.Unmarshal([]byte(beforeDeny.capture), &previous) != nil {
				t.Fatal("original policy capture missing")
			}
			response := post("/__a01/project-tighten", map[string]string{}, false)
			var changedVersion int64
			if json.Unmarshal(response["resourceVersion"], &changedVersion) != nil || changedVersion != previous.Confirmation.ProjectPolicyVersion+1 {
				t.Fatal("project policy did not commit a genuine new generation")
			}
		}
		requestsBefore = businessRequests.Load()
		workOutage.Store(false)
		wait("never-sent current authority denial "+closure, func() bool { return workRow(requestID).state == "blocked" })
		afterDeny := workRow(requestID)
		if afterDeny.effect != "never_sent" || afterDeny.dispatched.Valid || afterDeny.reason.String != reason || afterDeny.capture != beforeDeny.capture || afterDeny.key != beforeDeny.key || businessRequests.Load() != requestsBefore {
			t.Fatal("queued closure changed capture or dispatched", closure)
		}
		if json.Unmarshal([]byte(afterDeny.capture), &capture) != nil || capture.Confirmation.FencingGeneration != 1 || capture.Confirmation.RunExecutionId != ids["execution"] {
			t.Fatal("queued closure replaced capture fence")
		}
		if lease := leaseOf(); lease["execution_id"] != ids["execution"] || lease["fencing_generation"] != float64(capture.Confirmation.FencingGeneration) {
			t.Fatal("queued denial replaced canonical ownership fence")
		}
		if observed := post("/__a01/observe", map[string]string{"execution": ids["execution"]}, false); len(rows(observed, "comments")) != 1 || len(rows(observed, "effects")) != 1 {
			t.Fatal("queued closure created canonical effect", closure)
		}
		if closure == "lock" {
			_, _ = io.WriteString(stdin, "__start\n")
			line, err := reader.ReadString('\n')
			if err != nil || line != "READY\n" {
				t.Fatal("closed ownership MCP start", err, line)
			}
			write(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}})
			line, err = reader.ReadString('\n')
			if err != nil || !strings.Contains(line, `"bfb_code":"assignment_ended"`) {
				t.Fatal("free-lock MCP startup did not fail closed", err, line)
			}
		} else {
			restart("__start")
		}
	}

	// Strict expiry stops delivery without relabeling an uncertain committed
	// operation as rejected/no-effect. The cloud lease remains currently live.
	post("/__a01/configure", map[string]string{"offline": "allow", "age": "3"}, false)
	freshScope(false)
	hook("synthetic-uncertain-expiry")
	action = "comment"
	outageOnLoss.Store(true)
	loseReply.Store(&action)
	expiredBody := "Synthetic committed reply lost before strict expiry"
	uncertain, code := call("bfb_add_comment", "native-uncertain-expiry", map[string]any{"body": expiredBody})
	receipt(uncertain, code, "bfb_add_comment", "native-uncertain-expiry", "pending_sync", "possibly_applied", nil)
	workOutage.Store(true)
	expiring := workRow("native-uncertain-expiry")
	if json.Unmarshal([]byte(expiring.capture), &capture) != nil || capture.IntentExpiresAt == nil {
		t.Fatal("strict capture expiry missing")
	}
	expires, err := time.Parse(time.RFC3339Nano, *capture.IntentExpiresAt)
	if err != nil {
		t.Fatal(err)
	}
	timer := time.NewTimer(max(0, time.Until(expires.Add(100*time.Millisecond))))
	select {
	case <-timer.C:
	case <-ctx.Done():
		timer.Stop()
		t.Fatal("strict expiry fixture timed out")
	}
	workOutage.Store(false)
	wait("strict uncertain expiry", func() bool { return workRow("native-uncertain-expiry").state == "blocked" })
	expired := workRow("native-uncertain-expiry")
	if expired.effect != "unknown" || expired.reason.String != "intent_expired" || expired.key != expiring.key || expired.capture != expiring.capture {
		t.Fatal("expiry erased uncertainty or changed original intent")
	}
	if observed := post("/__a01/observe", map[string]string{"execution": ids["execution"]}, false); len(rows(observed, "comments")) != 1 || len(rows(observed, "effects")) != 1 {
		t.Fatal("expiry repeated or lost committed effect")
	}
	deniedExpiry, code := call("bfb_add_comment", "native-uncertain-expiry", map[string]any{"body": expiredBody})
	receipt(deniedExpiry, code, "bfb_add_comment", "native-uncertain-expiry", "delivery_blocked", "possibly_applied", "intent_expired")
	post("/__a01/configure", map[string]string{"offline": "allow"}, false)

	for _, closure := range []struct{ kind, code string }{{"session", "capability_closed"}, {"end", "assignment_ended"}, {"result", "capability_closed"}, {"lease", "capability_closed"}, {"history_before", "assignment_ended"}, {"history_during", "assignment_ended"}, {"history_write", "assignment_ended"}, {"lock_before", "assignment_ended"}, {"lock_write", "assignment_ended"}, {"grant", "revoked"}} {
		freshScope(false)
		requestID := "cached-closure-" + closure.kind
		hook("synthetic-session-" + closure.kind)
		if _, code := call("bfb_add_comment", requestID, map[string]any{"body": "Synthetic cached closure comment"}); code != "" {
			t.Fatal("fresh bound comment failed", closure.kind, code)
		}
		if _, code := call("bfb_get_context", requestID, nil); code != "request_rejected" {
			t.Fatal("cached write identity accepted across tools", closure.kind, code)
		}
		if closure.kind == "grant" {
			requestID += "-uncertain"
			action = "comment"
			outageOnLoss.Store(true)
			loseReply.Store(&action)
			unknown, code := call("bfb_add_comment", requestID, map[string]any{"body": "Synthetic cached closure comment"})
			receipt(unknown, code, "bfb_add_comment", requestID, "pending_sync", "possibly_applied", nil)
			workOutage.Store(true)
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
		if closure.kind == "grant" {
			beforeDeny := workRow(requestID)
			workOutage.Store(false)
			wait("uncertain dispatch revocation", func() bool { return workRow(requestID).state == "blocked" })
			afterDeny := workRow(requestID)
			if afterDeny.effect != "unknown" || afterDeny.reason.String != "revoked" || afterDeny.capture != beforeDeny.capture || afterDeny.key != beforeDeny.key {
				t.Fatal("revocation erased uncertain dispatch")
			}
			observed := post("/__a01/observe", map[string]string{"execution": ids["execution"]}, false)
			if len(rows(observed, "comments")) != 2 || len(rows(observed, "effects")) != 2 {
				t.Fatal("revocation repeated or lost committed effects")
			}
		}
		if closure.kind == "history_write" || closure.kind == "lock_write" {
			requestID += "-new"
		}
		denied, code := call("bfb_add_comment", requestID, map[string]any{"body": "Synthetic cached closure comment"})
		if closure.kind == "history_write" || closure.kind == "lock_write" {
			receipt(denied, code, "bfb_add_comment", requestID, "delivery_blocked", "confirmed", closure.code)
		} else if code != closure.code {
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
