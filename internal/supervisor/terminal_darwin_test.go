// ABOUTME: Exercises actual macOS PTY foreground groups with the compiled fake provider.
// ABOUTME: Covers terminal Ctrl-C, surviving children, escaped descendants and non-stealing restoration.

//go:build darwin && cgo

package supervisor

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers/fake"
	"golang.org/x/sys/unix"
)

type ptyPhase struct {
	Phase   string  `json:"phase"`
	Process Process `json:"process"`
	Child   Process `json:"child"`
}

func TestNativePTY(t *testing.T) {
	fakeBinary := filepath.Join(t.TempDir(), "bfb-fake-provider")
	build := exec.Command("go", "build", "-o", fakeBinary, "../../cmd/bfb-fake-provider")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("fake build: %s: %v", output, err)
	}
	for _, scenario := range []string{"interrupt", "child", "escape"} {
		t.Run(scenario, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 50*time.Second)
			defer cancel()
			self, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			command := exec.CommandContext(ctx, "/usr/bin/script", "-q", "-F", filepath.Join(t.TempDir(), "synthetic-pty.txt"), self, "-test.run=^TestNativePTYFixture$", "-test.timeout=45s")
			command.Env = append(os.Environ(), "BFB_L05_PTY_FIXTURE="+scenario, "BFB_L05_FAKE="+fakeBinary)
			command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
			input, err := command.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			output, err := command.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			command.Stderr = command.Stdout
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			owned := map[int]Process{}
			defer func() {
				_ = input.Close()
				for _, process := range owned {
					table, err := InspectProcesses()
					if err == nil && process.Same(table[process.PID]) {
						_ = syscall.Kill(process.PID, syscall.SIGKILL)
					}
				}
				_ = command.Process.Kill()
				_ = command.Wait()
			}()
			lines := make(chan string, 128)
			go func() {
				defer close(lines)
				scanner := bufio.NewScanner(io.LimitReader(output, 32768))
				for scanner.Scan() {
					lines <- strings.TrimSpace(scanner.Text())
				}
			}()
			var leader, child Process
			ready, session, acted, survived, heartbeat, escaped, restored := false, false, false, false, false, false, false
			var diagnostic strings.Builder
			for !restored {
				select {
				case <-ctx.Done():
					t.Fatalf("PTY scenario timed out: %s", diagnostic.String())
				case line, ok := <-lines:
					if !ok {
						t.Fatalf("PTY exited before restoration: %s", diagnostic.String())
					}
					if diagnostic.Len() < 4096 {
						diagnostic.WriteString(line + "\n")
					}
					var phase ptyPhase
					_ = json.Unmarshal([]byte(line), &phase)
					switch phase.Phase {
					case "foreground":
						leader, ready = phase.Process, true
						owned[leader.PID] = leader
						owned[phase.Child.PID] = phase.Child // The fixture supervisor.
					case "child_observed":
						child = phase.Child
						owned[child.PID] = child
					case "parent_gone_child_alive":
						survived = true
					case "child_heartbeat":
						heartbeat = true
					case "escaped":
						escaped = true
					case "restored":
						restored = true
					}
					if strings.Contains(line, `"kind":"session_started"`) {
						session = true
					}
					if scenario == "interrupt" && ready && session && !acted {
						if _, err := input.Write([]byte{3}); err != nil {
							t.Fatal(err)
						}
						acted = true
					}
					if scenario == "child" && child.PID != 0 && ready && !acted {
						killFixture(t, leader)
						acted = true
					}
					if scenario == "escape" && escaped && child.PID != 0 && !acted {
						killFixture(t, child)
						killFixture(t, leader)
						acted = true
					}
				}
			}
			if !acted || (scenario == "child" && (!survived || !heartbeat)) || (scenario == "escape" && !escaped) {
				t.Fatalf("missing native assertions: %s", diagnostic.String())
			}
			if scenario != "escape" {
				table, err := InspectProcesses()
				if err != nil {
					t.Fatal(err)
				}
				for _, process := range table {
					if process.GroupID == leader.GroupID && !process.Zombie {
						t.Fatal("provider group survived restoration")
					}
				}
			}
		})
	}
}

// This runs only as the child of the outer script-created controlling PTY.
func TestNativePTYFixture(t *testing.T) {
	scenario := os.Getenv("BFB_L05_PTY_FIXTURE")
	if scenario == "" {
		t.Skip("subprocess-only native fixture")
	}
	if scenario != "interrupt" && scenario != "child" && scenario != "escape" {
		t.Fatal("invalid fixture")
	}
	terminal, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer terminal.Close()
	foreground, err := unix.IoctlGetInt(int(terminal.Fd()), unix.TIOCGPGRP)
	if err != nil || foreground != syscall.Getpgrp() {
		t.Fatal("fixture does not own its controlling terminal")
	}
	processes, err := InspectProcesses()
	if err != nil {
		t.Fatal(err)
	}
	self := processes[os.Getpid()]
	tty, err := controllingTTY(self)
	var inputStat, ttyStat unix.Stat_t
	if err != nil || unix.Fstat(int(os.Stdin.Fd()), &inputStat) != nil || unix.Lstat(tty, &ttyStat) != nil || inputStat.Rdev != ttyStat.Rdev {
		t.Fatal("kernel controlling device did not match the owned PTY", err)
	}
	self.StartIdentity += "-reused"
	if _, err = controllingTTY(self); err == nil {
		t.Fatal("reused PID selected a Terminal device")
	}
	registry, err := provider.NewRegistry([]provider.Descriptor{fake.Descriptor()})
	if err != nil {
		t.Fatal(err)
	}
	probe, err := registry.Probe(context.Background(), "fake", provider.Installation{Executable: os.Getenv("BFB_L05_FAKE"), IntegrationHash: provider.Hash(nil), Environment: []string{"BFB_FAKE_SCENARIO=" + scenario, "BFB_FAKE_CHILD_LIFETIME_MS=17000"}}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	cwd, _ := os.Getwd()
	plan, err := registry.PlanLaunch(probe, provider.LaunchInput{WorkingDirectory: cwd, Config: generated.ExecutionConfig{Provider: "fake", Mode: "interactive", Model: "synthetic", Effort: "low", ApprovalPolicy: "never", FilesystemPolicy: "read_only", ContextInjection: "none", InitialTurnTransport: "waiting_user_submit", RequiredCapabilities: []string{"launch.interactive"}}}, provider.Policy{AllowedCapabilities: fake.Capabilities()}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	invocation := plan.Invocation()
	command := exec.Command(invocation.Executable, invocation.Arguments...)
	command.Dir, command.Env = invocation.WorkingDirectory, invocation.Environment
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Foreground: true, Ctty: int(terminal.Fd())}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	table, err := InspectProcesses()
	if err != nil {
		t.Fatal(err)
	}
	leader := table[command.Process.Pid]
	group, err := NewGroup(leader)
	if err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		t.Fatal(err)
	}
	actual, err := unix.IoctlGetInt(int(terminal.Fd()), unix.TIOCGPGRP)
	if err != nil || actual != leader.GroupID {
		t.Fatal("provider did not acquire foreground")
	}
	if changed, err := RestoreForeground(int(terminal.Fd()), leader.GroupID+1, foreground); err != nil || changed {
		t.Fatal("restoration stole another group")
	}
	actual, _ = unix.IoctlGetInt(int(terminal.Fd()), unix.TIOCGPGRP)
	if actual != leader.GroupID {
		t.Fatal("wrong expected group changed foreground")
	}
	writePhase := func(phase string, process, child Process) {
		_ = json.NewEncoder(os.Stdout).Encode(ptyPhase{phase, process, child})
	}
	writePhase("foreground", leader, table[os.Getpid()])
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	started := time.Now()
	childReported, parentReported, heartbeatReported, escapeReported := false, false, false, false
	for range ticker.C {
		table, err = InspectProcesses()
		if err != nil {
			t.Fatal(err)
		}
		observation := group.Observe(table)
		for _, process := range observation.Live {
			if process.PID != leader.PID && !childReported {
				writePhase("child_observed", leader, process)
				childReported = true
			}
		}
		if current, exists := table[leader.PID]; !exists || current.Zombie {
			if len(observation.Live) > 0 && !parentReported {
				writePhase("parent_gone_child_alive", leader, Process{})
				parentReported = true
			}
			if len(observation.Live) > 0 && time.Since(started) >= 15*time.Second && !heartbeatReported {
				writePhase("child_heartbeat", leader, Process{})
				heartbeatReported = true
			}
		}
		if group.HadEscape && !escapeReported {
			writePhase("escaped", leader, Process{})
			escapeReported = true
		}
		if observation.State == "gone" || (scenario == "escape" && group.ProveGone(table)) {
			break
		}
		if time.Since(started) > 35*time.Second {
			t.Fatal("owned group did not end")
		}
	}
	// Reap only after every group member is gone. Until here the original PID
	// remains reserved even after parent exit, so a remote signal cannot race reuse.
	_ = command.Wait()
	if changed, err := RestoreForeground(int(terminal.Fd()), leader.GroupID, foreground); err != nil || !changed {
		t.Fatalf("foreground restoration: %v", err)
	}
	actual, err = unix.IoctlGetInt(int(terminal.Fd()), unix.TIOCGPGRP)
	if err != nil || actual != foreground {
		t.Fatal("supervisor foreground not restored")
	}
	writePhase("restored", leader, Process{})
	fmt.Println("BFB synthetic PTY proof complete.")
}
