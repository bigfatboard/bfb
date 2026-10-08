// ABOUTME: Verifies v3 admission does not serve cached writes or activate an offline session.
// ABOUTME: Exercises fixed write bytes and bounded receipts through the actual daemon socket.

package localmcp

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

type admissionFixtureTransport struct {
	*fakeTransport
	calls   int
	outcome any
	err     error
	params  map[string]any
}

func (transport *admissionFixtureTransport) admitAgentWork(_ context.Context, _ Boundary, _ ConfirmedSession, _ string, params map[string]any, _ string) (any, error) {
	transport.calls++
	transport.params = make(map[string]any, len(params))
	for key, value := range params {
		transport.params[key] = value
	}
	return transport.outcome, transport.err
}
func admissionFixtureHost() (*Host, *Capability, *fakeBindings, *fakeAuthority, *admissionFixtureTransport) {
	bindings, authority := &fakeBindings{}, &fakeAuthority{}
	capability := NewCapability(syntheticBoundary, bindings, authority)
	bindings.setBound(syntheticSession, capability.ref())
	transport := &admissionFixtureTransport{fakeTransport: syntheticTransport(), outcome: CommentResult{ID: "synthetic-comment"}}
	return NewHost(HostDeps{Capability: capability, Transport: transport}), capability, bindings, authority, transport
}
func TestDaemonWriteCannotActivateFromOfflineAuthority(t *testing.T) {
	for _, code := range []string{"offline_rejected", "work_unavailable"} {
		t.Run(code, func(t *testing.T) {
			host, capability, _, authority, transport := admissionFixtureHost()
			authority.err = fail(code)
			_, err := host.CallTool(context.Background(), "bfb_add_comment", map[string]any{"body": "Synthetic", "request_id": "offline-activate-001"})
			if CodeOf(err) != code || capability.State() != StateProvisional || transport.calls != 0 {
				t.Fatal("offline authority activated or admitted", err, capability.State(), transport.calls)
			}
		})
	}
}
func TestActivatedDaemonWriteRecontactsOnEveryRetry(t *testing.T) {
	host, capability, _, authority, transport := admissionFixtureHost()
	params := map[string]any{"body": "  Synthetic original  ", "request_id": "daemon-retry-001"}
	first, err := host.CallTool(context.Background(), "bfb_add_comment", params)
	if err != nil || capability.State() != StateActivated || transport.calls != 1 {
		t.Fatal(err, capability.State(), transport.calls)
	}
	if host.seen["daemon-retry-001"].result != nil {
		t.Fatal("private committed result cached by Host")
	}
	authority.err = fail("work_unavailable")
	transport.outcome = generated.AgentWorkReceipt{DeliveryState: "pending_sync", EffectCertainty: "possibly_applied"}
	pending, err := host.CallTool(context.Background(), "bfb_add_comment", params)
	if err != nil || transport.calls != 2 || pending == first {
		t.Fatal("cached result bypassed daemon or transient poll closed admission", err, transport.calls)
	}
	if host.seen["daemon-retry-001"].result != nil {
		t.Fatal("pending receipt memoized as a committed result")
	}
	transport.outcome = CommentResult{ID: "confirmed-original"}
	applied, err := host.CallTool(context.Background(), "bfb_add_comment", params)
	if err != nil || applied.(CommentResult).ID != "confirmed-original" || transport.calls != 3 {
		t.Fatal("pending retry did not recontact daemon", applied, err)
	}
	params["body"] = "Changed intent"
	authority.err = nil
	if _, err := host.CallTool(context.Background(), "bfb_add_comment", params); CodeOf(err) != "request_rejected" || transport.calls != 3 {
		t.Fatal("changed request bypassed retained input binding", err)
	}
}

func TestCachedDaemonWriteConflictRequiresLiveAuthority(t *testing.T) {
	for _, code := range []string{"revoked", "assignment_ended", "capability_closed", "offline_rejected", "work_unavailable"} {
		t.Run(code, func(t *testing.T) {
			host, capability, _, authority, transport := admissionFixtureHost()
			params := map[string]any{"body": "Synthetic", "request_id": "private-conflict-001"}
			if _, err := host.CallTool(context.Background(), "bfb_add_comment", params); err != nil {
				t.Fatal(err)
			}
			params["body"] = "Changed intent"
			authority.err = fail(code)
			if code == "capability_closed" {
				capability.Close()
			}
			if _, err := host.CallTool(context.Background(), "bfb_add_comment", params); CodeOf(err) != code || transport.calls != 1 {
				t.Fatal("cached conflict preceded current authority", err, transport.calls)
			}
		})
	}
}
func TestActivatedDaemonWriteRequiresCurrentTrustedBinding(t *testing.T) {
	for _, mutate := range []string{"missing", "session", "provider", "execution", "generation"} {
		t.Run(mutate, func(t *testing.T) {
			host, _, bindings, authority, transport := admissionFixtureHost()
			params := map[string]any{"body": "Synthetic", "request_id": "binding-recheck-001"}
			if _, err := host.CallTool(context.Background(), "bfb_add_comment", params); err != nil {
				t.Fatal(err)
			}
			authority.err = fail("offline_rejected")
			switch mutate {
			case "missing":
				bindings.bound = false
			case "session":
				bindings.binding.ObservedSessionID = "different-session"
			case "provider":
				bindings.binding.Provider = "codex"
			case "execution":
				bindings.binding.ExecutionID = "foreign-execution"
			case "generation":
				bindings.binding.AssignmentGeneration++
			}
			if _, err := host.CallTool(context.Background(), "bfb_add_comment", params); err == nil || transport.calls != 1 {
				t.Fatal("changed trusted binding reached offline admission", err, transport.calls)
			}
		})
	}
}
func TestDaemonWriteTerminalReceiptClosesWithoutRevealingCachedBody(t *testing.T) {
	for _, code := range []string{"revoked", "assignment_ended", "capability_closed"} {
		t.Run(code, func(t *testing.T) {
			host, capability, _, _, transport := admissionFixtureHost()
			params := map[string]any{"body": "Synthetic", "request_id": "terminal-receipt-001"}
			if _, err := host.CallTool(context.Background(), "bfb_add_comment", params); err != nil {
				t.Fatal(err)
			}
			transport.outcome = generated.AgentWorkReceipt{DeliveryState: "delivery_blocked", EffectCertainty: "possibly_applied", ReasonCode: &code}
			result, err := host.CallTool(context.Background(), "bfb_add_comment", params)
			if err != nil || result.(generated.AgentWorkReceipt).EffectCertainty != "possibly_applied" || capability.State() != StateClosed {
				t.Fatal("uncertain terminal receipt lost or did not close", result, err)
			}
			if _, err := host.CallTool(context.Background(), "bfb_add_comment", params); CodeOf(err) != "capability_closed" || transport.calls != 2 {
				t.Fatal("terminal receipt reopened capability", err)
			}
		})
	}
}
func TestDaemonWritesKeepPrivateReadsAndKnownDenialsLive(t *testing.T) {
	host, _, _, authority, transport := admissionFixtureHost()
	params := map[string]any{"body": "Synthetic", "request_id": "live-denial-001"}
	if _, err := host.CallTool(context.Background(), "bfb_add_comment", params); err != nil {
		t.Fatal(err)
	}
	read := map[string]any{"request_id": "private-read-001"}
	if _, err := host.CallTool(context.Background(), "bfb_get_task", read); err != nil {
		t.Fatal(err)
	}
	authority.err = fail("work_unavailable")
	if _, err := host.CallTool(context.Background(), "bfb_get_task", read); CodeOf(err) != "work_unavailable" {
		t.Fatal("cached private read survived unavailable authority", err)
	}
	authority.err = fail("revoked")
	if _, err := host.CallTool(context.Background(), "bfb_add_comment", params); CodeOf(err) != "revoked" || transport.calls != 1 {
		t.Fatal("known denial admitted a new or cached write", err)
	}
}
func TestDaemonTransportDoesNotEnableUnsignedLaterTools(t *testing.T) {
	host, _, _, _, transport := admissionFixtureHost()
	for _, tool := range []string{"bfb_request_human", "bfb_get_attention", "bfb_wait_for_attention", "bfb_submit_result"} {
		if _, err := host.CallTool(context.Background(), tool, map[string]any{"request_id": "later-tool-001"}); CodeOf(err) != "not_implemented" {
			t.Fatal("later tool used a production legacy path", tool, err)
		}
	}
	if transport.calls != 0 {
		t.Fatal("later tools reached admission")
	}
}

func TestConcurrentPendingReceiptsKeepBoundedInputIdentity(t *testing.T) {
	host, _, _, _, transport := admissionFixtureHost()
	transport.outcome = generated.AgentWorkReceipt{DeliveryState: "pending_sync", EffectCertainty: "not_attempted"}
	var callers sync.WaitGroup
	failures := make(chan error, 272)
	for worker := 0; worker < 16; worker++ {
		callers.Add(1)
		go func(worker int) {
			defer callers.Done()
			for index := 0; index < 17; index++ {
				_, err := host.CallTool(context.Background(), "bfb_add_comment", map[string]any{"body": "Synthetic", "request_id": fmt.Sprintf("pending-%02d-%02d", worker, index)})
				if err != nil {
					failures <- err
				}
			}
		}(worker)
	}
	callers.Wait()
	close(failures)
	rejected := 0
	for err := range failures {
		if CodeOf(err) != "request_rejected" {
			t.Fatal("unexpected admission failure", err)
		}
		rejected++
	}
	if rejected != 16 || transport.calls != maxCachedRequests || len(host.seen) != maxCachedRequests {
		t.Fatal("concurrent pending admission exceeded or lost its identity bound", rejected, transport.calls, len(host.seen))
	}
	var existing string
	for requestID, cached := range host.seen {
		if cached.result != nil {
			t.Fatal("pending body retained in outcome cache")
		}
		existing = requestID
	}
	if _, err := host.CallTool(context.Background(), "bfb_add_comment", map[string]any{"body": "Synthetic", "request_id": existing}); err != nil || transport.calls != maxCachedRequests+1 {
		t.Fatal("full input map suppressed pending retry", err)
	}
	if _, err := host.CallTool(context.Background(), "bfb_add_comment", map[string]any{"body": "Changed", "request_id": existing}); CodeOf(err) != "request_rejected" {
		t.Fatal("pending input identity was dropped", err)
	}
}
func captureFixture(t *testing.T, name string) map[string]any {
	t.Helper()
	root, err := protocol.RepositoryRoot()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "protocol/fixtures/v3/local-agent-work-rpc.json"))
	if err != nil {
		t.Fatal(err)
	}
	var matrix struct{ Fixtures []struct{ Name, JSON string } }
	if err := json.Unmarshal(data, &matrix); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range matrix.Fixtures {
		if fixture.Name == name {
			var value map[string]any
			if err := json.Unmarshal([]byte(fixture.JSON), &value); err != nil {
				t.Fatal(err)
			}
			return value
		}
	}
	t.Fatal("fixture missing", name)
	return nil
}
func TestAgentReceiptScopeAndClosedPrivacy(t *testing.T) {
	value := captureFixture(t, "receipt.pending_sync.not_attempted")
	reference := generated.AgentWorkRequest{SchemaVersion: 1, RunExecutionId: "01K6R7DT00AAAAAAAAAAAAAAAA", AssignmentGeneration: 1, RequestId: "fixture-request-01"}
	if _, err := checkedAgentWorkReceipt(value, "comment", "bfb_add_comment", reference); err != nil {
		t.Fatal("valid shared receipt rejected", err)
	}
	for _, field := range []string{"request_id", "tool", "operation_key", "body", "capture", "signature", "effect_certainty", "reason_code"} {
		clone := make(map[string]any, len(value)+1)
		for key, nested := range value {
			clone[key] = nested
		}
		switch field {
		case "request_id":
			clone[field] = "foreign-request-01"
		case "tool":
			clone[field] = "bfb_update_task"
		case "operation_key":
			clone[field] = "agent:" + strings.Repeat("0", 64)
		case "effect_certainty":
			clone[field] = "confirmed"
		case "reason_code":
			clone[field] = "arbitrary"
		default:
			clone[field] = "synthetic-private"
		}
		if _, err := checkedAgentWorkReceipt(clone, "comment", "bfb_add_comment", reference); err == nil {
			t.Fatal("invalid or private receipt delivered", field)
		}
	}
}
func TestRPCAdmissionPreservesOriginalWritePresenceAndWhitespace(t *testing.T) {
	directory, err := os.MkdirTemp("", "bfb-work-rpc-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	paths, err := daemon.StatePaths(directory)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	registry := daemon.NewRegistry()
	id, sessionID, resultID := "01K6R7DT00AAAAAAAAAAAAAAAA", "01K6R7DT00BBBBBBBBBBBBBBBB", "01K6R7DT00CCCCCCCCCCCCCCCC"
	boundary := Boundary{WorkspaceID: id, ProjectID: id, TaskID: id, RunID: id, ExecutionID: id, RunnerID: id, CheckoutID: id, Generation: 1}
	session := ConfirmedSession{ProviderSessionId: sessionID, Provider: "fake", ObservedSessionId: "synthetic-session"}
	observed := make(chan map[string]any, 8)
	for _, action := range agentWorkActions {
		action := action
		if err := registry.Register(action.method, func(_ context.Context, request daemon.Request) (map[string]any, error) {
			local := request.Envelope.Payload[action.inputField].(map[string]any)
			original := local["request"].(map[string]any)
			observed <- original
			origin := generated.AgentEffectOrigin{RunId: id, RunExecutionId: id, AssignmentGeneration: 1, ProviderSessionId: sessionID}
			var result any = generated.AgentCommentResult{Id: resultID, Origin: origin}
			if action.action == "update" {
				result = generated.AgentUpdateResult{Task: generated.AgentTaskResult{Id: id, ProjectId: id, State: "active", Priority: "P2", Title: "Synthetic", Punchline: "", ResourceVersion: 4}, Origin: origin}
			}
			if action.action == "proposal" {
				state := "proposed"
				if original["parent_task_id"] != nil {
					state = "ready"
				}
				result = generated.AgentProposalResult{Id: resultID, State: state, Origin: origin}
			}
			return map[string]any{action.resultField: result}, nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	server, err := daemon.Start(ctx, paths, registry)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Close)
	transport := RPCTransport{Paths: paths, Correlation: "synthetic-correlation"}
	for index, test := range []struct {
		tool   string
		params map[string]any
		field  string
	}{
		{"bfb_add_comment", map[string]any{"body": "  <>&\u2028\u2029 \\u2028  "}, "body"},
		{"bfb_update_task", map[string]any{"expected_version": float64(3), "title": "  Synthetic title  "}, "title"},
		{"bfb_report_progress", map[string]any{"summary": "  Synthetic progress  ", "percent": 12.5}, "summary"},
		{"bfb_propose_task", map[string]any{"title": "  Synthetic proposal  "}, "title"},
		{"bfb_propose_task", map[string]any{"title": "  Synthetic child  ", "priority": "P0", "parent_task_id": id}, "title"},
	} {
		if _, err := transport.admitAgentWork(ctx, boundary, session, test.tool, test.params, fmt.Sprintf("raw-write-%03d", index)); err != nil {
			t.Fatal(test.tool, err)
		}
		original := <-observed
		if original[test.field] != test.params[test.field] {
			t.Fatal("raw text changed", original)
		}
		if test.tool == "bfb_propose_task" && test.params["priority"] == nil {
			if _, present := original["priority"]; present {
				t.Fatal("omitted priority became default in captured request")
			}
		}
		if test.tool == "bfb_report_progress" {
			if _, present := original["confidence"]; present {
				t.Fatal("absent confidence was supplied")
			}
		}
	}
}
