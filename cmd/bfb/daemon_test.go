// ABOUTME: Exercises the actual CLI daemon process through start, contention, crash and restart.
// ABOUTME: Keeps process logs and state inside a dedicated temporary directory with bounded cleanup.

package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
)

func processFixture(t *testing.T) (string, daemon.Paths) {
	t.Helper()
	root, err := os.MkdirTemp("/tmp", "bfb-process-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	binary := filepath.Join(root, "bfb")
	command := exec.Command("go", "build", "-o", binary, ".")
	if data, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, data)
	}
	paths, err := daemon.StatePaths(filepath.Join(root, "state"))
	if err != nil {
		t.Fatal(err)
	}
	return binary, paths
}

func awaitDaemon(t *testing.T, binary string, paths daemon.Paths) generated.LocalRpcEnvelope {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		data, err := exec.CommandContext(ctx, binary, "--data-dir", paths.Root, "daemon", "status", "--json").Output()
		cancel()
		if err == nil {
			var response generated.LocalRpcEnvelope
			if json.Unmarshal(data, &response) != nil || response.Payload["status"] != "running" {
				t.Fatal("invalid CLI status")
			}
			return response
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("daemon did not become ready")
	return generated.LocalRpcEnvelope{}
}

func TestDaemonProcessCrashAndRestart(t *testing.T) {
	binary, paths := processFixture(t)
	start := func() *exec.Cmd {
		log, err := os.OpenFile(filepath.Join(filepath.Dir(binary), "process.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = log.Close() })
		command := exec.Command(binary, "--data-dir", paths.Root, "daemon", "run")
		command.Stdout, command.Stderr = log, log
		if err = command.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = command.Process.Kill() })
		awaitDaemon(t, binary, paths)
		return command
	}
	first := start()
	// The production binary includes supervision, while unsigned test clients
	// still cannot register a helper or cause an app/wake effect.
	if info, err := os.Stat(filepath.Join(paths.Root, "execution-records")); err != nil || !info.IsDir() {
		t.Fatal("production execution service did not start", err)
	}
	for method, payload := range map[string]map[string]any{
		"execution.register": {"terminal_intent_id": "00000000-0000-4000-8000-000000000001"},
		"app.wake":           {"wake_intent_id": daemon.NewRequestID()},
	} {
		if _, err := daemon.Call(context.Background(), paths, method, payload); daemon.AsFailure(err).Code != "peer_denied" {
			t.Fatal("production native boundary missing or bypassed", method, err)
		}
	}
	for _, helper := range []string{"__launch", "__exec"} {
		command := exec.Command(binary, "--data-dir", paths.Root, "--json", helper, "synthetic-private")
		data, err := command.Output()
		var response generated.LocalRpcEnvelope
		if err == nil || command.ProcessState.ExitCode() != 2 || json.Unmarshal(data, &response) != nil || response.Error == nil || response.Error.Code != "invalid_request" {
			t.Fatal("production fixed helper dispatch missing", helper, err)
		}
	}
	duplicate := exec.Command(binary, "--data-dir", paths.Root, "--json", "daemon", "run")
	data, err := duplicate.Output()
	if err == nil || duplicate.ProcessState.ExitCode() != 6 {
		t.Fatalf("duplicate daemon: %v %s", err, data)
	}
	var response generated.LocalRpcEnvelope
	if json.Unmarshal(data, &response) != nil || response.Error == nil || response.Error.Code != "already_running" {
		t.Fatal("duplicate daemon envelope")
	}
	if err = first.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = first.Wait()
	second := start()
	stop := exec.Command(binary, "--data-dir", paths.Root, "daemon", "stop", "--json")
	if data, err = stop.CombinedOutput(); err != nil {
		t.Fatalf("stop: %v %s", err, data)
	}
	if err = second.Wait(); err != nil {
		t.Fatal(err)
	}
	logs := exec.Command(binary, "--data-dir", paths.Root, "daemon", "logs", "--json")
	if data, err = logs.Output(); err != nil {
		t.Fatal(err)
	}
	if json.Unmarshal(data, &response) != nil {
		t.Fatal("invalid log response")
	}
	if entries, ok := response.Payload["log_entries"].([]any); !ok || len(entries) < 3 {
		t.Fatal("restart did not preserve diagnostics")
	}
}
