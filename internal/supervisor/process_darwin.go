// ABOUTME: Reads Darwin kernel PID, start-time, ancestry and group identities for the current user.
// ABOUTME: Excludes process arguments and environment from containment inspection.

package supervisor

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

func InspectProcesses() (ProcessTable, error) {
	rows, err := unix.SysctlKinfoProcSlice("kern.proc.uid", os.Getuid())
	if err != nil {
		return nil, failure("containment_unknown")
	}
	table := ProcessTable{}
	for _, row := range rows {
		if row.Proc.P_pid <= 0 || row.Proc.P_starttime.Sec <= 0 {
			return nil, failure("containment_unknown")
		}
		process := Process{PID: int(row.Proc.P_pid), ParentPID: int(row.Eproc.Ppid), GroupID: int(row.Eproc.Pgid), UID: int(row.Eproc.Ucred.Uid), StartIdentity: fmt.Sprintf("%d:%d", row.Proc.P_starttime.Sec, row.Proc.P_starttime.Usec), Zombie: row.Proc.P_stat == 5}
		if process.UID == os.Getuid() {
			table[process.PID] = process
		}
	}
	return table, nil
}
