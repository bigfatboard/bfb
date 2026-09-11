// ABOUTME: Runs deterministic synthetic provider lifecycle and process-containment fault scenarios.
// ABOUTME: Emits only fixture telemetry; process exits and tool outcomes never submit business results.

package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers/fake"
)

func emit(value any) { _ = json.NewEncoder(os.Stdout).Encode(value) }

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		version := os.Getenv("BFB_FAKE_VERSION")
		if path := os.Getenv("BFB_FAKE_VERSION_FILE"); path != "" {
			file, err := os.Open(path)
			if err != nil {
				os.Exit(2)
			}
			raw, err := io.ReadAll(io.LimitReader(file, 128))
			_ = file.Close()
			if err != nil {
				os.Exit(2)
			}
			version = string(raw)
		}
		if version == "" {
			version = "1.0.0"
		}
		fmt.Println("bfb-fake-provider " + version)
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "--probe" {
		capabilities := fake.Capabilities()
		if os.Getenv("BFB_FAKE_UNSUPPORTED") == "1" {
			capabilities = []string{"launch.interactive"}
		}
		emit(map[string]any{"healthy": os.Getenv("BFB_FAKE_UNHEALTHY") != "1", "capabilities": capabilities})
		return
	}
	mode := flag.String("mode", "headless", "Synthetic transport")
	_ = flag.String("model", "", "Synthetic model")
	_ = flag.String("effort", "", "Synthetic effort")
	_ = flag.String("approval", "", "Synthetic approval")
	_ = flag.String("filesystem", "", "Synthetic filesystem policy")
	injection := flag.String("context", "none", "Synthetic context injection")
	session := flag.String("session", "synthetic-session", "Requested session")
	resume := flag.String("resume", "", "Observed session to resume")
	fork := flag.Bool("fork", false, "Fork the observed session")
	turn := flag.String("turn", "synthetic-turn", "Synthetic turn")
	initial := flag.Bool("initial-stdin", false, "Consume the fixed prompt on stdin")
	flag.Parse()
	if flag.NArg() != 0 {
		os.Exit(2)
	}
	if *resume != "" {
		if *resume != "synthetic-session" {
			emit(provider.Candidate{Kind: "provider_error", Outcome: "failed"})
			os.Exit(3)
		}
		*session = *resume
	}
	if *fork {
		*session = "synthetic-fork"
	}
	scenario := os.Getenv("BFB_FAKE_SCENARIO")
	if scenario == "child-worker" {
		time.Sleep(10 * time.Second)
		return
	}
	var child *exec.Cmd
	if scenario == "child" || scenario == "escape" {
		child = exec.Command(os.Args[0], "--mode", "headless")
		child.Env = []string{"BFB_FAKE_SCENARIO=child-worker"}
		if scenario == "escape" {
			child.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		}
		if child.Start() != nil {
			os.Exit(4)
		}
		emit(map[string]any{"kind": "synthetic_child", "pid": child.Process.Pid, "escaped": scenario == "escape"})
		defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	}
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(signals)
	emit(provider.Candidate{Kind: "session_started", SessionID: *session})
	if *injection != "none" {
		emit(map[string]any{"kind": "context_injected"})
	}
	if *turn != "synthetic-turn" {
		emit(provider.TurnEvent{Kind: "session_observed", SessionID: *session, TurnID: *turn})
	}
	if *initial {
		raw, err := io.ReadAll(io.LimitReader(os.Stdin, provider.MaxTurnBytes+1))
		if err != nil || len(raw) > provider.MaxTurnBytes {
			os.Exit(2)
		}
		emit(provider.Candidate{Kind: "turn_started", SessionID: *session, TurnID: *turn})
	}
	if !*initial || scenario == "hang" || scenario == "child" || scenario == "escape" || scenario == "ignore_interrupt" {
		for {
			sig := <-signals
			if scenario == "ignore_interrupt" && sig == syscall.SIGINT {
				continue
			}
			emit(provider.Candidate{Kind: "interrupted", SessionID: *session, Outcome: "cancelled"})
			return
		}
	}
	if scenario == "exit" {
		os.Exit(7)
	}
	if scenario == "tool_failure" {
		emit(provider.Candidate{Kind: "tool_completed", SessionID: *session, Tool: "synthetic-tool", Outcome: "failed"})
		return
	}
	if scenario == "delay" {
		delay, _ := strconv.Atoi(os.Getenv("BFB_FAKE_DELAY_MS"))
		if delay < 0 || delay > 1000 {
			delay = 100
		}
		time.Sleep(time.Duration(delay) * time.Millisecond)
	}
	emit(provider.Candidate{Kind: "turn_completed", SessionID: *session, TurnID: *turn, Outcome: "succeeded"})
	_ = mode // Interactive fixtures use the caller's PTY; the kit never simulates input.
}
