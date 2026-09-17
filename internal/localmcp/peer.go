// ABOUTME: Verifies the stdio peer against the immutable assignment before any capability exists.
// ABOUTME: Checks UID, provider-process ancestry/group, assignment state, and correlation in order.

package localmcp

import (
	"crypto/subtle"
	"os"

	"github.com/qdis/bfb/internal/supervisor"
)

// PeerFacts describes the connecting MCP client process as observed by the OS.
// Production facts come from OSInspector; tests inject synthetic facts.
type PeerFacts struct {
	// UID is the peer's user identity. It must equal the daemon UID.
	UID int
	// PID is the peer process identifier (normally our parent: the provider CLI).
	PID int
	// StartIdentity is the kernel start identity of the peer process.
	StartIdentity string
	// GroupID is the peer's process group.
	GroupID int
}

// Inspector collects peer facts from the operating system.
type Inspector interface {
	Inspect() (PeerFacts, error)
}

// osInspector collects facts about our parent process using native inspection.
type osInspector struct{}

func (osInspector) Inspect() (PeerFacts, error) {
	parent := os.Getppid()
	table, err := supervisor.InspectProcesses()
	if err != nil {
		return PeerFacts{}, fail("peer_denied")
	}
	record, ok := table[parent]
	if !ok || record.Zombie {
		return PeerFacts{}, fail("peer_denied")
	}
	return PeerFacts{
		UID:           record.UID,
		PID:           record.PID,
		StartIdentity: record.StartIdentity,
		GroupID:       record.GroupID,
	}, nil
}

// OSInspector is the production peer inspector. It reports our parent process
// (the provider CLI that spawned this stdio server) from native OS state.
func OSInspector() Inspector { return osInspector{} }

// VerifyPeer enforces the four ordered checks from docs/contracts/local-mcp.md:
// UID equality, provider-process ancestry/group membership, active assignment,
// and constant-time correlation comparison. It returns nil only when all pass.
func VerifyPeer(facts PeerFacts, daemonUID int, assignment AssignmentRecord, correlation string) error {
	if facts.UID != daemonUID {
		return fail("peer_denied")
	}
	if !assignment.Known {
		return fail("assignment_unknown")
	}
	if !assignment.Active {
		return fail("assignment_ended")
	}
	if !peerInOwnedGroup(facts, assignment) {
		return fail("peer_denied")
	}
	if len(correlation) == 0 ||
		subtle.ConstantTimeCompare([]byte(correlation), []byte(assignment.CorrelationToken)) != 1 {
		return fail("correlation_rejected")
	}
	return nil
}

// peerInOwnedGroup requires the peer to be the recorded provider process or a
// live member of the assignment's owned process group. One of the two must
// hold: without either, containment is unproven and the peer fails closed.
func peerInOwnedGroup(facts PeerFacts, assignment AssignmentRecord) bool {
	if assignment.ProviderPID > 0 && facts.PID == assignment.ProviderPID &&
		facts.StartIdentity != "" && facts.StartIdentity == assignment.ProviderStart {
		return true
	}
	if assignment.OwnedGroupID > 0 && facts.GroupID == assignment.OwnedGroupID {
		return true
	}
	return false
}
