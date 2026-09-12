// ABOUTME: Runs the fixed one-time Terminal bootstrap as a signed foreground BFB process supervisor.
// ABOUTME: Reconstructs private execution state locally and retains occupancy independently of daemon connectivity.

//go:build darwin && cgo

package supervisor

import (
	"context"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/provider"
	"golang.org/x/sys/unix"
)

// RunHelper is used only by the fixed local __launch entry point. The registry
// is compiled locally; the intent and authenticated preparation supply no argv.
func RunHelper(ctx context.Context, paths daemon.Paths, intent string, registry *provider.Registry) error {
	if !terminalIntent.MatchString(intent) || registry == nil {
		return failure("invalid_request")
	}
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer stop()
	terminal, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return failure("execution_terminal_lost")
	}
	defer terminal.Close()
	foreground, err := unix.IoctlGetInt(int(terminal.Fd()), unix.TIOCGPGRP)
	if err != nil || foreground <= 1 || foreground != syscall.Getpgrp() {
		return failure("execution_terminal_lost")
	}
	preflight, cancel := context.WithTimeout(ctx, gatePreparationLimit)
	defer cancel()
	assignment, err := RegisterHelper(preflight, paths, intent)
	if err != nil {
		return err
	}
	execution, err := loadExecution(preflight, paths, assignment, registry, os.Environ())
	if err != nil {
		return err
	}
	defer execution.db.Close()
	locks, err := OpenLockStore(worktreeLocksPath(paths))
	if err != nil {
		return err
	}
	defer locks.Close()
	claim := assignment.Claim
	lock, err := locks.Acquire(LockBinding{ExecutionID: claim.Assignment.RunExecutionId, AssignmentGeneration: claim.Assignment.AssignmentGeneration, FencingGeneration: claim.FencingGeneration, PhysicalWorktreeHash: claim.Snapshot.PhysicalWorktreeHash})
	if err != nil {
		return err
	}
	defer lock.Close()
	self, err := os.Executable()
	if err != nil {
		if releaseErr := lock.Release(); releaseErr != nil {
			return releaseErr
		}
		return failure("peer_denied")
	}
	self, err = filepath.EvalSymlinks(self)
	if err != nil {
		if releaseErr := lock.Release(); releaseErr != nil {
			return releaseErr
		}
		return failure("peer_denied")
	}
	// This directory is trusted local daemon state, not a checkout or a cloud
	// argument. It goes directly to the child, never through the Terminal shell.
	startContext, startCancel := context.WithTimeout(ctx, gatePreparationLimit+2*finalRequestLimit)
	process, startErr := startGated(startContext, execution, lock, terminal, HelperGateCallbacks(paths, assignment), func() *exec.Cmd {
		command := exec.Command(self, "--data-dir", paths.Root, "__exec", intent)
		command.Env = NormalEnvironment(os.Environ())
		return command
	}, InspectHelper)
	startCancel()
	if process == nil {
		if err := lock.Release(); err != nil {
			return err
		}
		return startErr
	}
	// Closing the reader or the bounded startup context cannot end the owned
	// provider lifetime. Native supervision continues under the helper context.
	_ = execution.db.Close()
	return superviseOwned(ctx, process, terminal, foreground, startErr)
}
