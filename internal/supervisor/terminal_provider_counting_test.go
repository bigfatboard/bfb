// ABOUTME: Runs the signed Terminal provider fixture directly and proves it counts signals.
// ABOUTME: Fails when the fixture exits on its first signal instead of recording the sequence.

package supervisor

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/provider"
)

func buildTerminalProviderFixture(t *testing.T) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "terminal-provider")
	if output, err := exec.Command("go", "build", "-o", binary, "./testdata/terminal-provider").CombinedOutput(); err != nil {
		t.Fatalf("terminal provider build: %v %s", err, output)
	}
	return binary
}

func awaitTerminalProviderFile(t *testing.T, directory, name string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if data, err := os.ReadFile(filepath.Join(directory, name)); err == nil && len(data) > 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("terminal provider did not write %s", name)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func awaitTerminalProviderSignal(t *testing.T, directory string, number int, want syscall.Signal) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		data, err := os.ReadFile(filepath.Join(directory, fmt.Sprintf("native-signal-%d.json", number)))
		var observed struct {
			Signal int
		}
		if err == nil && json.Unmarshal(data, &observed) == nil && observed.Signal == int(want) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("terminal provider did not record signal %d as %v", number, want)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestTerminalProviderCountsSignals(t *testing.T) {
	binary := buildTerminalProviderFixture(t)
	sequences := []struct {
		name     string
		scenario string
		signals  []syscall.Signal
	}{
		{"ctrl_c", "ctrl_c", []syscall.Signal{syscall.SIGINT, syscall.SIGINT}},
		{"close", "close", []syscall.Signal{syscall.SIGHUP, syscall.SIGTERM}},
		{"ignore_interrupt", "ignore_interrupt", []syscall.Signal{syscall.SIGINT, syscall.SIGINT, syscall.SIGTERM}},
	}
	for _, sequence := range sequences {
		t.Run(sequence.name, func(t *testing.T) {
			home := t.TempDir()
			copy, err := os.ReadFile(binary)
			if err != nil {
				t.Fatal(err)
			}
			owned := filepath.Join(home, "terminal-provider")
			if err := os.WriteFile(owned, copy, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(home, "scenario.json"), []byte(`{"scenario":`+fmt.Sprintf("%q", sequence.scenario)+`}`), 0600); err != nil {
				t.Fatal(err)
			}
			artifacts := filepath.Join(home, "artifacts")
			if err := os.Mkdir(artifacts, 0700); err != nil {
				t.Fatal(err)
			}
			command := exec.Command(owned,
				"--mode", "interactive",
				"--model", "synthetic",
				"--effort", "low",
				"--approval", "never",
				"--filesystem", "read_only",
				"--context", "none",
				"--initial-prompt", provider.InitialInstruction,
			)
			command.Env = []string{"PATH=/usr/bin:/bin", "BFB_ARTIFACTS_DIR=" + artifacts}
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				_ = command.Process.Kill()
				_ = command.Wait()
			})
			awaitTerminalProviderFile(t, artifacts, "native-start.json")
			for number, signal := range sequence.signals {
				if err := command.Process.Signal(signal); err != nil {
					t.Fatalf("counting provider exited after %d signal(s); duplicate signals are unobservable: %v", number, err)
				}
				awaitTerminalProviderSignal(t, artifacts, number+1, signal)
			}
			// No phantom signals may appear while the counting provider stays alive.
			deadline := time.Now().Add(2 * time.Second)
			for time.Now().Before(deadline) {
				if _, err := os.Stat(filepath.Join(artifacts, fmt.Sprintf("native-signal-%d.json", len(sequence.signals)+1))); !os.IsNotExist(err) {
					t.Fatalf("terminal provider recorded a phantom signal %d", len(sequence.signals)+1)
				}
				time.Sleep(100 * time.Millisecond)
			}
		})
	}
}
