// ABOUTME: Exercises remote interrupt and bounded shutdown against real owned native process groups.
// ABOUTME: Proves one effective signal, stale-target rejection, child survival and containment-safe escalation.

package supervisor

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/protocol/generated"
)

type controlledLifetime struct {
	process    *gatedProcess
	assignment generated.LocalExecutionAssignment
	controls   chan helperControl
	lines      chan string
	done       chan error
	cancel     context.CancelFunc
}

func fixtureControlledLifetime(t *testing.T, ignoreTerm bool) *controlledLifetime {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	lock, err := fixtureLockStore(t).Acquire(fixtureBinding())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lock.Close() })
	command := exec.Command(self, "-test.run=^TestControlSignalFixture$")
	mode := "responsive"
	if ignoreTerm {
		mode = "ignore_term"
	}
	command.Env = append(os.Environ(), "BFB_CONTROL_SIGNAL_FIXTURE="+mode)
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
	t.Cleanup(func() { _ = command.Process.Kill(); _ = command.Wait() })
	reader := bufio.NewScanner(output)
	if !reader.Scan() || reader.Text() != "synthetic-control-ready" {
		t.Fatal("signal fixture not ready")
	}
	table, err := InspectProcesses()
	if err != nil {
		t.Fatal(err)
	}
	leader := table[command.Process.Pid]
	if err := lock.Attach(leader); err != nil {
		t.Fatal(err)
	}
	terminal, err := os.CreateTemp(t.TempDir(), "unavailable-terminal-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = terminal.Close() })
	ctx, cancel := context.WithCancel(context.Background())
	f := &controlledLifetime{process: &gatedProcess{command: command, leader: leader, lock: lock}, assignment: controlAssignment(lock.record.Binding), controls: make(chan helperControl), lines: make(chan string, 8), done: make(chan error, 1), cancel: cancel}
	go func() {
		defer close(f.lines)
		for reader.Scan() {
			f.lines <- reader.Text()
		}
	}()
	go func() {
		f.done <- superviseOwnedControls(ctx, f.process, terminal, syscall.Getpgrp(), nil, f.assignment, f.controls)
		close(f.done)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-f.done:
		case <-time.After(8 * time.Second):
			t.Error("control lifetime failed to join")
		}
	})
	return f
}

func deliverFixtureControl(t *testing.T, controls chan<- helperControl, delivery generated.LocalExecutionControl) string {
	t.Helper()
	control := helperControl{delivery: delivery, result: make(chan string, 1)}
	select {
	case controls <- control:
	case <-time.After(3 * time.Second):
		t.Fatal("lifetime did not accept control")
	}
	select {
	case disposition := <-control.result:
		return disposition
	case <-time.After(3 * time.Second):
		t.Fatal("lifetime did not report signal outcome")
	}
	return ""
}

func expectSignalLine(t *testing.T, lines <-chan string, want string) {
	t.Helper()
	select {
	case line := <-lines:
		if line != want {
			t.Fatalf("wanted %s, got %s", want, line)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("signal fixture did not observe", want)
	}
}

func TestControlLifetimeInterruptIsBoundAndIdempotent(t *testing.T) {
	f := fixtureControlledLifetime(t, false)
	other := ownedGateTestChild(t)
	delivery := helperDelivery(f.assignment, "interrupt", time.Now())
	if result := deliverFixtureControl(t, f.controls, delivery); result != "applied" {
		t.Fatal(result)
	}
	expectSignalLine(t, f.lines, "synthetic-int")
	for range 3 {
		if result := deliverFixtureControl(t, f.controls, delivery); result != "applied" {
			t.Fatal(result)
		}
	}
	select {
	case line := <-f.lines:
		t.Fatal("duplicate signal observed", line)
	case <-time.After(3 * processInspectionInterval):
	}
	table, err := InspectProcesses()
	if err != nil || !other.Same(table[other.PID]) || table[other.PID].Zombie || !f.process.leader.Same(table[f.process.leader.PID]) || table[f.process.leader.PID].Zombie {
		t.Fatal("interrupt targeted another group or ended the provider", err)
	}
	for _, fault := range []string{"expiry", "stale", "future", "execution", "generation", "intent", "action"} {
		control := helperDelivery(f.assignment, "interrupt", time.Now())
		switch fault {
		case "expiry":
			control.ExpiresAt = localTimestamp(time.Now().Add(-time.Second))
		case "stale":
			control.AuthorizedAt = localTimestamp(time.Now().Add(-6 * time.Second))
		case "future":
			control.AuthorizedAt = localTimestamp(time.Now().Add(time.Second))
		case "execution":
			control.RunExecutionId = fixtureBinding().ExecutionID
		case "generation":
			control.AssignmentGeneration++
		case "intent":
			control.TerminalIntentId = "e0da52a9-d0cb-47d8-867b-e08f684b9002"
		case "action":
			control.Action = "focus_existing"
		}
		if result := deliverFixtureControl(t, f.controls, control); result != "local_rejected" {
			t.Fatal("unsafe control not rejected", fault, result)
		}
	}
	select {
	case line := <-f.lines:
		t.Fatal("unsafe signal observed", line)
	case <-time.After(2 * processInspectionInterval):
	}
}

func TestControlLifetimeTerminateAndCancelWaitForNativeEnd(t *testing.T) {
	for _, action := range []string{"terminate", "cancel"} {
		t.Run(action, func(t *testing.T) {
			f := fixtureControlledLifetime(t, false)
			if result := deliverFixtureControl(t, f.controls, helperDelivery(f.assignment, action, time.Now())); result != "applied" {
				t.Fatal(result)
			}
			expectSignalLine(t, f.lines, "synthetic-term")
			_ = awaitLifetime(t, f.done)
			if f.process.lock.record.State != "released" || f.process.command.ProcessState == nil || !ownedProcessesGone(f.process.lock) {
				t.Fatal("stop skipped native end or lock release")
			}
		})
	}
}

func TestControlLifetimeReportsUnknownWhenPostSignalPersistenceFails(t *testing.T) {
	f := fixtureControlledLifetime(t, false)
	lock := f.process.lock
	lock.mu.Lock()
	lock.store.directory.writable = false
	lock.mu.Unlock()
	result := deliverFixtureControl(t, f.controls, helperDelivery(f.assignment, "interrupt", time.Now()))
	if result != "delivery_unknown" {
		t.Fatal("post-signal failure reported a retryable rejection", result)
	}
	expectSignalLine(t, f.lines, "synthetic-int")
	assertFailure(t, awaitLifetime(t, f.done), "containment_unknown")
	table, err := InspectProcesses()
	if err != nil || !f.process.leader.Same(table[f.process.leader.PID]) || table[f.process.leader.PID].Zombie || f.process.command.ProcessState != nil {
		t.Fatal("uncertain action was repeated, escalated or reaped", err)
	}
	lock.mu.Lock()
	lock.store.directory.writable = true
	lock.mu.Unlock()
}

func TestControlLifetimeEscalatesOnceAfterControlExpiry(t *testing.T) {
	f := fixtureControlledLifetime(t, true)
	delivery := helperDelivery(f.assignment, "terminate", time.Now())
	delivery.ExpiresAt = localTimestamp(time.Now().Add(2 * time.Second))
	started := time.Now()
	if result := deliverFixtureControl(t, f.controls, delivery); result != "applied" {
		t.Fatal(result)
	}
	expectSignalLine(t, f.lines, "synthetic-term")
	if result := deliverFixtureControl(t, f.controls, helperDelivery(f.assignment, "cancel", time.Now())); result != "applied" {
		t.Fatal(result)
	}
	if result := deliverFixtureControl(t, f.controls, helperDelivery(f.assignment, "interrupt", time.Now())); result != "local_rejected" {
		t.Fatal("interrupt reopened stopping provider", result)
	}
	_ = awaitLifetime(t, f.done)
	if time.Since(started) < processTerminationGrace || time.Since(started) > processTerminationGrace+3*time.Second || f.process.command.ProcessState == nil || f.process.lock.record.State != "released" {
		t.Fatal("wrong bounded shutdown")
	}
	status, ok := f.process.command.ProcessState.Sys().(syscall.WaitStatus)
	if !ok || !status.Signaled() || status.Signal() != syscall.SIGKILL {
		t.Fatal("unresponsive process did not receive verified escalation")
	}
	for line := range f.lines {
		t.Fatal("shutdown sent a second TERM", line)
	}
}

func TestControlLifetimeSurvivingAndEscapedChildren(t *testing.T) {
	binary := imageFixtureBinary(t)
	for _, scenario := range []string{"child", "escape"} {
		t.Run(scenario, func(t *testing.T) {
			process, terminal := lifetimeFixture(t, binary, scenario)
			assignment := controlAssignment(process.lock.record.Binding)
			controls, done := make(chan helperControl), make(chan error, 1)
			ctx, cancel := context.WithCancel(context.Background())
			go func() {
				done <- superviseOwnedControls(ctx, process, terminal, syscall.Getpgrp(), nil, assignment, controls)
				close(done)
			}()
			t.Cleanup(func() {
				cancel()
				select {
				case <-done:
				case <-time.After(8 * time.Second):
					t.Error("child lifetime did not join")
				}
			})
			child := awaitRecordedChild(t, process.lock, scenario == "escape")
			if scenario == "child" {
				killFixture(t, process.leader)
				awaitAbsent(t, process.leader.PID)
				if result := deliverFixtureControl(t, controls, helperDelivery(assignment, "terminate", time.Now())); result != "applied" {
					t.Fatal("surviving owned child could not stop", result)
				}
				_ = awaitLifetime(t, done)
				if process.lock.record.State != "released" || !ownedProcessesGone(process.lock) {
					t.Fatal("surviving group released early")
				}
			} else {
				if result := deliverFixtureControl(t, controls, helperDelivery(assignment, "terminate", time.Now())); result != "local_rejected" {
					t.Fatal("escape received remote signal", result)
				}
				table, err := InspectProcesses()
				if err != nil || !child.Same(table[child.PID]) || table[child.PID].Zombie || table[process.leader.PID].Zombie {
					t.Fatal("remote control killed ambiguous processes", err)
				}
				cancel()
				assertFailure(t, awaitLifetime(t, done), "containment_unknown")
			}
		})
	}
}

func TestControlSignalFixture(t *testing.T) {
	mode := os.Getenv("BFB_CONTROL_SIGNAL_FIXTURE")
	if mode == "" {
		t.Skip("compiled synthetic signal fixture")
	}
	signals := make(chan os.Signal, 8)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	fmt.Println("synthetic-control-ready")
	for sig := range signals {
		if sig == syscall.SIGINT {
			fmt.Println("synthetic-int")
		} else {
			fmt.Println("synthetic-term")
			if mode != "ignore_term" {
				os.Exit(0)
			}
		}
	}
}
