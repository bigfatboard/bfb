// ABOUTME: Tracks kernel process identities and observed descendants of one locally owned provider group.
// ABOUTME: Refuses ambiguous signals and preserves containment uncertainty independently of parent exit.

package supervisor

import (
	"os"
	"slices"
	"strconv"
	"strings"
	"syscall"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/provider"
)

const maxObservedProcesses = 256

type Process struct {
	PID           int    `json:"pid"`
	ParentPID     int    `json:"parent_pid"`
	GroupID       int    `json:"group_id"`
	UID           int    `json:"uid"`
	StartIdentity string `json:"start_identity"`
	Zombie        bool   `json:"zombie"`
}

func (process Process) Same(other Process) bool {
	return process.PID > 0 && process.StartIdentity != "" && process.PID == other.PID && process.UID == other.UID && process.StartIdentity == other.StartIdentity
}

type ProcessTable map[int]Process

type Group struct {
	Leader          Process         `json:"leader"`
	Observed        map[int]Process `json:"observed"`
	Unknown         bool            `json:"unknown"`
	HadEscape       bool            `json:"had_escape"`
	Incomplete      bool            `json:"incomplete"`
	SupervisionMode string          `json:"supervision_mode,omitempty"`
}

type GroupObservation struct {
	State string
	Live  []Process
}

func NewGroup(leader Process) (*Group, error) {
	if leader.PID <= 1 || leader.GroupID != leader.PID || leader.UID != os.Getuid() || leader.StartIdentity == "" || leader.Zombie {
		return nil, failure("containment_unknown")
	}
	return &Group{Leader: leader, Observed: map[int]Process{leader.PID: leader}}, nil
}

func failure(code string) error { return &daemon.Failure{Code: code} }

// compareStartIdentity orders kernel start identities numerically. Darwin
// reports wall-clock seconds and microseconds while Linux reports
// boot-relative ticks, but both render as "first:second" pairs whose
// chronological order matches the numeric pair order. ok is false when
// either side is malformed; callers must fail closed.
func compareStartIdentity(first, second string) (order int, ok bool) {
	parse := func(identity string) (uint64, uint64, bool) {
		parts := strings.Split(identity, ":")
		if len(parts) != 2 {
			return 0, 0, false
		}
		major, err := strconv.ParseUint(parts[0], 10, 64)
		if err != nil {
			return 0, 0, false
		}
		minor, err := strconv.ParseUint(parts[1], 10, 64)
		if err != nil {
			return 0, 0, false
		}
		return major, minor, true
	}
	firstMajor, firstMinor, ok := parse(first)
	if !ok {
		return 0, false
	}
	secondMajor, secondMinor, ok := parse(second)
	if !ok {
		return 0, false
	}
	switch {
	case firstMajor != secondMajor:
		if firstMajor < secondMajor {
			return -1, true
		}
		return 1, true
	case firstMinor != secondMinor:
		if firstMinor < secondMinor {
			return -1, true
		}
		return 1, true
	default:
		return 0, true
	}
}

// Observe records descendants while their ancestry is visible. A backgrounded
// child whose parent already exited (reparented to PID 1 on Darwin) has no
// visible ancestry left, so the walk below can never root it. The kernel
// still proves its descent when it shares the owned group and started after
// the leader; such an orphan is adopted as an observed descendant. The
// supported adapter contract forbids daemonizing; polling is not a sandbox
// for evasive code.
func (group *Group) Observe(table ProcessTable) GroupObservation {
	root := group.SupervisionMode == provider.RootSupervision
	if group.SupervisionMode != "" && !root || group.Leader.GroupID != group.Leader.PID || group.Leader.UID != os.Getuid() || !group.Leader.Same(group.Observed[group.Leader.PID]) {
		group.Unknown = true
	}
	for changed := true; changed; {
		changed = false
		for pid, current := range table {
			if current.Zombie || current.UID != group.Leader.UID {
				continue
			}
			if _, exists := group.Observed[pid]; exists {
				continue
			}
			parent, known := group.Observed[current.ParentPID]
			if !known || !parent.Same(table[current.ParentPID]) {
				continue
			}
			if root && !validRecordedProcess(current) {
				group.Unknown = true
				continue
			}
			if len(group.Observed) == maxObservedProcesses {
				group.Unknown, group.Incomplete = true, true
				continue
			}
			group.Observed[pid] = current
			changed = true
		}
		for pid, process := range table {
			if process.Zombie || process.UID != group.Leader.UID {
				continue
			}
			if _, exists := group.Observed[pid]; exists {
				continue
			}
			if root {
				// A root-compatible execution makes no orphan-adoption claim.
				// Only ancestry seen while its recorded parent is live is usable.
				continue
			}
			if process.GroupID != group.Leader.GroupID {
				continue
			}
			if _, parentLive := table[process.ParentPID]; parentLive {
				continue
			}
			// The parent link is dead: the member was reparented after its
			// parent exited, or its parent is invisible under another UID.
			// A member with a live parent elsewhere may have joined the
			// group rather than descended from it, so only a dead parent
			// link qualifies. Only the kernel start order can then tell a
			// genuine orphan from a recycled group ID, and only a strictly
			// later start proves descent. Anything older, tied, or
			// malformed stays fail-closed in the sweep below.
			order, ok := compareStartIdentity(process.StartIdentity, group.Leader.StartIdentity)
			if !ok || order <= 0 {
				continue
			}
			if len(group.Observed) == maxObservedProcesses {
				group.Unknown, group.Incomplete = true, true
				continue
			}
			group.Observed[pid] = process
			changed = true
		}
	}
	observation := GroupObservation{State: "gone", Live: []Process{}}
	for pid, previous := range group.Observed {
		current, exists := table[pid]
		if !exists {
			continue
		}
		if !previous.Same(current) {
			group.Unknown = true
			continue
		}
		if current.Zombie {
			continue
		}
		observation.Live = append(observation.Live, current)
		if root && current.ParentPID != previous.ParentPID {
			parent, parentPresent := table[previous.ParentPID]
			// Previously proved descendant identity survives ordinary orphaning.
			// It is only lifetime evidence: MCP independently needs live root
			// ancestry, and no secondary group receives a signal.
			if pid == group.Leader.PID || current.ParentPID != 1 || parentPresent && !parent.Zombie {
				group.Unknown = true
			}
		}
		if root && current.GroupID != previous.GroupID || !root && current.GroupID != group.Leader.GroupID {
			group.Unknown, group.HadEscape = true, true
		}
	}
	// An unobserved member that the kernel does not prove started after the
	// leader (a possible recycled group ID), or that keeps a live parent
	// outside the owned group, cannot be upgraded to ownership.
	for pid, process := range table {
		if process.GroupID == group.Leader.GroupID && !process.Zombie {
			if previous, known := group.Observed[pid]; !known || !previous.Same(process) {
				group.Unknown = true
				if !known {
					if len(group.Observed) < maxObservedProcesses {
						// Remember this ambiguity so later group escape cannot hide
						// it from recovery. This does not authorize a signal.
						group.Observed[pid] = process
					} else {
						group.Incomplete = true
					}
				}
			}
		}
	}
	slices.SortFunc(observation.Live, func(a, b Process) int { return a.PID - b.PID })
	if len(observation.Live) > 0 {
		observation.State = "live"
	}
	if root {
		leader, present := table[group.Leader.PID]
		if !present || leader.Zombie {
			observation.State = "root_ended"
		}
	}
	if group.Unknown {
		observation.State = "containment_unknown"
	}
	return observation
}

// Signal inspects immediately before killpg and accepts only compiled lifecycle
// signals. The supervisor keeps its direct child unreaped until the whole group
// ends, reserving the leader's PID against reuse. Signal and reap must serialize.
func (group *Group) Signal(signal syscall.Signal) error {
	return group.signal(signal, nil)
}

// authorize is a local precondition evaluated after native inspection and
// immediately before killpg. It cannot choose or replace the owned target.
func (group *Group) signal(signal syscall.Signal, authorize func() error) error {
	if signal != syscall.SIGINT && signal != syscall.SIGTERM && signal != syscall.SIGHUP && signal != syscall.SIGKILL {
		return failure("invalid_request")
	}
	table, err := InspectProcesses()
	if err != nil {
		group.Unknown = true
		return failure("containment_unknown")
	}
	observation := group.Observe(table)
	leader := table[group.Leader.PID]
	if observation.State != "live" || !group.Leader.Same(leader) || leader.ParentPID != os.Getpid() || group.Leader.GroupID <= 1 || group.Leader.GroupID == syscall.Getpgrp() {
		return failure("containment_unknown")
	}
	if authorize != nil {
		if err := authorize(); err != nil {
			return err
		}
	}
	if err := syscall.Kill(-group.Leader.GroupID, signal); err != nil {
		return failure("execution_signal_failed")
	}
	return nil
}

// ProveGone is only an inspection result. It never clears the sticky marker;
// the explicit local recovery transaction owns that state transition.
func (group *Group) ProveGone(table ProcessTable) bool {
	if group.SupervisionMode != "" {
		// Root-compatible polling never certifies a complete detached family,
		// even when the current snapshot contains none of its known processes.
		return false
	}
	return group.KnownProcessesAbsent(table)
}

// KnownProcessesAbsent describes retained identities and the original group,
// not an unseen detached family. It grants no automatic recovery authority.
func (group *Group) KnownProcessesAbsent(table ProcessTable) bool {
	if group.Leader.PID <= 1 || len(group.Observed) == 0 || group.Incomplete {
		return false
	}
	for pid := range group.Observed {
		if current, exists := table[pid]; exists && !current.Zombie {
			return false
		}
	}
	for _, current := range table {
		if current.GroupID == group.Leader.GroupID && !current.Zombie {
			return false
		}
	}
	return true
}

func (group *Group) rootGroupAbsent(table ProcessTable) bool {
	for _, process := range table {
		if !process.Zombie && (process.PID == group.Leader.PID || process.GroupID == group.Leader.GroupID) {
			return false
		}
	}
	return true
}
