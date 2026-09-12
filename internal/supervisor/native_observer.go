// ABOUTME: Captures daemon-observed execution lifecycle independently of the durable launch queue and cloud I/O.
// ABOUTME: Persists descendant history before event capture and never reconstructs missed heartbeat intervals.

package supervisor

import (
	"context"
	"time"

	"github.com/qdis/bfb/internal/daemon"
)

func (service *Service) nativeInspector(paths daemon.Paths, files *AssignmentFiles) nativeInspector {
	return nativeInspector{
		processes: InspectProcesses, helper: service.options.InspectHelper,
		lock: func(assignment LocalAssignment) (nativeLock, error) { return readNativeLock(paths, assignment) },
		image: func(assignment LocalAssignment, process Process) error {
			var preparation LaunchPreparation
			if files.directory.read(assignment.IntentID+".preparation.json", &preparation) != nil || !preparation.matches(assignment.IntentID, assignment.ProviderIdentityHash, assignment.Claim) {
				return failure("execution_assignment_invalid")
			}
			return inspectProviderImage(process, preparation)
		},
	}
}

func (service *Service) runObserver(ctx context.Context, store *IntentStore, files *AssignmentFiles, paths daemon.Paths) {
	if service.options.Connection == nil {
		<-ctx.Done()
		return
	}
	inspector := service.nativeInspector(paths, files)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for ctx.Err() == nil {
		assignments, err := store.supervised(ctx)
		if err == nil {
			for _, assignment := range assignments {
				if ctx.Err() != nil {
					return
				}
				_, _ = service.observeNative(ctx, store, inspector, assignment)
			}
		}
		_ = store.closeEventWindows(ctx, service.options.Now())
		select {
		case <-ctx.Done():
		case <-ticker.C:
		}
	}
}

func (service *Service) observeNative(ctx context.Context, store *IntentStore, inspector nativeInspector, assignment LocalAssignment) (nativeFacts, error) {
	service.nativeMu.Lock()
	defer service.nativeMu.Unlock()
	history, err := readNativeHistory(ctx, store.db, assignment)
	if err != nil {
		return nativeFacts{}, err
	}
	checkpoint, err := store.observationCheckpoint(ctx, assignment.IntentID)
	if err != nil {
		return nativeFacts{}, err
	}
	started := service.options.Now()
	facts := inspector.inspect(assignment, history, checkpoint.ProviderObserved != "")
	// Native inspection cannot lose an observed descendant merely because the
	// event sink is full. The helper's own HMAC marker remains single-writer.
	facts.History, err = store.rememberNative(ctx, assignment, facts.History)
	if err != nil {
		return nativeFacts{}, err
	}
	now := service.options.Now()
	if now.Before(started) || now.Sub(started) > finalRequestLimit {
		return nativeFacts{}, failure("containment_unknown")
	}
	if checkpoint.ProcessAbsent != "" {
		return facts, nil
	}
	if facts.History.Uncertain || (facts.History.Group != nil && facts.History.Group.Unknown) {
		if _, err = store.captureProcess(ctx, assignment, processCapture{State: "unknown"}, now); err != nil {
			return facts, err
		}
		if facts.Capture.State != "gone" {
			return facts, nil
		}
	}
	if facts.Capture.State != "" {
		_, err = store.captureProcess(ctx, assignment, facts.Capture, now)
	}
	return facts, err
}

// RecoverLocal is a local inspection operation, not a runner-command handler.
// Serializing with capture prevents recovery from racing a new remembered PID.
// CLI/RPC exposure must authenticate its local caller; no cloud path calls it.
func (service *Service) RecoverLocal(ctx context.Context, intent string) error {
	if !terminalIntent.MatchString(intent) {
		return failure("invalid_request")
	}
	service.mu.RLock()
	defer service.mu.RUnlock()
	service.nativeMu.Lock()
	defer service.nativeMu.Unlock()
	if service.store == nil {
		return failure("daemon_offline")
	}
	assignment, err := service.store.ByIntent(ctx, intent)
	if err != nil || assignment.Supervisor == nil || assignment.LockID == "" {
		return failure("containment_unknown")
	}
	history, err := readNativeHistory(ctx, service.store.db, assignment)
	if err != nil {
		return err
	}
	if _, err := readNativeLock(service.paths, assignment); err != nil {
		return err
	}
	// Opening existing private state cannot repair or fabricate missing proof.
	directory, err := openExistingPrivateDirectory(worktreeLocksPath(service.paths))
	if err != nil {
		return failure("containment_unknown")
	}
	defer directory.file.Close()
	// Only this explicit local operation may publish a recovered marker. The
	// directory and key were opened without creation; recovery also opens an
	// existing fence, so missing evidence cannot be initialized into absence.
	directory.writable = true
	locks := &LockStore{directory: directory}
	return locks.recoverLocal(assignment.lockBinding(), history.Group)
}
