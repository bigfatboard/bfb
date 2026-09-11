// ABOUTME: Certifies signed launchd renewal, durable recovery and isolated real Worker WebSocket channels.
// ABOUTME: Uses disposable synthetic identities, a trusted test TLS proxy and exact Keychain cleanup.

//go:build darwin && cgo

package runner

import (
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
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/auth"
	"github.com/qdis/bfb/internal/daemon"
)

func TestNativeWorkerChannel(t *testing.T) {
	target := os.Getenv("BFB_CHANNEL_TEST_URL")
	if target == "" {
		t.Skip("real Worker harness runs this test through pnpm test:l08")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	upstream, err := url.Parse(target)
	if err != nil || upstream.Hostname() != "127.0.0.1" && upstream.Hostname() != "localhost" {
		t.Fatal("fixture must use loopback Worker")
	}
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	// Wrangler's disposable loopback HTTPS endpoint uses its own development
	// certificate. Native clients still verify the separate pinned test TLS proxy.
	proxy.Transport = &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
	proxy.Director = func(request *http.Request) {
		request.URL.Scheme = upstream.Scheme
		request.URL.Host = upstream.Host
		request.Host = "bfb.channel.test"
	}
	tlsServer := httptest.NewTLSServer(proxy)
	defer tlsServer.Close()
	client := tlsServer.Client()
	directory, err := os.MkdirTemp("", "bfb-l08-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(directory)
	paths, err := daemon.StatePaths(filepath.Join(directory, "s"))
	if err != nil {
		t.Fatal(err)
	}
	if err = paths.Prepare(); err != nil {
		t.Fatal(err)
	}
	config, _ := json.Marshal(map[string]string{"ProxyAddress": tlsServer.Listener.Addr().String(), "Certificate": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: tlsServer.Certificate().Raw}))})
	if err = os.WriteFile(filepath.Join(paths.Root, "fixture.json"), config, 0600); err != nil {
		t.Fatal(err)
	}
	command := func(name string, args ...string) []byte {
		t.Helper()
		output, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("native fixture %s failed: %v: %s", filepath.Base(name), err, output)
		}
		return output
	}
	match := regexp.MustCompile(`(?m)^\s*\d+\) ([A-F0-9]{40}) "Apple Development:`).FindSubmatch(command("security", "find-identity", "-v", "-p", "codesigning"))
	if match == nil {
		t.Fatal("signed native acceptance requires an Apple development identity")
	}
	binary := filepath.Join(directory, "bfb-channel-daemon")
	command("go", "build", "-o", binary, "./testdata/channel-daemon")
	command("codesign", "--force", "--sign", string(match[1]), "--identifier", auth.DaemonSigningIdentifier, "--options", "runtime", binary)
	label := "com.tenira.bfb.l08." + strings.ToLower(daemon.NewRequestID())
	service := fmt.Sprintf("gui/%d/%s", os.Getuid(), label)
	var enrollments []Enrollment
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 20*time.Second)
		defer stop()
		_ = exec.CommandContext(cleanup, "/bin/launchctl", "bootout", service).Run()
		for _, enrollment := range enrollments {
			if out, err := exec.CommandContext(cleanup, binary, "cleanup", enrollment.WorkspaceID, enrollment.RunnerID).CombinedOutput(); err != nil {
				t.Errorf("synthetic Keychain cleanup failed: %v: %s", err, out)
			}
		}
	}()
	if err = daemon.Install(ctx, paths, binary, filepath.Join(directory, "agents"), label); err != nil {
		t.Fatal(err)
	}
	wait := func(description string, duration time.Duration, check func() bool) {
		t.Helper()
		deadline := time.Now().Add(duration)
		for time.Now().Before(deadline) {
			if check() {
				return
			}
			select {
			case <-ctx.Done():
				t.Fatal("fixture timed out", description)
			case <-time.After(100 * time.Millisecond):
			}
		}
		if status, err := daemon.Call(ctx, paths, "runner.list", nil); err == nil {
			data, _ := json.Marshal(status.Payload)
			t.Log("bounded public enrollment state:", string(data))
		}
		t.Fatal("timed out:", description)
	}
	var pid int
	wait("launchd background daemon", 15*time.Second, func() bool {
		response, err := daemon.Call(ctx, paths, "daemon.status", nil)
		if err == nil {
			pid = int(response.Payload["daemon_pid"].(float64))
		}
		return err == nil
	})
	parent := strings.TrimSpace(string(command("ps", "-o", "ppid=", "-p", strconv.Itoa(pid))))
	if parent != "1" {
		t.Fatal("fixture daemon is not launchd-owned", parent)
	}
	post := func(path string, body any, browser bool) (int, map[string]json.RawMessage) {
		t.Helper()
		data, _ := json.Marshal(body)
		request, err := http.NewRequestWithContext(ctx, "POST", tlsServer.URL+path, bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		if browser {
			request.Header.Set("Origin", "https://bfb.channel.test")
			request.Header.Set("Sec-Fetch-Site", "same-origin")
			request.Header.Set("Cookie", os.Getenv("BFB_CHANNEL_TEST_COOKIE"))
			request.Header.Set("X-BFB-CSRF", os.Getenv("BFB_CHANNEL_TEST_CSRF"))
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		data, _ = io.ReadAll(io.LimitReader(response.Body, 65536))
		var result map[string]json.RawMessage
		if json.Unmarshal(data, &result) != nil {
			t.Fatalf("non-JSON fixture result for %s: %d %s", path, response.StatusCode, data)
		}
		return response.StatusCode, result
	}
	approve := func(enrollment Enrollment, action string, extra map[string]any) {
		t.Helper()
		body := map[string]any{"workspace_id": enrollment.WorkspaceID, "runner_id": enrollment.RunnerID, "action": action}
		for key, value := range extra {
			body[key] = value
		}
		status, minted := post("/__test/proof", body, false)
		if status != 200 {
			t.Fatal("fixture proof mint failed", status)
		}
		var proof string
		_ = json.Unmarshal(minted["proof"], &proof)
		payload := map[string]any{"step_up_proof_id": proof}
		for key, value := range extra {
			payload[key] = value
		}
		path := "/api/v1/workspaces/" + enrollment.WorkspaceID + "/runners"
		want := 200
		switch action {
		case "runner.enroll":
			payload["runner_id"] = enrollment.RunnerID
			want = 201
		case "runner.grants.replace":
			path += "/" + enrollment.RunnerID + "/grants"
		case "runner.revoke":
			path += "/" + enrollment.RunnerID + "/revoke"
		}
		status, result := post(path, payload, true)
		if status != want {
			t.Fatalf("production %s failed: %d %s", action, status, result["error"])
		}
	}
	for index, suffix := range []string{"A", "B"} {
		response, err := daemon.Call(ctx, paths, "runner.enroll", map[string]any{"app_origin": "https://bfb.channel.test", "workspace_id": os.Getenv("BFB_CHANNEL_TEST_WORKSPACE_" + suffix), "device_label": fmt.Sprintf("Synthetic Mac %d", index)})
		if err != nil {
			t.Fatal("native enrollment", err)
		}
		data, _ := json.Marshal(response.Payload["enrollment"])
		var enrollment Enrollment
		if json.Unmarshal(data, &enrollment) != nil {
			t.Fatal("missing local enrollment")
		}
		enrollments = append(enrollments, enrollment)
		approve(enrollment, "runner.enroll", map[string]any{"device_label": enrollment.Label, "public_key": enrollment.PublicKey, "project_ids": []string{os.Getenv("BFB_CHANNEL_TEST_PROJECT_" + suffix)}})
	}
	a, b := enrollments[0], enrollments[1]
	if a.RunnerID == b.RunnerID || a.Thumbprint == b.Thumbprint || string(a.PublicKey) == string(b.PublicKey) {
		t.Fatal("workspace native keys or identities were shared")
	}
	type observation struct {
		Connection struct {
			ID       string `json:"connection_id"`
			Epoch    int64  `json:"token_epoch"`
			LastSeen string `json:"last_seen_at"`
			Expires  string `json:"auth_expires_at"`
		} `json:"connection"`
		Inventory json.RawMessage `json:"inventory"`
		Authority struct {
			TokenEpoch int64   `json:"token_epoch"`
			GrantEpoch int64   `json:"grant_epoch"`
			RevokedAt  *string `json:"revoked_at"`
		} `json:"authority"`
		Pending []struct {
			ID string `json:"command_id"`
		} `json:"pending"`
	}
	observe := func(enrollment Enrollment) observation {
		t.Helper()
		status, result := post("/__test/observe", map[string]any{"workspace_id": enrollment.WorkspaceID, "runner_id": enrollment.RunnerID}, false)
		if status != 200 {
			t.Fatal("observation failed", status)
		}
		data, _ := json.Marshal(result)
		var observed observation
		if json.Unmarshal(data, &observed) != nil {
			t.Fatal("bad observation")
		}
		return observed
	}
	wait("two isolated authenticated WSS channels and inventories", 30*time.Second, func() bool {
		x, y := observe(a), observe(b)
		return x.Connection.ID != "" && y.Connection.ID != "" && string(x.Inventory) != "null" && string(y.Inventory) != "null"
	})
	firstA, firstB := observe(a), observe(b)
	if firstA.Connection.ID == firstB.Connection.ID {
		t.Fatal("workspace sockets were shared")
	}
	repository := filepath.Join(directory, "synthetic-checkout")
	command("git", "init", "-q", repository)
	command("git", "-C", repository, "remote", "add", "origin", "https://github.com/qdis/l08-synthetic.git")
	if _, err := daemon.Call(ctx, paths, "checkout.link", map[string]any{"workspace_id": a.WorkspaceID, "runner_id": a.RunnerID, "project_id": os.Getenv("BFB_CHANNEL_TEST_PROJECT_A"), "label": "Synthetic checkout", "repository_identity": "github.com/qdis/l08-synthetic", "local_path": repository}); err != nil {
		t.Fatal("native exact checkout link", err)
	}
	for _, value := range []observation{firstA, firstB} {
		if strings.Contains(string(value.Inventory), paths.Root) || strings.Contains(string(value.Inventory), "bfb_runner_") || strings.Contains(string(value.Inventory), "configuration") || strings.Contains(string(value.Inventory), "executable") {
			t.Fatal("private inventory fields synchronized")
		}
	}
	t.Log("signed launchd daemon connected two workspaces without an app; distinct keys, tokens and sockets")
	// Insert more than one page, one ungranted-project reference and an already
	// expired reference. No nudge is sent; consumers own expiry/final authorization.
	var commands []map[string]any
	var ids []string
	for index := 0; index < 27; index++ {
		id := daemon.NewRequestID()
		ids = append(ids, id)
		commands = append(commands, map[string]any{"command_id": id, "command_kind": "launch", "project_id": os.Getenv("BFB_CHANNEL_TEST_PROJECT_A"), "expires_at": time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano)})
	}
	denied := daemon.NewRequestID()
	commands = append(commands, map[string]any{"command_id": denied, "command_kind": "launch", "project_id": os.Getenv("BFB_CHANNEL_TEST_PROJECT_DENIED"), "expires_at": time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)})
	if status, _ := post("/__test/commands", map[string]any{"workspace_id": a.WorkspaceID, "runner_id": a.RunnerID, "commands": commands}, false); status != 200 {
		t.Fatal("durable fixture insertion failed")
	}
	received := func(runner, command string) bool {
		_, err := os.Stat(filepath.Join(paths.Root, "received", runner+"-"+command))
		return err == nil
	}
	wait("lost-nudge periodic paginated pull", 30*time.Second, func() bool {
		for _, id := range ids {
			if !received(a.RunnerID, id) {
				return false
			}
		}
		return true
	})
	if received(a.RunnerID, denied) || received(b.RunnerID, ids[0]) {
		t.Fatal("command crossed project or workspace grant")
	}
	if len(observe(a).Pending) != 28 {
		t.Fatal("receipt acknowledgement deleted canonical pending commands")
	}
	wait("sanitized exact checkout synchronization", 30*time.Second, func() bool { return strings.Contains(string(observe(a).Inventory), "Synthetic checkout") })
	if strings.Contains(string(observe(a).Inventory), directory) {
		t.Fatal("registered path leaked through inventory")
	}
	t.Log("lost nudges, pagination, expired-reference delivery and project filtering passed")
	// The harness evicts the real DO and preserves its hibernating sockets.
	beforeHibernate := observe(a).Connection
	fmt.Println("L08_HIBERNATE_SYNTHETIC_WORKSPACE")
	wait("hibernating socket attachment recovery", 30*time.Second, func() bool {
		current := observe(a).Connection
		return current.ID == beforeHibernate.ID && current.LastSeen != beforeHibernate.LastSeen
	})
	beforeWake := observe(a).Connection
	if _, err := daemon.Call(ctx, paths, "runner.wake", map[string]any{"runner_id": a.RunnerID}); err != nil {
		t.Fatal(err)
	}
	wait("wake fresh-challenge rotation", 20*time.Second, func() bool {
		current := observe(a).Connection
		return current.ID != beforeWake.ID && current.Epoch > beforeWake.Epoch
	})
	if observe(b).Connection.ID != firstB.Connection.ID {
		t.Fatal("workspace A wake replaced workspace B socket")
	}
	t.Log("hibernation and isolated sleep/wake recovery passed")
	// Issue B's next token just before a synthetic server-clock jump. Its live
	// socket must close at the real DO expiry alarm, before the 20-second heartbeat.
	beforeExpiry := observe(b).Connection
	if status, _ := post("/__test/time", map[string]any{"offset": -290000}, false); status != 200 {
		t.Fatal("clock fixture failed")
	}
	if _, err := daemon.Call(ctx, paths, "runner.wake", map[string]any{"runner_id": b.RunnerID}); err != nil {
		t.Fatal(err)
	}
	wait("short remaining server lifetime", 10*time.Second, func() bool { current := observe(b).Connection; return current.Epoch > beforeExpiry.Epoch })
	shortLived := observe(b).Connection
	if status, _ := post("/__test/time", map[string]any{"offset": 0}, false); status != 200 {
		t.Fatal("clock fixture reset failed")
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, shortLived.Expires)
	if err != nil || time.Until(expiresAt) > 11*time.Second {
		t.Fatal("expiry fixture did not issue a near-expiry token")
	}
	wait("persistent expiry alarm and fresh renewal", 20*time.Second, func() bool {
		current := observe(b).Connection
		return current.Epoch > shortLived.Epoch && current.ID != shortLived.ID
	})
	t.Log("server-clock jump and actual persistent socket-expiry alarm passed")
	// Crash after the synthetic owner commits but before the local receipt commits.
	crashCommand := daemon.NewRequestID()
	if err := os.WriteFile(filepath.Join(paths.Root, "pause-command"), []byte(crashCommand), 0600); err != nil {
		t.Fatal(err)
	}
	status, _ := post("/__test/commands", map[string]any{"workspace_id": a.WorkspaceID, "runner_id": a.RunnerID, "commands": []map[string]any{{"command_id": crashCommand, "command_kind": "discussion_turn", "project_id": os.Getenv("BFB_CHANNEL_TEST_PROJECT_A"), "expires_at": time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)}}}, false)
	if status != 200 {
		t.Fatal("crash command insertion failed")
	}
	wait("business acceptance before crash", 30*time.Second, func() bool { return received(a.RunnerID, crashCommand) })
	command("/bin/launchctl", "kill", "SIGKILL", service)
	wait("launchd process restart", 40*time.Second, func() bool {
		response, err := daemon.Call(ctx, paths, "daemon.status", nil)
		return err == nil && int(response.Payload["daemon_pid"].(float64)) != pid
	})
	local, err := sql.Open("sqlite", "file:"+paths.Database+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	defer local.Close()
	wait("durable acceptance receipt reconciliation", 30*time.Second, func() bool {
		var count int
		_ = local.QueryRow(`SELECT COUNT(*) FROM runner_command_inbox WHERE runner_id = ? AND command_id = ? AND accepted_at IS NOT NULL`, a.RunnerID, crashCommand).Scan(&count)
		return count == 1
	})
	entries, _ := os.ReadDir(filepath.Join(paths.Root, "received"))
	if len(entries) != 28 {
		t.Fatal("restart repeated or lost a business effect", len(entries))
	}
	t.Log("daemon kill/restart after business commit recovered exactly one durable effect")
	// A real browser grant mutation closes the live channel. Reauthorization
	// succeeds under the tightened empty project set, without resurrecting commands.
	beforeGrant := observe(a).Connection
	approve(a, "runner.grants.replace", map[string]any{"expected_grant_epoch": 1, "project_ids": []string{}, "launcher_human_ids": []string{os.Getenv("BFB_CHANNEL_TEST_OWNER")}})
	wait("grant fence and renewed channel", 20*time.Second, func() bool {
		current := observe(a)
		return current.Authority.GrantEpoch == 2 && current.Connection.ID != beforeGrant.ID
	})
	beforeRevokeB := observe(b).Connection.ID
	approve(a, "runner.revoke", nil)
	wait("typed live revocation closes and persists locally", 10*time.Second, func() bool {
		var state string
		_ = local.QueryRow(`SELECT connection_state FROM runner_enrollments WHERE id = ?`, a.RunnerID).Scan(&state)
		return state == "revoked"
	})
	if observe(a).Authority.RevokedAt == nil || observe(b).Connection.ID != beforeRevokeB {
		t.Fatal("revocation failed or crossed workspace")
	}
	if _, err := daemon.Call(ctx, paths, "runner.enroll", map[string]any{"app_origin": a.Origin, "workspace_id": a.WorkspaceID, "device_label": a.Label}); daemon.AsFailure(err).Code != "runner_revoked" {
		t.Fatal("revoked enrollment renewed", err)
	}
	approve(b, "runner.revoke", nil)
	wait("second workspace terminal revocation", 10*time.Second, func() bool {
		var state string
		_ = local.QueryRow(`SELECT connection_state FROM runner_enrollments WHERE id = ?`, b.RunnerID).Scan(&state)
		return state == "revoked"
	})
	t.Log("live grant replacement/revocation and cross-workspace isolation passed")
}
