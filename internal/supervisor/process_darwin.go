// ABOUTME: Reads Darwin kernel PID, start-time, ancestry and group identities for the current user.
// ABOUTME: Excludes process arguments and environment from containment inspection.

package supervisor

import (
	"fmt"
	"os"
	"regexp"

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
		process := darwinProcess(row)
		if process.UID == os.Getuid() {
			table[process.PID] = process
		}
	}
	return table, nil
}

func darwinProcess(row unix.KinfoProc) Process {
	return Process{PID: int(row.Proc.P_pid), ParentPID: int(row.Eproc.Ppid), GroupID: int(row.Eproc.Pgid), UID: int(row.Eproc.Ucred.Uid), StartIdentity: fmt.Sprintf("%d:%d", row.Proc.P_starttime.Sec, row.Proc.P_starttime.Usec), Zombie: row.Proc.P_stat == 5}
}

var terminalDeviceName = regexp.MustCompile(`^ttys[0-9]{3,6}$`)

// controllingTTY maps a kernel device number, never a provider-supplied path.
// Both identity reads must agree around the local device lookup.
func controllingTTY(owner Process) (string, error) {
	read := func() (int32, error) {
		row, err := unix.SysctlKinfoProc("kern.proc.pid", owner.PID)
		if err != nil || row == nil || owner.UID != os.Getuid() || !owner.Same(darwinProcess(*row)) || row.Proc.P_stat == 5 || row.Eproc.Tdev == -1 {
			return 0, failure("containment_unknown")
		}
		return row.Eproc.Tdev, nil
	}
	device, err := read()
	if err != nil {
		return "", err
	}
	entries, err := os.ReadDir("/dev")
	if err != nil || len(entries) > 8192 {
		return "", failure("app_unavailable")
	}
	path := ""
	for _, entry := range entries {
		if !terminalDeviceName.MatchString(entry.Name()) {
			continue
		}
		candidate := "/dev/" + entry.Name()
		var stat unix.Stat_t
		if unix.Lstat(candidate, &stat) == nil && stat.Mode&unix.S_IFMT == unix.S_IFCHR && stat.Rdev == device {
			if path != "" {
				return "", failure("containment_unknown")
			}
			path = candidate
		}
	}
	current, err := read()
	if err != nil || current != device || path == "" {
		return "", failure("containment_unknown")
	}
	return path, nil
}
