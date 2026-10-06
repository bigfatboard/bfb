// ABOUTME: Tests result v5 Host admission without legacy activation or provider-owned result journaling.
// ABOUTME: Proves restarted clients recontact the daemon, preserve input and retain only bounded identity.

package localmcp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

func resultFixture(t *testing.T, name string) map[string]any {
	t.Helper()
	root, err := protocol.RepositoryRoot()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "protocol/fixtures/v5/local-agent-result-rpc.json"))
	if err != nil {
		t.Fatal(err)
	}
	var matrix struct{ Fixtures []struct{ Name, JSON string } }
	if json.Unmarshal(data, &matrix) != nil {
		t.Fatal("invalid fixture")
	}
	for _, entry := range matrix.Fixtures {
		if entry.Name == name {
			var value map[string]any
			if json.Unmarshal([]byte(entry.JSON), &value) != nil {
				t.Fatal("invalid fixture value")
			}
			return value
		}
	}
	t.Fatal("fixture missing", name)
	return nil
}

func TestResultReceiptScopeAndClosedPrivacy(t *testing.T) {
	value := resultFixture(t, "receipt.pending")
	reference := generated.AgentWorkRequest{SchemaVersion: 1, RunExecutionId: "01K6R7DT00AAAAAAAAAAAAAAAA", AssignmentGeneration: 1, RequestId: "result-fixture-001"}
	if _, err := checkedAgentResultReceipt(value, reference); err != nil {
		t.Fatal("valid receipt rejected", err)
	}
	for _, field := range []string{"operation_key", "request_id", "tool", "reason_code", "effect_certainty", "summary", "capture", "confirmation", "signature"} {
		t.Run(field, func(t *testing.T) {
			clone := map[string]any{}
			for key, nested := range value {
				clone[key] = nested
			}
			switch field {
			case "operation_key":
				clone[field] = "agent:" + strings.Repeat("0", 64)
			case "request_id":
				clone[field] = "another-request-001"
			case "tool":
				clone[field] = "bfb_add_comment"
			case "effect_certainty":
				clone[field] = "confirmed"
			default:
				clone[field] = "private-synthetic"
			}
			if _, err := checkedAgentResultReceipt(clone, reference); err == nil {
				t.Fatal("private/foreign receipt admitted")
			}
		})
	}
}

func TestResultRPCChecksCommittedOriginAndActivatedAssertion(t *testing.T) {
	for _, field := range []string{"none", "run_id", "run_execution_id", "assignment_generation", "provider_session_id"} {
		t.Run(field, func(t *testing.T) {
			dir, err := os.MkdirTemp("", "bfb-result-rpc-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.RemoveAll(dir) })
			paths, err := daemon.StatePaths(dir)
			if err != nil {
				t.Fatal(err)
			}
			result := resultFixture(t, "result.committed")
			id := "01K6R7DT00AAAAAAAAAAAAAAAA"
			sessionID := "01K6R7DT00BBBBBBBBBBBBBBBB"
			origin := result["origin"].(map[string]any)
			if field != "none" {
				if field == "assignment_generation" {
					origin[field] = float64(2)
				} else {
					origin[field] = "01K6R7DT00CCCCCCCCCCCCCCCC"
				}
			}
			observed := make(chan map[string]any, 1)
			registry := daemon.NewRegistry()
			if err := registry.Register("mcp.v5.submit_result", func(_ context.Context, request daemon.Request) (map[string]any, error) {
				observed <- request.Envelope.Payload["agent_result_request"].(map[string]any)
				return map[string]any{"agent_result": result}, nil
			}); err != nil {
				t.Fatal(err)
			}
			server, err := daemon.Start(context.Background(), paths, registry)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(server.Close)
			boundary := Boundary{WorkspaceID: id, ProjectID: id, TaskID: id, RunID: id, ExecutionID: id, RunnerID: id, CheckoutID: id, Generation: 1}
			session := ConfirmedSession{ProviderSessionId: sessionID, Provider: "fake", ObservedSessionId: "synthetic-session"}
			_, err = (RPCTransport{Paths: paths, Correlation: "synthetic-correlation"}).AdmitResult(context.Background(), boundary, &session, map[string]any{"summary": "  Synthetic original  ", "limitations": "", "evidence_refs": []any{}}, "result-rpc-001")
			if field == "none" {
				if err != nil {
					t.Fatal(err)
				}
			} else if CodeOf(err) != "boundary_escape" {
				t.Fatal("foreign committed origin delivered", field, err)
			}
			local := <-observed
			if local["expected_binding"] == nil {
				t.Fatal("activated assertion not sent")
			}
			input := local["request"].(map[string]any)
			if input["summary"] != "  Synthetic original  " || input["limitations"] != "" || len(input["evidence_refs"].([]any)) != 0 {
				t.Fatal("original input changed", input)
			}
			if _, present := input["binding"]; present {
				t.Fatal("binding embedded into client body")
			}
		})
	}
}

type resultFixtureTransport struct {
	*admissionFixtureTransport
	resultCalls int
	expected    *ConfirmedSession
	result      any
	resultErr   error
}

func (transport *resultFixtureTransport) AdmitResult(_ context.Context, _ Boundary, expected *ConfirmedSession, params map[string]any, _ string) (any, error) {
	transport.resultCalls++
	transport.expected = expected
	transport.params = params
	return transport.result, transport.resultErr
}

func resultFixtureHost() (*Host, *Capability, *fakeBindings, *fakeAuthority, *resultFixtureTransport) {
	_, capability, bindings, authority, work := admissionFixtureHost()
	transport := &resultFixtureTransport{admissionFixtureTransport: work, result: generated.AgentResultResult{Version: 1, ResultState: "submitted", TaskState: "review"}}
	return NewHost(HostDeps{Capability: capability, Transport: transport}), capability, bindings, authority, transport
}

func TestProvisionalResultRetryDoesNotRequireLegacyActivation(t *testing.T) {
	for _, code := range []string{"offline_rejected", "capability_closed", "assignment_ended"} {
		t.Run(code, func(t *testing.T) {
			host, capability, _, authority, transport := resultFixtureHost()
			authority.err = fail(code)
			params := map[string]any{"request_id": "signed-result-retry-001", "summary": "  Synthetic original  ", "limitations": "", "evidence_refs": []any{}}
			if _, err := host.CallTool(context.Background(), "bfb_submit_result", params); err != nil || transport.resultCalls != 1 || transport.expected != nil || capability.State() != StateProvisional {
				t.Fatal("result retry used legacy activation", err, transport.resultCalls, capability.State())
			}
			if transport.params["summary"] != params["summary"] || transport.params["limitations"] != "" {
				t.Fatal("input normalized before daemon")
			}
			if len(transport.fakeTransport.submitted) != 0 || transport.calls != 0 {
				t.Fatal("result used unsigned or four-tool path")
			}
			// A new Host models process restart: it keeps no canonical activation or
			// capture anchor, and the daemon alone decides the existing signed intent.
			restarted := NewHost(HostDeps{Capability: NewCapability(syntheticBoundary, host.capability.bindings, authority), Transport: transport})
			if _, err := restarted.CallTool(context.Background(), "bfb_submit_result", params); err != nil || transport.resultCalls != 2 || transport.expected != nil {
				t.Fatal("restarted result retry deadlocked", err)
			}
		})
	}
}

func TestActivatedResultRetainsAssertionAndNeverCachesOutcome(t *testing.T) {
	host, capability, bindings, authority, transport := resultFixtureHost()
	if err := capability.allowWrite(context.Background()); err != nil {
		t.Fatal(err)
	}
	authority.err = fail("offline_rejected")
	params := map[string]any{"request_id": "result-cache-001", "summary": "Synthetic result"}
	if _, err := host.CallTool(context.Background(), "bfb_submit_result", params); err != nil || transport.expected == nil {
		t.Fatal("activated assertion absent", err)
	}
	if host.seen["result-cache-001"].result != nil {
		t.Fatal("private result cached")
	}
	transport.result = generated.AgentResultReceipt{DeliveryState: "pending_sync", EffectCertainty: "possibly_applied"}
	if _, err := host.CallTool(context.Background(), "bfb_submit_result", params); err != nil || transport.resultCalls != 2 {
		t.Fatal("retry did not recontact daemon", err)
	}
	bindings.binding.ObservedSessionID = "changed-session"
	if _, err := host.CallTool(context.Background(), "bfb_submit_result", params); CodeOf(err) != "session_conflict" || transport.resultCalls != 2 {
		t.Fatal("changed local binding passed", err)
	}
}

func TestResultTerminalDenialClosesHostWithoutLosingCertainty(t *testing.T) {
	for _, reason := range []string{"revoked", "assignment_ended", "capability_closed"} {
		t.Run(reason, func(t *testing.T) {
			host, capability, _, _, transport := resultFixtureHost()
			transport.result = generated.AgentResultReceipt{DeliveryState: "delivery_blocked", EffectCertainty: "confirmed", ReasonCode: &reason}
			params := map[string]any{"request_id": "result-denial-001", "summary": "Synthetic"}
			result, err := host.CallTool(context.Background(), "bfb_submit_result", params)
			if err != nil || result.(generated.AgentResultReceipt).EffectCertainty != "confirmed" || capability.State() != StateClosed {
				t.Fatal("applied fact lost", result, err)
			}
			if _, err := host.CallTool(context.Background(), "bfb_submit_result", params); CodeOf(err) != "capability_closed" || transport.resultCalls != 1 {
				t.Fatal("terminal denial reopened", err)
			}
		})
	}
}

func TestResultInputStillRequiresFreshAuthorityBeforeConflict(t *testing.T) {
	host, _, _, authority, transport := resultFixtureHost()
	params := map[string]any{"request_id": "result-conflict-001", "summary": "Synthetic"}
	if _, err := host.CallTool(context.Background(), "bfb_submit_result", params); err != nil {
		t.Fatal(err)
	}
	params["summary"] = "Changed"
	// Legacy launch authorization would reject Submitted and close the Host.
	// The result daemon checks current result authority before its conflict.
	authority.err = fail("capability_closed")
	transport.resultErr = fail("request_conflict")
	if _, err := host.CallTool(context.Background(), "bfb_submit_result", params); CodeOf(err) != "request_conflict" || transport.resultCalls != 2 {
		t.Fatal("conflict bypassed current authority", err)
	}
	params["summary"] = "Synthetic"
	transport.resultErr = nil
	if _, err := host.CallTool(context.Background(), "bfb_submit_result", params); err != nil || transport.resultCalls != 3 {
		t.Fatal("changed conflict closed later exact retry", err)
	}
	params["summary"] = "Changed again"
	transport.resultErr = fail("revoked")
	if _, err := host.CallTool(context.Background(), "bfb_submit_result", params); CodeOf(err) != "revoked" || transport.resultCalls != 4 {
		t.Fatal("current daemon denial lost before conflict", err)
	}
}
