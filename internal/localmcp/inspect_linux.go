// ABOUTME: Reads Linux procfs identity for the MCP server's parent process only.
// ABOUTME: Mirrors L05 start-identity formatting so assignment comparisons stay exact.

package localmcp

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func inspectParent() (PeerFacts, error) {
	parent := os.Getppid()
	path := filepath.Join("/proc", strconv.Itoa(parent))
	info, err := os.Stat(path)
	if err != nil {
		return PeerFacts{}, fail("peer_denied")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return PeerFacts{}, fail("peer_denied")
	}
	raw, err := os.ReadFile(filepath.Join(path, "stat"))
	if err != nil || len(raw) > 8192 {
		return PeerFacts{}, fail("peer_denied")
	}
	end := strings.LastIndexByte(string(raw), ')')
	if end < 0 {
		return PeerFacts{}, fail("peer_denied")
	}
	fields := strings.Fields(string(raw[end+1:]))
	if len(fields) < 20 {
		return PeerFacts{}, fail("peer_denied")
	}
	group, err := strconv.Atoi(fields[2])
	if err != nil {
		return PeerFacts{}, fail("peer_denied")
	}
	start, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil || start == 0 {
		return PeerFacts{}, fail("peer_denied")
	}
	if fields[0] == "Z" || fields[0] == "X" {
		return PeerFacts{}, fail("peer_denied")
	}
	return PeerFacts{
		UID:           int(stat.Uid),
		PID:           parent,
		StartIdentity: fmt.Sprintf("%d:0", start),
		GroupID:       group,
	}, nil
}
