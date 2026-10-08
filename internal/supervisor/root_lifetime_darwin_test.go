// ABOUTME: Exercises root-only lifetime retention and foreground restoration on an isolated macOS PTY.
// ABOUTME: Keeps detached survivors and durable occupancy separate from original-group reaping.

//go:build darwin && cgo

package supervisor

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/provider"
	"golang.org/x/sys/unix"
)

func TestRootSupervisionPTYRetainsOriginalGroupAfterRootExit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(ctx, "/usr/bin/script", "-q", "-F", filepath.Join(t.TempDir(), "root-lifetime.pty"), self, "-test.run=^TestRootSupervisionPTYFixture$", "-test.timeout=15s")
	command.Env = append(os.Environ(), "BFB_ROOT_PTY_FIXTURE=1")
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	output, err := command.CombinedOutput()
	if err != nil || !strings.Contains(string(output), "root_group_retained_foreground_restored_family_unproven") {
		t.Fatalf("synthetic root PTY proof failed: %v\n%s", err, output)
	}
}

func TestRootSupervisionPTYFixture(t *testing.T) {
	if os.Getenv("BFB_ROOT_PTY_FIXTURE") != "1" {
		t.Skip("isolated subprocess-only fixture")
	}
	terminal, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer terminal.Close()
	foreground, err := unix.IoctlGetInt(int(terminal.Fd()), unix.TIOCGPGRP)
	if err != nil || foreground != syscall.Getpgrp() {
		t.Fatal("fixture is not foreground owner", err)
	}
	locks := fixtureLockStore(t)
	lock, err := locks.Acquire(fixtureBinding())
	if err != nil || lock.configureSupervision(provider.RootSupervision) != nil || lock.beginSpawn() != nil {
		t.Fatal("root reservation failed", err)
	}
	defer lock.Close()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(self, "-test.run=^TestRootSupervisionProcessFixture$", "-test.timeout=12s")
	command.Env = append(os.Environ(), "BFB_ROOT_PROCESS_FIXTURE=1")
	command.Stdin, command.Stderr = os.Stdin, os.Stderr
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Foreground: true, Ctty: int(terminal.Fd())}
	output, err := command.StdoutPipe()
	if err != nil || command.Start() != nil {
		t.Fatal("root fixture start failed", err)
	}
	var receipt rootNativeReceipt
	if err := json.NewDecoder(bufio.NewReader(output)).Decode(&receipt); err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		t.Fatal(err)
	}
	table, err := InspectProcesses()
	root := table[command.Process.Pid]
	if err != nil || lock.Attach(root) != nil {
		t.Fatal("root fixture attach failed", err)
	}
	process := &gatedProcess{command: command, leader: root, lock: lock}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	joined := false
	t.Cleanup(func() {
		cancel()
		for _, owned := range []Process{root, receipt.Peer, receipt.Detached} {
			table, err := InspectProcesses()
			if err == nil && owned.Same(table[owned.PID]) && !table[owned.PID].Zombie {
				_ = syscall.Kill(owned.PID, syscall.SIGKILL)
			}
		}
		if !joined {
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				t.Error("root lifetime failed to join during isolated cleanup")
			}
		}
		_ = command.Wait()
	})
	if observation, err := lock.Observe(); err != nil || observation.State != "live" {
		t.Fatal("root and detached children were not admitted", observation, err)
	}
	go func() { done <- superviseOwned(ctx, process, terminal, foreground, nil) }()
	killFixture(t, root)
	awaitAbsent(t, root.PID)
	// The root PID remains an unreaped zombie until its original-group peer
	// ends. Cancellation must not reap it, restore early, or signal other groups.
	for _, cancelNow := range []bool{false, true} {
		if cancelNow {
			cancel()
		}
		time.Sleep(3 * processInspectionInterval)
		select {
		case err := <-done:
			joined = true
			t.Fatal("root lifetime ended before original-group child", err)
		default:
		}
		table, err = InspectProcesses()
		actual, foregroundErr := unix.IoctlGetInt(int(terminal.Fd()), unix.TIOCGPGRP)
		record, recordErr := locks.read(lock.record.Binding.PhysicalWorktreeHash)
		if err != nil || foregroundErr != nil || actual != root.GroupID || !root.Same(table[root.PID]) || !table[root.PID].Zombie ||
			!receipt.Peer.Same(table[receipt.Peer.PID]) || table[receipt.Peer.PID].Zombie || recordErr != nil || record.State != "containment_unknown" {
			t.Fatal("root reservation, foreground or durable closure lost", actual, record.State, err, foregroundErr, recordErr)
		}
	}
	killFixture(t, receipt.Peer) // Fixture cleanup, not a product signal target.
	assertFailure(t, awaitLifetime(t, done), "containment_unknown")
	joined = true
	table, err = InspectProcesses()
	actual, foregroundErr := unix.IoctlGetInt(int(terminal.Fd()), unix.TIOCGPGRP)
	if err != nil || foregroundErr != nil || actual != foreground || command.ProcessState == nil ||
		!receipt.Detached.Same(table[receipt.Detached.PID]) || table[receipt.Detached.PID].Zombie {
		t.Fatal("restoration/reaping signalled detached child or failed", actual, err, foregroundErr)
	}
	record, err := locks.read(lock.record.Binding.PhysicalWorktreeHash)
	if err != nil || record.State != "containment_unknown" || record.Group.ProveGone(table) {
		t.Fatal("root-group end became family release", record, err)
	}
	killFixture(t, receipt.Detached)
	awaitAbsent(t, receipt.Detached.PID)
	table, err = InspectProcesses()
	if err != nil || !record.Group.KnownProcessesAbsent(table) {
		t.Fatal("fixture known identities did not end", err)
	}
	assertFailure(t, locks.recoverLocal(record.Binding, record.Group), "containment_unknown")
	_, err = locks.Acquire(record.Binding)
	assertFailure(t, err, "containment_unknown")
	_, _ = os.Stdout.WriteString("root_group_retained_foreground_restored_family_unproven\n")
}
