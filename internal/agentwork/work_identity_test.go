// ABOUTME: Pins daemon operation keys to the original TypeScript business-key canonical transcript.
// ABOUTME: Verifies execution, generation and tool scoping without incorporating payload or IPC versions.

package agentwork

import (
	"testing"

	"github.com/qdis/bfb/internal/protocol/generated"
)

func TestAgentOperationKeyMatchesBusinessCanonicalVectors(t *testing.T) {
	// Expected digests use canonicalLaunchJson's sorted fields and SHA-256,
	// independently calculated with Node's crypto implementation.
	expected := map[string]string{
		"agent_run.comment":  "agent:57909817bada4624c3ca93503db0fbccbe9768604b53281c76343caf2e2c79c5",
		"agent_run.update":   "agent:7309aaecde6f926417221ffc4900da74e8341735d2a2c8ef7c6b28027ae888dd",
		"agent_run.progress": "agent:7b7a4f65afd8f131a218a7a16bc63edb1d57569e0192f791fb14a7e5530e47de",
		"agent_run.proposal": "agent:c5c384d60db3f1ceb2f9715e88569c24e5115fd217b229925eefbb6ec4f17173",
	}
	reference := generated.AgentWorkRequest{SchemaVersion: 1, RunExecutionId: "01K6S6G0M00000000000000001", AssignmentGeneration: 7, RequestId: "synthetic-op-001"}
	for name, want := range expected {
		key, err := agentOperationKey(name, reference)
		if err != nil || key != want {
			t.Fatal("business identity differs", name, key, err)
		}
		for _, field := range []string{"execution", "generation", "request"} {
			changed := reference
			switch field {
			case "execution":
				changed.RunExecutionId = "01K6S6G0M00000000000000002"
			case "generation":
				changed.AssignmentGeneration++
			case "request":
				changed.RequestId += "-other"
			}
			other, err := agentOperationKey(name, changed)
			if err != nil || other == key {
				t.Fatal("operation key is not scoped", name, field, err)
			}
		}
	}
	for _, name := range []string{"bfb_add_comment", "mcp.v3.add_comment", "comment", "agent_run.submit_result"} {
		if _, err := agentOperationKey(name, reference); err == nil {
			t.Fatal("non-business command entered identity mapping", name)
		}
	}
	reference.SchemaVersion = 3
	if _, err := agentOperationKey("agent_run.comment", reference); err == nil {
		t.Fatal("IPC version replaced the original operation schema")
	}
}
