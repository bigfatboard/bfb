// ABOUTME: Reads Linux procfs identities for portable supervisor state-machine tests.
// ABOUTME: Treats unreadable or changed ownership as unavailable containment evidence.

package supervisor

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func InspectProcesses() (ProcessTable, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, failure("containment_unknown")
	}
	table := ProcessTable{}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid <= 0 {
			continue
		}
		path := filepath.Join("/proc", entry.Name())
		info, err := os.Stat(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, failure("containment_unknown")
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			return nil, failure("containment_unknown")
		}
		if stat.Uid != uint32(os.Getuid()) {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(path, "stat"))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil || len(raw) > 8192 {
			return nil, failure("containment_unknown")
		}
		end := strings.LastIndexByte(string(raw), ')')
		if end < 0 {
			return nil, failure("containment_unknown")
		}
		fields := strings.Fields(string(raw[end+1:]))
		if len(fields) < 20 {
			return nil, failure("containment_unknown")
		}
		parent, e1 := strconv.Atoi(fields[1])
		group, e2 := strconv.Atoi(fields[2])
		start, e3 := strconv.ParseUint(fields[19], 10, 64)
		if e1 != nil || e2 != nil || e3 != nil || start == 0 {
			return nil, failure("containment_unknown")
		}
		table[pid] = Process{PID: pid, ParentPID: parent, GroupID: group, UID: int(stat.Uid), StartIdentity: fmt.Sprintf("%d:0", start), Zombie: fields[0] == "Z" || fields[0] == "X"}
	}
	return table, nil
}
