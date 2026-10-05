// ABOUTME: Holds an actual authenticated worktree lock around a synthetic provider-shaped child.
// ABOUTME: Uses the same signed daemon image so native inspection proves helper identity without a GUI.

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/supervisor"
)

func fixtureSupervise(root, childPath, argument, initialBinding string) int {
	locks, err := supervisor.OpenLockStore(filepath.Join(root, "worktree-locks"))
	if err != nil {
		return 2
	}
	defer locks.Close()
	self, err := os.Executable()
	if err != nil {
		return 2
	}
	stamp, err := provider.FingerprintExecutable(self)
	if err != nil {
		return 2
	}
	table, err := supervisor.InspectProcesses()
	if err != nil {
		return 2
	}
	owner := supervisor.SupervisorIdentity{Process: table[os.Getpid()], ExecutableHash: stamp.Hash}
	child := exec.Command(childPath, argument)
	child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	child.Env, child.Stderr = os.Environ(), os.Stderr
	input, err := child.StdinPipe()
	if err != nil {
		return 2
	}
	output, err := child.StdoutPipe()
	if err != nil || child.Start() != nil {
		return 2
	}
	defer func() { _ = input.Close(); _ = child.Wait() }()
	reader := bufio.NewReaderSize(output, 65537)
	line, err := reader.ReadBytes('\n')
	var leader supervisor.Process
	if err != nil || json.Unmarshal(line, &leader) != nil {
		return 2
	}
	var lock *supervisor.WorktreeLock
	defer func() {
		if lock != nil {
			_ = lock.Close()
		}
	}()
	attach := func(encoded string) bool {
		var binding supervisor.LockBinding
		if json.Unmarshal([]byte(encoded), &binding) != nil {
			return false
		}
		if lock != nil {
			_ = lock.Close()
		}
		lock, err = locks.Acquire(binding)
		if err != nil || lock.Attach(leader) != nil {
			return false
		}
		// LockID is derived by the real acquisition, never supplied by this fixture.
		// Read back only the ID for fixture seeding. Production inspection still
		// independently verifies this authenticated marker and the held flock.
		data, err := os.ReadFile(filepath.Join(root, "worktree-locks", strings.TrimPrefix(binding.PhysicalWorktreeHash, "sha256:")+".json"))
		var envelope struct {
			Record supervisor.LockRecord `json:"record"`
		}
		if err != nil || json.Unmarshal(data, &envelope) != nil {
			return false
		}
		facts, _ := json.Marshal(map[string]any{"leader": leader, "owner": owner, "lock_id": envelope.Record.LockID})
		fmt.Println(string(facts))
		return true
	}
	if !attach(initialBinding) {
		return 2
	}
	done := make(chan struct{})
	go func() { _, _ = io.Copy(os.Stdout, reader); close(done) }()
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 65536)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "__unlock" {
			// Keep both native processes alive and leave the authenticated marker
			// untouched; only the actual flock is released for the fence test.
			if lock == nil || lock.Close() != nil {
				return 2
			}
		} else if strings.HasPrefix(line, "__ownership:") {
			if !attach(strings.TrimPrefix(line, "__ownership:")) {
				return 2
			}
		} else if _, err := io.WriteString(input, line+"\n"); err != nil {
			return 2
		}
	}
	_ = input.Close()
	<-done
	return 0
}
