// ABOUTME: Derives signed helper identity from a kernel-authenticated local socket peer.
// ABOUTME: Pins the exact daemon build and executable fingerprint before an intent exposes local data.

package supervisor

import (
	"os"

	"github.com/qdis/bfb/internal/appbridge"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/provider"
)

func InspectHelper(peer daemon.Peer) (SupervisorIdentity, error) {
	if peer.UID != os.Getuid() || peer.PID <= 1 {
		return SupervisorIdentity{}, failure("peer_denied")
	}
	beforeTable, err := InspectProcesses()
	before := beforeTable[peer.PID]
	if err != nil || !validRecordedProcess(before) || before.Zombie || before.UID != peer.UID {
		return SupervisorIdentity{}, failure("peer_denied")
	}
	path, err := appbridge.HelperExecutable(peer)
	if err != nil {
		return SupervisorIdentity{}, failure("peer_denied")
	}
	stamp, err := provider.FingerprintExecutable(path)
	if err != nil {
		return SupervisorIdentity{}, failure("peer_denied")
	}
	checkedPath, err := appbridge.HelperExecutable(peer)
	if err != nil || checkedPath != path {
		return SupervisorIdentity{}, failure("peer_denied")
	}
	checkedStamp, err := provider.FingerprintExecutable(path)
	if err != nil || checkedStamp != stamp {
		return SupervisorIdentity{}, failure("peer_denied")
	}
	afterTable, err := InspectProcesses()
	after := afterTable[peer.PID]
	if err != nil || !before.Same(after) || after.Zombie || before.ParentPID != after.ParentPID || before.GroupID != after.GroupID {
		return SupervisorIdentity{}, failure("peer_denied")
	}
	return SupervisorIdentity{Process: after, ExecutableHash: stamp.Hash}, nil
}
