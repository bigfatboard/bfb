// ABOUTME: Tracks kernel process identities and observed descendants of one locally owned provider group.
// ABOUTME: Refuses ambiguous signals and preserves containment uncertainty independently of parent exit.

package supervisor

import (
	"os"
	"slices"
	"syscall"

	"github.com/qdis/bfb/internal/daemon"
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
	Leader     Process         `json:"leader"`
	Observed   map[int]Process `json:"observed"`
	Unknown    bool            `json:"unknown"`
	HadEscape  bool            `json:"had_escape"`
	Incomplete bool            `json:"incomplete"`
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

// Observe records descendants while their ancestry is visible. The supported
// adapter contract forbids daemonizing; polling is not a sandbox for evasive code.
func (group *Group) Observe(table ProcessTable) GroupObservation {
	if group.Leader.GroupID != group.Leader.PID || group.Leader.UID != os.Getuid() || !group.Leader.Same(group.Observed[group.Leader.PID]) {
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
			if len(group.Observed) == maxObservedProcesses {
				group.Unknown, group.Incomplete = true, true
				continue
			}
			group.Observed[pid] = current
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
		if current.GroupID != group.Leader.GroupID {
			group.Unknown, group.HadEscape = true, true
		}
	}
	// An unobserved member could be an orphaned child, or a recycled group ID.
	// Without a known matching ancestor this cannot be upgraded to ownership.
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
	if group.Unknown {
		observation.State = "containment_unknown"
	}
	return observation
}

// Signal inspects immediately before killpg and accepts only compiled lifecycle
// signals. The supervisor keeps its direct child unreaped until the whole group
// ends, reserving the leader's PID against reuse. Signal and reap must serialize.
func (group *Group) Signal(signal syscall.Signal) error {
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
	if err := syscall.Kill(-group.Leader.GroupID, signal); err != nil {
		return failure("execution_signal_failed")
	}
	return nil
}

// ProveGone is only an inspection result. It never clears the sticky marker;
// the explicit local recovery transaction owns that state transition.
func (group *Group) ProveGone(table ProcessTable) bool {
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
