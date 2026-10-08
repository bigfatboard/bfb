// ABOUTME: Hosts a signed synthetic daemon for native app lifecycle and link acceptance.
// ABOUTME: Keeps every test-only control and observed child outside the production CLI registry.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/qdis/bfb/internal/appbridge"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
)

const terminalID = "e0da52a9-d0cb-47d8-867b-e08f684b9001"

func main() {
	if len(os.Args) == 3 && os.Args[1] == "__launch" {
		if os.Args[2] != terminalID {
			os.Exit(2)
		}
		executable, err := os.Executable()
		if err != nil {
			os.Exit(3)
		}
		var state struct {
			Directory string `json:"directory"`
		}
		data, err := os.ReadFile(filepath.Join(filepath.Dir(executable), "..", "Resources", "native-test-state.json"))
		if err != nil || json.Unmarshal(data, &state) != nil {
			os.Exit(3)
		}
		if err := os.WriteFile(filepath.Join(state.Directory, "terminal-received"), []byte("synthetic UUID handoff accepted\n"), 0600); err != nil {
			os.Exit(3)
		}
		// A synthetic metadata fixture for the app's real Apple-event routing.
		// Native execution authority is exercised separately by L05, not inferred
		// from this test-only file or the already completed fixture helper.
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		tty := exec.CommandContext(ctx, "/usr/bin/tty")
		tty.Stdin = os.Stdin
		device, err := tty.Output()
		if err != nil {
			os.Exit(3)
		}
		routing, err := json.Marshal(map[string]string{"tty": strings.TrimSpace(string(device))})
		if err != nil || os.WriteFile(filepath.Join(state.Directory, "synthetic-terminal-routing.json"), routing, 0600) != nil {
			os.Exit(3)
		}
		fmt.Println("BFB synthetic Terminal handoff accepted.")
		return
	}
	if len(os.Args) != 3 || os.Args[1] != "serve" {
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	paths, err := daemon.StatePaths(os.Args[2])
	if err != nil {
		panic(err)
	}
	child := exec.CommandContext(ctx, "/bin/sleep", "300")
	if err := child.Start(); err != nil {
		panic(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	var mu sync.Mutex
	var wakes []string
	bridge := appbridge.New(appbridge.Options{WakeIntent: func(_ context.Context, id string) error {
		mu.Lock()
		defer mu.Unlock()
		wakes = append(wakes, id)
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"synthetic": true, "wake_intent_id": id})
		return nil
	}})
	registry := daemon.NewRegistry()
	if err := appbridge.RegisterRPC(registry, bridge); err != nil {
		panic(err)
	}
	if err := registry.Register("runner.list", func(context.Context, daemon.Request) (map[string]any, error) {
		return map[string]any{"enrollments": []any{}}, nil
	}); err != nil {
		panic(err)
	}
	if err := registry.Register("synthetic.terminal", func(ctx context.Context, request daemon.Request) (map[string]any, error) {
		id, _ := request.Envelope.Payload["terminal_intent_id"].(string)
		return map[string]any{}, bridge.OpenTerminal(ctx, id)
	}); err != nil {
		panic(err)
	}
	if err := registry.Register("synthetic.notify", func(ctx context.Context, request daemon.Request) (map[string]any, error) {
		id, _ := request.Envelope.Payload["notification_id"].(string)
		return map[string]any{}, bridge.NotifyAttention(ctx, id)
	}); err != nil {
		panic(err)
	}
	if err := registry.Register("synthetic.focus", func(ctx context.Context, request daemon.Request) (map[string]any, error) {
		intent := terminalID
		if len(request.Envelope.Payload) != 0 {
			var ok bool
			intent, ok = request.Envelope.Payload["terminal_intent_id"].(string)
			if !ok || len(request.Envelope.Payload) != 1 {
				return nil, &daemon.Failure{Code: "invalid_request"}
			}
		}
		var routing struct {
			TTY string `json:"tty"`
		}
		data, err := os.ReadFile(filepath.Join(paths.Root, "synthetic-terminal-routing.json"))
		if err != nil || json.Unmarshal(data, &routing) != nil {
			return nil, &daemon.Failure{Code: "invalid_request"}
		}
		now := time.Now().UTC().Truncate(time.Microsecond)
		target := generated.LocalExecutionFocus{SchemaVersion: 1, TerminalIntentId: intent, ControlId: daemon.NewRequestID(), RunExecutionId: daemon.NewRequestID(), AssignmentGeneration: 1, Tty: routing.TTY,
			AuthorizedAt: now.Format(time.RFC3339Nano), ExpiresAt: now.Add(time.Minute).Format(time.RFC3339Nano)}
		return map[string]any{}, bridge.FocusTerminal(ctx, target, func(context.Context) error { return nil })
	}); err != nil {
		panic(err)
	}
	if err := registry.Register("synthetic.inspect", func(ctx context.Context, request daemon.Request) (map[string]any, error) {
		status := bridge.Status()
		mu.Lock()
		defer mu.Unlock()
		var state string
		err := request.Store.DB.QueryRowContext(ctx, "SELECT state FROM process_observations WHERE id = 'synthetic-child'").Scan(&state)
		if err != nil {
			return nil, err
		}
		markers := []string{"app_pid:" + strconv.Itoa(status.PID), "child_pid:" + strconv.Itoa(child.Process.Pid), "observation:" + state}
		if child.Process.Signal(syscall.Signal(0)) == nil {
			markers = append(markers, "child_alive")
		}
		payload := map[string]any{"recovery_pending": len(wakes), "log_entries": markers}
		if status.State != "" {
			payload["app_session_state"] = status.State
		}
		if len(wakes) > 0 {
			payload["wake_intent_id"] = wakes[len(wakes)-1]
		}
		return payload, nil
	}); err != nil {
		panic(err)
	}
	server, err := daemon.Start(ctx, paths, registry)
	if err != nil {
		panic(err)
	}
	defer server.Close()
	if _, err := server.Store.DB.ExecContext(ctx, "INSERT INTO process_observations (id, pid, started_at, state) VALUES ('synthetic-child', ?, ?, 'attached')", child.Process.Pid, time.Now().UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano)); err != nil {
		panic(err)
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"synthetic": true, "daemon_ready": true})
	<-ctx.Done()
}
