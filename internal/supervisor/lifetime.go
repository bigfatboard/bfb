// ABOUTME: Keeps the foreground supervisor alive until its whole owned provider group has ended.
// ABOUTME: Serializes verified local shutdown, lock disposition, foreground restoration and final child reaping.

package supervisor

import (
	"context"
	"os"
	"syscall"
	"time"
)

const processInspectionInterval = 100 * time.Millisecond
const processTerminationGrace = 5 * time.Second

// superviseOwned receives a successfully created child even when its exec gate
// failed. It never reads provider stdio. Cloud/daemon availability is unrelated
// to local lock lifetime, and a provider exit does not submit a run result.
func superviseOwned(ctx context.Context, process *gatedProcess, terminal *os.File, foreground int, startErr error) error {
	if process == nil || process.command == nil || process.command.Process == nil || process.lock == nil || terminal == nil || foreground <= 1 {
		return failure("invalid_request")
	}
	lock := process.lock
	defer lock.Close() // Only a verified Release clears durable occupancy.
	lock.mu.Lock()
	bound := lock.record.Group != nil && lock.record.Group.Leader == process.leader
	lock.mu.Unlock()
	if !validRecordedProcess(process.leader) || process.leader.ParentPID != os.Getpid() || process.command.Process.Pid != process.leader.PID || !bound {
		// A pending spawn without captured identity cannot be made safe by
		// waiting/reaping one PID and forgetting possible descendants.
		return failure("containment_unknown")
	}
	ticker := time.NewTicker(processInspectionInterval)
	defer ticker.Stop()
	var stopping time.Time
	terminationSent, killSent := false, false
	for {
		observation, err := lock.Observe()
		if err == nil && observation.State == "gone" {
			return finishOwned(process, terminal, foreground, startErr, true)
		}
		if err != nil || observation.State == "containment_unknown" {
			if ownedProcessesGone(lock) {
				// Proven absence permits reaping, not automatic recovery of a
				// sticky escape, incomplete write or historical ambiguity.
				return finishOwned(process, terminal, foreground, failure("containment_unknown"), false)
			}
			if ctx.Err() != nil {
				return failure("containment_unknown")
			}
		} else if observation.State != "live" {
			return failure("containment_unknown")
		}
		if ctx.Err() != nil && stopping.IsZero() {
			stopping = time.Now()
		}
		if !stopping.IsZero() && observation.State == "live" && err == nil {
			if !terminationSent {
				// A local supervisor shutdown uses a fixed TERM/KILL policy.
				// Every signal repeats native ownership checks under the lock.
				terminationSent = true
				if err := lock.Signal(syscall.SIGTERM); err != nil {
					if fresh, inspectErr := lock.Observe(); inspectErr == nil && fresh.State == "gone" {
						return finishOwned(process, terminal, foreground, startErr, true)
					}
					return failure("containment_unknown")
				}
			} else if !killSent && time.Since(stopping) >= processTerminationGrace {
				killSent = true
				if err := lock.Signal(syscall.SIGKILL); err != nil {
					if fresh, inspectErr := lock.Observe(); inspectErr == nil && fresh.State == "gone" {
						return finishOwned(process, terminal, foreground, startErr, true)
					}
					return failure("containment_unknown")
				}
			}
		}
		// A cancelled context must not turn this into a busy loop or cause
		// early reaping. Continue native observation through verified group end.
		if stopping.IsZero() {
			select {
			case <-ctx.Done():
			case <-ticker.C:
			}
		} else {
			<-ticker.C
		}
	}
}

func ownedProcessesGone(lock *WorktreeLock) bool {
	lock.mu.Lock()
	defer lock.mu.Unlock()
	if lock.record.SpawnPending || lock.record.Group == nil {
		return false
	}
	table, err := InspectProcesses()
	return err == nil && lock.record.Group.ProveGone(table)
}

// finishOwned runs only after whole-group absence. Foreground restoration takes
// place while the original child PID is still reserved; no concurrent goroutine
// may signal or reap this child. A closed terminal cannot stop final reaping.
func finishOwned(process *gatedProcess, terminal *os.File, foreground int, prior error, release bool) error {
	var lockErr error
	if release {
		lockErr = process.lock.Release()
	} else {
		lockErr = process.lock.Close()
	}
	if lockErr != nil {
		_ = process.lock.Close()
	}
	_, terminalErr := RestoreForeground(int(terminal.Fd()), process.leader.GroupID, foreground)
	_ = process.command.Wait()
	if lockErr != nil {
		return failure("containment_unknown")
	}
	if prior != nil {
		return prior
	}
	return terminalErr
}
