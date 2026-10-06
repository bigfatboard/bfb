// ABOUTME: Pins bounded JSON-RPC diagnostics for protected result admission failures.
// ABOUTME: Preserves existing mapped values while giving result conflicts and capture failures explicit codes.

package localmcp

import (
	"bufio"
	"bytes"
	"encoding/json"
	"testing"
)

func TestResultAdmissionJSONRPCErrors(t *testing.T) {
	for _, fixture := range []struct {
		reason  string
		code    int
		message string
	}{
		{"assignment_ended", -32003, "Access to this local execution is closed. The provider process may still be running."},
		{"invalid_transition", -32021, "The current state does not permit a new result submission."},
		{"request_conflict", -32022, "This operation identity is already bound to different input."},
		{"capture_invalid", -32023, "Complete current capture authority could not be verified."},
		{"intent_expired", -32024, "The original delivery window has expired."},
		{"capacity_exceeded", -32025, "Local work storage is full; unresolved outcomes were preserved."},
		{"storage_failed", -32026, "Local storage could not be verified; existing evidence was preserved."},
	} {
		t.Run(fixture.reason, func(t *testing.T) {
			code, message := jsonRPCCode(fixture.reason)
			if code != fixture.code || message != fixture.message {
				t.Fatal("unstable result diagnostic", code, message)
			}
			var output bytes.Buffer
			server := &Server{}
			server.writeError(bufio.NewWriter(&output), 7, fail(fixture.reason))
			var response struct{ Error jsonRPCError }
			if json.Unmarshal(output.Bytes(), &response) != nil || response.Error.Code != code || response.Error.Message != message || response.Error.Data == nil || response.Error.Data.BFBCode != fixture.reason {
				t.Fatal("typed result reason lost", output.String())
			}
		})
	}
	for reason, want := range map[string]int{"request_rejected": -32015, "work_unavailable": -32020, "policy_rejected": -32012, "forbidden": -32011} {
		if code, _ := jsonRPCCode(reason); code != want {
			t.Fatal("existing mapped wire value changed", reason, code)
		}
	}
	if code, _ := jsonRPCCode("unknown_failure"); code != -32603 {
		t.Fatal("unknown code did not stay bounded")
	}
}
