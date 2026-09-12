// ABOUTME: Verifies that local registration commits native identity before returning private assignment data.
// ABOUTME: Covers duplicate replies, malformed payloads, changed process identity and strict response binding.

package supervisor

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
)

func TestRegistrationRPCCommitsBeforeReplyAndReconcilesSameHelper(t *testing.T) {
	intents, local, claim, now := fixtureIntents(t)
	assignment := issueFixture(t, intents, claim, now)
	if offered, err := intents.Offer(context.Background(), assignment.IntentID); err != nil || !offered {
		t.Fatal("offer", err)
	}
	table, err := InspectProcesses()
	if err != nil {
		t.Fatal(err)
	}
	self := SupervisorIdentity{Process: table[os.Getpid()], ExecutableHash: "sha256:" + strings.Repeat("a", 64)}
	service := NewService(ServiceOptions{Now: func() time.Time { return now }, InspectHelper: func(peer daemon.Peer) (SupervisorIdentity, error) {
		if peer.PID != self.Process.PID || peer.UID != self.Process.UID {
			return SupervisorIdentity{}, failure("peer_denied")
		}
		return self, nil
	}})
	registry := daemon.NewRegistry()
	if err := RegisterRPC(registry, service); err != nil {
		t.Fatal(err)
	}
	server, err := daemon.Start(context.Background(), local.Paths, registry)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Close)
	var original []byte
	for range 2 {
		response, err := daemon.Call(context.Background(), local.Paths, "execution.register", map[string]any{"terminal_intent_id": assignment.IntentID})
		if err != nil {
			t.Fatal(err)
		}
		registered, err := registeredResponse(response.Payload, assignment.IntentID, self, now)
		if err != nil || registered.Supervisor != self.wire() {
			t.Fatal("incorrect registered reply", err)
		}
		stored, err := intents.ByIntent(context.Background(), assignment.IntentID)
		if err != nil || stored.Supervisor == nil || *stored.Supervisor != self || stored.State != "registered" {
			t.Fatal("reply preceded durable registration", err)
		}
		data, _ := json.Marshal(registered)
		if original != nil && string(original) != string(data) {
			t.Fatal("lost reply minted another assignment")
		}
		original = data
	}
	for _, payload := range []map[string]any{
		nil, {"terminal_intent_id": claim.Specification.LaunchId},
		{"terminal_intent_id": assignment.IntentID, "daemon_pid": os.Getpid()},
	} {
		if _, err := daemon.Call(context.Background(), local.Paths, "execution.register", payload); err == nil {
			t.Fatal("ambiguous registration payload accepted")
		}
	}
	var wire generated.LocalExecutionAssignment
	_ = json.Unmarshal(original, &wire)
	for _, fault := range []string{"intent", "identity", "claim", "expired", "correlation"} {
		t.Run(fault, func(t *testing.T) {
			copy := wire
			at := now
			switch fault {
			case "intent":
				copy.TerminalIntentId = "00000000-0000-4000-8000-000000000001"
			case "identity":
				copy.Supervisor.Pid++
			case "claim":
				copy.Claim.Specification.AssignmentGeneration++
			case "expired":
				at = now.Add(2 * time.Minute)
			case "correlation":
				copy.CorrelationToken = copy.CorrelationToken[:42] + "_"
			}
			if _, err := registeredResponse(map[string]any{"execution_assignment": copy}, assignment.IntentID, self, at); err == nil {
				t.Fatal("confused response accepted")
			}
		})
	}
}
