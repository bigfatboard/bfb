// ABOUTME: Reads Darwin kernel process identity for stdio peers and private RPC callers.
// ABOUTME: Mirrors L05 start-identity formatting so assignment comparisons stay exact.

package localmcp

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

func inspectParent() (PeerFacts, error) {
	return inspectProcess(os.Getppid())
}

func inspectProcess(pid int) (PeerFacts, error) {
	row, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil || row == nil {
		return PeerFacts{}, fail("peer_denied")
	}
	if row.Proc.P_pid != int32(pid) || row.Proc.P_starttime.Sec <= 0 || row.Proc.P_stat == 5 {
		return PeerFacts{}, fail("peer_denied")
	}
	return PeerFacts{
		UID:           int(row.Eproc.Ucred.Uid),
		PID:           int(row.Proc.P_pid),
		ParentPID:     int(row.Eproc.Ppid),
		StartIdentity: fmt.Sprintf("%d:%d", row.Proc.P_starttime.Sec, row.Proc.P_starttime.Usec),
		GroupID:       int(row.Eproc.Pgid),
	}, nil
}
