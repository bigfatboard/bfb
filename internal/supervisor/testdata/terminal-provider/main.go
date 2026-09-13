// ABOUTME: Runs a bounded synthetic native provider and records actual execution facts outside the checkout.
// ABOUTME: Supplies local-only child, escape and terminal-signal faults without credentials or business actions.

package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers/fake"
	"github.com/qdis/bfb/internal/supervisor"
)

func write(name string, value any) {
	directory := os.Getenv("BFB_ARTIFACTS_DIR")
	if !filepath.IsAbs(directory) {
		os.Exit(2)
	}
	data, err := json.Marshal(value)
	if err != nil || len(data) > 16384 {
		os.Exit(2)
	}
	file, err := os.OpenFile(filepath.Join(directory, name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		os.Exit(2)
	}
	if _, err := file.Write(data); err != nil || file.Sync() != nil || file.Close() != nil {
		os.Exit(2)
	}
}

func git(arguments ...string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "/usr/bin/git", arguments...)
	command.Env = []string{"PATH=/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_OPTIONAL_LOCKS=0"}
	data, err := command.Output()
	if err != nil || len(data) > 4096 {
		os.Exit(2)
	}
	return strings.TrimSpace(string(data))
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println("bfb-fake-provider 1.0.0")
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "--probe" {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"healthy": true, "capabilities": fake.Capabilities()})
		return
	}
	self, err := os.Executable()
	if err != nil {
		os.Exit(2)
	}
	var configuration struct {
		Scenario string `json:"scenario"`
	}
	data, err := os.ReadFile(filepath.Join(filepath.Dir(self), "scenario.json"))
	if err != nil || len(data) > 256 || json.Unmarshal(data, &configuration) != nil || !slices.Contains([]string{"interactive", "child", "escape", "ignore_interrupt", "ctrl_c", "close"}, configuration.Scenario) {
		os.Exit(2)
	}
	signals := make(chan os.Signal, 8)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(signals)
	if len(os.Args) == 2 && os.Args[1] == "--native-child" {
		table, err := supervisor.InspectProcesses()
		if err != nil {
			os.Exit(2)
		}
		write("native-child.json", table[os.Getpid()])
		// Bounded even if the parent or harness disappears. An escaped child
		// remains alive long enough for both native observers to retain it.
		select {
		case <-time.After(45 * time.Second):
		case <-signals:
		}
		return
	}
	mode := flag.String("mode", "", "Synthetic mode")
	model := flag.String("model", "", "Synthetic model")
	effort := flag.String("effort", "", "Synthetic effort")
	approval := flag.String("approval", "", "Synthetic approval")
	filesystem := flag.String("filesystem", "", "Synthetic filesystem")
	injection := flag.String("context", "", "Synthetic context")
	prompt := flag.String("initial-prompt", "", "Compiled initial instruction")
	resume := flag.String("resume", "", "Exact synthetic session")
	flag.Parse()
	if flag.NArg() != 0 || *mode != "interactive" || *model != "synthetic" || *effort != "low" || *approval != "never" || *filesystem != "read_only" || *injection != "none" || *prompt != provider.InitialInstruction || *resume != "" && *resume != "synthetic-session" {
		os.Exit(2)
	}
	cwd, err := os.Getwd()
	if err != nil {
		os.Exit(2)
	}
	table, err := supervisor.InspectProcesses()
	if err != nil {
		os.Exit(2)
	}
	scoped := map[string]string{}
	names := []string{}
	for _, entry := range os.Environ() {
		name, value, _ := strings.Cut(entry, "=")
		names = append(names, name)
		if strings.HasPrefix(name, "BFB_") {
			scoped[name] = value
		}
	}
	slices.Sort(names)
	write("native-start.json", map[string]any{
		"process": table[os.Getpid()], "cwd": cwd, "branch": git("branch", "--show-current"),
		"head": git("rev-parse", "HEAD"), "dirty": git("status", "--porcelain=v1", "--untracked-files=normal") != "",
		"scoped": scoped, "environment_names": names, "arguments": os.Args[1:], "resumed": *resume != "",
	})
	if configuration.Scenario == "child" || configuration.Scenario == "escape" {
		// The local test controller waits for real native startup observation
		// before injecting a child fault. This is not a provider input channel.
		deadline := time.NewTimer(30 * time.Second)
		ticker := time.NewTicker(20 * time.Millisecond)
		ready := false
		for !ready {
			if _, err := os.Stat(filepath.Join(os.Getenv("BFB_ARTIFACTS_DIR"), "native-spawn-child")); err == nil {
				ready = true
				continue
			}
			select {
			case <-deadline.C:
				os.Exit(2)
			case <-signals:
				return
			case <-ticker.C:
			}
		}
		ticker.Stop()
		deadline.Stop()
		child := exec.Command(self, "--native-child")
		child.Env = os.Environ()
		if configuration.Scenario == "escape" {
			child.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		}
		if child.Start() != nil {
			os.Exit(2)
		}
		// Deliberately no parent-owned cleanup: native BFB supervision must
		// retain a surviving child instead of inferring completion from us.
		go func() { _ = child.Wait() }()
	}
	fmt.Println("BFB synthetic native provider ready.")
	if configuration.Scenario == "ctrl_c" {
		fmt.Println("Native acceptance: press Control-C in this Terminal tab.")
	}
	if configuration.Scenario == "close" {
		fmt.Println("Native acceptance: close this Terminal tab and confirm its process-close prompt.")
	}
	deadline := time.NewTimer(90 * time.Second)
	defer deadline.Stop()
	for number := 1; ; number++ {
		select {
		case sig := <-signals:
			write(fmt.Sprintf("native-signal-%d.json", number), map[string]any{"signal": int(sig.(syscall.Signal)), "observed_at": time.Now().UTC().Format(time.RFC3339Nano)})
			if configuration.Scenario != "ignore_interrupt" || sig != syscall.SIGINT {
				return
			}
		case <-deadline.C:
			write("native-timeout.json", map[string]bool{"timed_out": true})
			return
		}
	}
}
