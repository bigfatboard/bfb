// ABOUTME: Rejects caller-selected process identity and unsigned helpers before local registration.
// ABOUTME: Real signed-build acceptance is exercised separately through the native helper harness.

package supervisor

import (
	"os"
	"os/exec"
	"testing"

	"github.com/qdis/bfb/internal/daemon"
)

func TestHelperInspectionRejectsUntrustedProcesses(t *testing.T) {
	child := exec.Command("/bin/sleep", "10")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	for _, peer := range []daemon.Peer{
		{UID: os.Getuid(), PID: os.Getpid()},
		{UID: os.Getuid() + 1, PID: os.Getpid()},
		{UID: os.Getuid(), PID: 0},
		{UID: os.Getuid(), PID: 1},
		{UID: os.Getuid(), PID: child.Process.Pid},
	} {
		if _, err := InspectHelper(peer); daemon.AsFailure(err).Code != "peer_denied" {
			t.Fatal("untrusted helper accepted", peer)
		}
	}
}
