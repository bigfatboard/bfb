// ABOUTME: Requires the fresh ownership fence and maps its bounded denials at the agent bridge.
// ABOUTME: Separates terminal access closure from retryable local storage or daemon availability faults.

package agentwork

import (
	"testing"

	"github.com/qdis/bfb/internal/daemon"
)

func TestAgentBridgeRequiresOwnershipFence(t *testing.T) {
	if err := RegisterRPC(daemon.NewRegistry(), nil, nil); daemon.AsFailure(err).Code != "invalid_request" {
		t.Fatal("agent bridge registered without a production ownership check", err)
	}
}

func TestAgentOwnershipFailureMapping(t *testing.T) {
	for input, expected := range map[string]string{
		"execution_assignment_invalid": "assignment_ended", "containment_unknown": "assignment_ended",
		"storage_failed": "storage_failed", "daemon_offline": "offline_rejected",
	} {
		if actual := daemon.AsFailure(ownershipError(&daemon.Failure{Code: input})).Code; actual != expected {
			t.Fatal("native denial classification changed", input, actual)
		}
	}
}
