// ABOUTME: Reads Darwin kernel identity for the MCP server's parent process only.
// ABOUTME: Mirrors L05 start-identity formatting so assignment comparisons stay exact.

package localmcp

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

func inspectParent() (PeerFacts, error) {
	parent := os.Getppid()
	row, err := unix.SysctlKinfoProc("kern.proc.pid", parent)
	if err != nil || row == nil {
		return PeerFacts{}, fail("peer_denied")
	}
	if row.Proc.P_pid != int32(parent) || row.Proc.P_starttime.Sec <= 0 || row.Proc.P_stat == 5 {
		return PeerFacts{}, fail("peer_denied")
	}
	return PeerFacts{
		UID:           int(row.Eproc.Ucred.Uid),
		PID:           int(row.Proc.P_pid),
		StartIdentity: fmt.Sprintf("%d:%d", row.Proc.P_starttime.Sec, row.Proc.P_starttime.Usec),
		GroupID:       int(row.Eproc.Pgid),
	}, nil
}
