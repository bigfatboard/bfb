// ABOUTME: Exercises the supervisor lifetime with actual surviving, escaped and unresponsive owned processes.
// ABOUTME: Proves lock retention, serialized shutdown and whole-group reaping without cloud or terminal-output authority.

package supervisor

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func lifetimeFixture(t *testing.T, binary, scenario string) (*gatedProcess, *os.File) {
	t.Helper()
	lock, err := fixtureLockStore(t).Acquire(fixtureBinding())
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(binary, "--mode", "interactive")
	command.Env = []string{"BFB_FAKE_SCENARIO=" + scenario, "BFB_FAKE_CHILD_LIFETIME_MS=20000"}
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := lock.beginSpawn(); err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		_ = lock.cancelSpawn()
		_ = lock.Release()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		// All of these processes were created and recorded by this test. The
		// product's explicit recovery path never sends these cleanup signals.
		lock.mu.Lock()
		var owned []Process
		if lock.record.Group != nil {
			for _, process := range lock.record.Group.Observed {
				owned = append(owned, process)
			}
		}
		lock.mu.Unlock()
		for _, process := range owned {
			table, err := InspectProcesses()
			if err == nil && process.Same(table[process.PID]) && !table[process.PID].Zombie {
				_ = syscall.Kill(process.PID, syscall.SIGKILL)
			}
		}
		_ = command.Process.Kill()
		_ = command.Wait()
		_ = lock.Close()
	})
	table, err := InspectProcesses()
	leader := table[command.Process.Pid]
	if err != nil || lock.Attach(leader) != nil {
		t.Fatal("owned lifetime child missing", err)
	}
	// Native PTY restoration is covered by the gate suite. This deliberately
	// unavailable terminal additionally proves terminal loss cannot skip reaping.
	terminal, err := os.CreateTemp(t.TempDir(), "closed-terminal-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = terminal.Close() })
	return &gatedProcess{command: command, leader: leader, lock: lock}, terminal
}

func awaitRecordedChild(t *testing.T, lock *WorktreeLock, escape bool) Process {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		record, err := lock.store.read(lock.record.Binding.PhysicalWorktreeHash)
		if err == nil && record.Group != nil && record.Group.HadEscape == escape {
			for pid, child := range record.Group.Observed {
				if pid != record.Group.Leader.PID {
					return child
				}
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("owned child was not recorded")
	return Process{}
}

func awaitLifetime(t *testing.T, done <-chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(8 * time.Second):
		t.Fatal("supervisor did not settle its owned group")
	}
	return nil
}

func TestLifetimeRetainsChildrenAndUnknownContainment(t *testing.T) {
	binary := imageFixtureBinary(t)
	for _, scenario := range []string{"child", "escape", "cancel_escape", "cancel_contained"} {
		t.Run(scenario, func(t *testing.T) {
			fakeScenario := "child"
			if scenario == "escape" || scenario == "cancel_escape" {
				fakeScenario = "escape"
			}
			process, terminal := lifetimeFixture(t, binary, fakeScenario)
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan error, 1)
			go func() { done <- superviseOwned(ctx, process, terminal, syscall.Getpgrp(), nil); close(done) }()
			t.Cleanup(func() {
				cancel()
				select {
				case <-done:
				case <-time.After(time.Second):
				}
			})
			child := awaitRecordedChild(t, process.lock, fakeScenario == "escape")
			if scenario == "cancel_escape" || scenario == "cancel_contained" {
				cancel()
			} else {
				killFixture(t, process.leader)
				awaitAbsent(t, process.leader.PID)
				// Give the actual loop several observations after the leader
				// exited. Its unreaped zombie still reserves the group ID.
				time.Sleep(3 * processInspectionInterval)
				table, err := InspectProcesses()
				if err != nil || !process.leader.Same(table[process.leader.PID]) || !table[process.leader.PID].Zombie || !child.Same(table[child.PID]) || table[child.PID].Zombie {
					t.Fatal("parent exit ended live child ownership", err)
				}
				assertFailure(t, process.lock.store.RecoverLocal(process.lock.record.Binding), "checkout_occupied")
				select {
				case err := <-done:
					t.Fatal("supervisor ended before the owned child", err)
				default:
				}
				killFixture(t, child)
			}
			err := awaitLifetime(t, done)
			record, readErr := process.lock.store.read(process.lock.record.Binding.PhysicalWorktreeHash)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if fakeScenario == "escape" {
				assertFailure(t, err, "containment_unknown")
				if record.State != "containment_unknown" || !record.Group.Unknown {
					t.Fatal("escape lost its durable marker")
				}
				if scenario == "cancel_escape" {
					table, err := InspectProcesses()
					if err != nil || !child.Same(table[child.PID]) || table[child.PID].Zombie || process.command.ProcessState != nil {
						t.Fatal("unknown child was signalled or leader reaped")
					}
					return
				}
			} else {
				if err == nil || record.State != "released" {
					t.Fatal("terminal loss lost final lock cleanup", err)
				}
			}
			if process.command.ProcessState == nil || !ownedProcessesGone(process.lock) {
				t.Fatal("whole group was not reaped")
			}
			assertFailure(t, process.lock.Signal(syscall.SIGINT), "containment_unknown")
		})
	}
}

func TestLifetimeEscalatesOnlyTheVerifiedOwnedGroup(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	lock, err := fixtureLockStore(t).Acquire(fixtureBinding())
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	command := exec.Command(self, "-test.run=^TestLifetimeUnresponsiveFixture$")
	command.Env = append(os.Environ(), "BFB_LIFETIME_UNRESPONSIVE=1")
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	output, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := lock.beginSpawn(); err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = command.Process.Kill(); _ = command.Wait() }()
	if line, err := bufio.NewReader(output).ReadString('\n'); err != nil || line != "synthetic-term-ignored\n" {
		t.Fatal("unresponsive fixture did not start", err)
	}
	table, err := InspectProcesses()
	if err != nil {
		t.Fatal(err)
	}
	leader := table[command.Process.Pid]
	if err := lock.Attach(leader); err != nil {
		t.Fatal(err)
	}
	terminal, err := os.Create(filepath.Join(t.TempDir(), "unavailable-terminal"))
	if err != nil {
		t.Fatal(err)
	}
	defer terminal.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	started := time.Now()
	err = superviseOwned(ctx, &gatedProcess{command: command, leader: leader, lock: lock}, terminal, syscall.Getpgrp(), nil)
	if err == nil || time.Since(started) < processTerminationGrace || time.Since(started) > processTerminationGrace+3*time.Second {
		t.Fatal("wrong escalation timing", err)
	}
	if lock.record.State != "released" || command.ProcessState == nil {
		t.Fatal("escalation did not complete ownership cleanup")
	}
	status, ok := command.ProcessState.Sys().(syscall.WaitStatus)
	if !ok || !status.Signaled() || status.Signal() != syscall.SIGKILL {
		t.Fatal("unresponsive child did not receive final verified KILL")
	}
}

func TestLifetimeUnresponsiveFixture(t *testing.T) {
	if os.Getenv("BFB_LIFETIME_UNRESPONSIVE") == "" {
		t.Skip("compiled shutdown fixture")
	}
	signal.Ignore(syscall.SIGTERM)
	fmt.Println("synthetic-term-ignored")
	select {}
}
