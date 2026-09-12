// ABOUTME: Derives execution facts from fresh native process, signed-helper and authenticated lock inspection.
// ABOUTME: Keeps waiting wrappers, observed provider startup, whole-group absence and ambiguous containment distinct.

package supervisor

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"golang.org/x/sys/unix"
)

type nativeLock struct {
	Record LockRecord
	Held   bool
}

// Read-only inspection cannot initialize a missing directory, key or lock.
// A free flock is an instantaneous fact, not release or recovery authority.
func readNativeLock(paths daemon.Paths, assignment LocalAssignment) (nativeLock, error) {
	if assignment.Supervisor == nil || assignment.LockID == "" {
		return nativeLock{}, failure("containment_unknown")
	}
	locked, err := readBoundNativeLock(paths, assignment)
	if err != nil || locked.Record.LockID != assignment.LockID {
		return nativeLock{}, failure("containment_unknown")
	}
	return locked, nil
}

// Explicit local preflight recovery may inspect an unpinned marker. It still
// requires the original assignment and exact supervisor, never another owner.
func readBoundNativeLock(paths daemon.Paths, assignment LocalAssignment) (nativeLock, error) {
	if assignment.Supervisor == nil {
		return nativeLock{}, failure("containment_unknown")
	}
	directory, err := openExistingPrivateDirectory(worktreeLocksPath(paths))
	if err != nil {
		return nativeLock{}, failure("containment_unknown")
	}
	defer directory.file.Close()
	binding := assignment.lockBinding()
	fence, err := directory.open(lockName(binding.PhysicalWorktreeHash, ".lock"), unix.O_RDONLY)
	if err != nil {
		return nativeLock{}, failure("containment_unknown")
	}
	defer fence.Close()
	err = unix.Flock(int(fence.Fd()), unix.LOCK_EX|unix.LOCK_NB)
	held := errors.Is(err, unix.EWOULDBLOCK)
	if err != nil && !held {
		return nativeLock{}, failure("containment_unknown")
	}
	store := &LockStore{directory: directory}
	record, err := store.read(binding.PhysicalWorktreeHash)
	if err != nil || record.Binding != binding || record.Owner != assignment.Supervisor.Process ||
		(assignment.Group != nil && (record.Group == nil || record.Group.Leader != *assignment.Group)) {
		return nativeLock{}, failure("containment_unknown")
	}
	return nativeLock{Record: record, Held: held}, nil
}

type nativeInspector struct {
	processes func() (ProcessTable, error)
	helper    func(daemon.Peer) (SupervisorIdentity, error)
	lock      func(LocalAssignment) (nativeLock, error)
	image     func(LocalAssignment, Process) error
}

type nativeFacts struct {
	History         nativeHistory
	Capture         processCapture
	SupervisorState string
	GroupState      string
	LockState       string
	Descendants     string
	RecoveryLocal   bool
	LocalReleased   bool
	ObservedAt      time.Time
}

func unknownNative(history nativeHistory) nativeFacts {
	history.Uncertain = true
	return nativeFacts{History: history, Capture: processCapture{State: "unknown"}, SupervisorState: "ambiguous", GroupState: "unknown", LockState: "unknown", Descendants: "unknown"}
}

func (inspector nativeInspector) inspect(assignment LocalAssignment, history nativeHistory, providerObserved bool) nativeFacts {
	if assignment.Supervisor == nil {
		return unknownNative(history)
	}
	table, err := inspector.processes()
	if err != nil {
		return unknownNative(history)
	}
	owner := assignment.Supervisor
	current, present := table[owner.Process.PID]
	ownerState := "gone"
	if present && !current.Zombie {
		ownerState = "ambiguous"
		if current == owner.Process {
			checked, err := inspector.helper(daemon.Peer{UID: current.UID, PID: current.PID})
			if err == nil && checked == *owner {
				ownerState = "verified"
			}
		}
	}
	// Registration precedes preparation, acquisition and spawn. A still-live
	// signed helper in that phase is waiting, not an escaped provider.
	if assignment.LockID == "" {
		if ownerState == "gone" || history.PreflightStoppedAt != "" {
			// No final authorization was sent before pinning. The lease worker
			// closes that gate atomically before recording preflight absence.
			return nativeFacts{History: history, SupervisorState: ownerState}
		}
		if ownerState == "verified" && !history.Uncertain {
			return nativeFacts{History: history, SupervisorState: ownerState}
		}
		return unknownNative(history)
	}
	locked, err := inspector.lock(assignment)
	if err != nil {
		return unknownNative(history)
	}
	history.Group = mergeGroups(history.Group, locked.Record.Group)
	facts := nativeFacts{History: history, SupervisorState: ownerState, LockState: "gone", GroupState: "never_started", Descendants: "none"}
	if locked.Held {
		facts.LockState = "held"
	}
	if ownerState == "ambiguous" || locked.Record.State == "containment_unknown" {
		facts.History.Uncertain = true
	}
	if assignment.Group == nil && ownerState == "verified" && locked.Held && !facts.History.Uncertain {
		// Child preflight may still run bounded probes in independent groups.
		// Do not treat those as escaped provider descendants before the daemon
		// has durably registered the prepared child through execution.group.
		return facts
	}
	if locked.Record.SpawnPending {
		return unknownNative(facts.History)
	}
	group := facts.History.Group
	if group != nil {
		observation := group.Observe(table)
		facts.GroupState, facts.Descendants = observation.State, "contained"
		if group.ProveGone(table) {
			facts.GroupState, facts.Descendants = "gone", "gone"
		} else if group.HadEscape {
			facts.Descendants = "escaped"
		} else if observation.State == "containment_unknown" {
			facts.Descendants = "unknown"
		}
		facts.History.Uncertain = facts.History.Uncertain || group.Unknown
		if facts.GroupState == "live" && ownerState == "verified" && locked.Held && locked.Record.State == "owned" && !facts.History.Uncertain && assignment.Group != nil {
			facts.Capture = processCapture{State: "live"}
			if !providerObserved && inspector.image(assignment, group.Leader) == nil {
				facts.Capture.ProviderImage = true
			}
		}
	}
	// Repeat the fence and kernel checks after image/signature I/O. Marker
	// history may grow; merge it rather than racing the helper's writer.
	again, lockErr := inspector.lock(assignment)
	after, processErr := inspector.processes()
	if lockErr != nil || processErr != nil {
		return unknownNative(facts.History)
	}
	facts.History.Group = mergeGroups(facts.History.Group, again.Record.Group)
	firstBinding, secondBinding := locked, again
	firstBinding.Record.Group, secondBinding.Record.Group = nil, nil
	want, _ := json.Marshal(firstBinding)
	actual, _ := json.Marshal(secondBinding)
	if string(want) != string(actual) {
		// A normal release can occur between reads. Persist any new history,
		// but issue no live/absence fact until a stable fresh inspection.
		facts.Capture = processCapture{}
		facts.SupervisorState, facts.GroupState, facts.LockState = "", "", ""
		return facts
	}
	if ownerState == "verified" {
		checked, checkErr := inspector.helper(daemon.Peer{UID: owner.Process.UID, PID: owner.Process.PID})
		if after[owner.Process.PID] != owner.Process || checkErr != nil || checked != *owner {
			// Ordinary owner exit is retried; PID replacement is ambiguity.
			if process, exists := after[owner.Process.PID]; !exists || (process.Same(owner.Process) && process.Zombie) {
				facts.Capture = processCapture{}
				facts.SupervisorState, facts.GroupState, facts.LockState = "", "", ""
				return facts
			}
			return unknownNative(facts.History)
		}
	} else if process, exists := after[owner.Process.PID]; exists && !process.Zombie {
		return unknownNative(facts.History)
	}
	if group = facts.History.Group; group != nil {
		observation := group.Observe(after)
		facts.History.Uncertain = facts.History.Uncertain || group.Unknown
		if group.ProveGone(after) {
			facts.GroupState, facts.Descendants = "gone", "gone"
			if assignment.Group != nil {
				facts.Capture = processCapture{State: "gone"}
			}
		} else if observation.State != "live" || !locked.Held || ownerState != "verified" || facts.History.Uncertain {
			facts.History.Uncertain = true
			facts.Capture = processCapture{State: "unknown"}
			facts.GroupState = "unknown"
			facts.Descendants = "unknown"
			if group.HadEscape {
				facts.Descendants = "escaped"
			}
		}
	}
	if ownerState == "gone" && locked.Record.State != "released" {
		facts.History.Uncertain = true
	}
	if facts.History.Uncertain && facts.Capture.State != "gone" {
		facts.Capture = processCapture{State: "unknown"}
	}
	// A recovered marker must include every daemon-retained identity. An old
	// local recovery flag cannot clear a descendant discovered afterward.
	if ownerState == "gone" && !locked.Held && locked.Record.State == "released" &&
		((facts.GroupState == "gone" && facts.Descendants == "gone") || (facts.GroupState == "never_started" && facts.Descendants == "none")) {
		facts.RecoveryLocal = locked.Record.RecoveryLocal && groupCovers(locked.Record.Group, facts.History.Group)
		facts.LocalReleased = !facts.History.Uncertain || facts.RecoveryLocal
	}
	return facts
}

func groupCovers(record, observed *Group) bool {
	if observed == nil {
		return record == nil
	}
	if record == nil || record.Leader != observed.Leader || (observed.Unknown && !record.Unknown) ||
		(observed.HadEscape && !record.HadEscape) || (observed.Incomplete && !record.Incomplete) {
		return false
	}
	for pid, process := range observed.Observed {
		if record.Observed[pid] != process {
			return false
		}
	}
	return true
}
