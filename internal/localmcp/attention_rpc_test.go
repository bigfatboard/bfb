// ABOUTME: Tests the production attention transport and Host over real checked Unix sockets.
// ABOUTME: Rejects provenance and session substitutions and bounds stalled replies without journaling.

package localmcp

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
)

func attentionWireFixture() (Boundary, ConfirmedSession, generated.AgentAttentionResult) {
	id, sessionID, attentionID := "01K6R7DT00AAAAAAAAAAAAAAAA", "01K6R7DT00BBBBBBBBBBBBBBBB", "01K6R7DT00CCCCCCCCCCCCCCCC"
	boundary := Boundary{WorkspaceID: id, ProjectID: id, TaskID: id, RunID: id, ExecutionID: id, RunnerID: id, CheckoutID: id, Generation: 7}
	binding := ConfirmedSession{ProviderSessionId: sessionID, Provider: "fake", ObservedSessionId: "synthetic-observed-session"}
	result := generated.AgentAttentionResult{
		Attention:        generated.AgentAttentionRecord{Id: attentionID, Kind: "clarification", RequiredRole: "reviewer", Question: "Synthetic question", Blocking: true, State: "open", ResourceVersion: 1, RequestedAt: "2026-10-06T00:00:00.000Z"},
		Origin:           generated.AgentAttentionOrigin{RunId: id, RunExecutionId: id, AssignmentGeneration: 7},
		AuthorityBinding: &binding,
	}
	return boundary, binding, result
}

func attentionTestPaths(t *testing.T) daemon.Paths {
	t.Helper()
	directory, err := os.MkdirTemp("/tmp", "bfb-attention-rpc-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	paths, err := daemon.StatePaths(directory)
	if err != nil {
		t.Fatal(err)
	}
	if err := paths.Prepare(); err != nil {
		t.Fatal(err)
	}
	return paths
}

func attentionTestTransport(t *testing.T, handler daemon.Handler) RPCTransport {
	t.Helper()
	paths, registry := attentionTestPaths(t), daemon.NewRegistry()
	for _, method := range []string{"mcp.v4.request_human", "mcp.v4.get_attention"} {
		if err := registry.Register(method, handler); err != nil {
			t.Fatal(err)
		}
	}
	server, err := daemon.Start(context.Background(), paths, registry)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Close)
	return RPCTransport{Paths: paths, Correlation: "synthetic-private-correlation"}
}

func TestRPCAttentionCarriesExactOriginalIdentityAndOptionalCurrentBinding(t *testing.T) {
	boundary, binding, result := attentionWireFixture()
	observed := make(chan map[string]any, 4)
	transport := attentionTestTransport(t, func(_ context.Context, call daemon.Request) (map[string]any, error) {
		field := "agent_attention_read_request"
		if call.Envelope.Method == "mcp.v4.request_human" {
			field = "agent_attention_request"
		}
		local := call.Envelope.Payload[field].(map[string]any)
		observed <- local
		return map[string]any{"agent_attention": result}, nil
	})
	request := AttentionRequest{Kind: "clarification", Question: "Synthetic question", Blocking: true, ReferenceKind: "artifact_version", ReferenceID: "synthetic-version"}
	created, err := transport.RequestAttention(context.Background(), boundary, binding, request, "original-attention-001")
	if err != nil || created.Answer != "" || created.AnsweredAt != "" || created.FirstResponseAt != "" || created.ResolvedAt != "" {
		t.Fatal("required wire nulls changed MCP projection", created, err)
	}
	local := <-observed
	original := local["request"].(map[string]any)
	if local["correlation"] != transport.Correlation || original["question"] != request.Question || original["reference_kind"] != request.ReferenceKind || original["reference_id"] != request.ReferenceID || original["binding"] == nil {
		t.Fatal("original fields changed", local)
	}
	reference := original["reference"].(map[string]any)
	if reference["schema_version"] != float64(1) || reference["run_execution_id"] != boundary.ExecutionID || reference["assignment_generation"] != float64(7) || reference["request_id"] != "original-attention-001" {
		t.Fatal("business identity changed", reference)
	}
	for _, current := range []*ConfirmedSession{nil, &binding} {
		if _, err := transport.GetAttention(context.Background(), boundary, current, result.Attention.Id, "original-read-001"); err != nil {
			t.Fatal(err)
		}
		original = (<-observed)["request"].(map[string]any)
		_, present := original["binding"]
		if present != (current != nil) || original["attention_id"] != result.Attention.Id || original["reference"].(map[string]any)["request_id"] != "original-read-001" {
			t.Fatal("optional canonical binding or read identity changed", original)
		}
	}
	if _, err := os.Stat(filepath.Join(transport.Paths.Root, "local-mcp-journal.sqlite")); !os.IsNotExist(err) {
		t.Fatal("attention opened the agent work journal", err)
	}
}

func TestRPCAttentionCreationRejectsEveryAuthorityOrOriginalFieldSubstitution(t *testing.T) {
	for _, changed := range []string{"run", "execution", "generation", "missing-binding", "session", "provider", "observed", "kind", "question", "blocking"} {
		t.Run(changed, func(t *testing.T) {
			boundary, binding, result := attentionWireFixture()
			other := "01K6R7DT00DDDDDDDDDDDDDDDD"
			want := "session_conflict"
			switch changed {
			case "run":
				result.Origin.RunId = other
				want = "boundary_escape"
			case "execution":
				result.Origin.RunExecutionId = other
				want = "boundary_escape"
			case "generation":
				result.Origin.AssignmentGeneration++
				want = "boundary_escape"
			case "missing-binding":
				result.AuthorityBinding = nil
			case "session":
				result.AuthorityBinding.ProviderSessionId = other
			case "provider":
				result.AuthorityBinding.Provider = "codex"
			case "observed":
				result.AuthorityBinding.ObservedSessionId = "other-observed-session"
			case "kind":
				result.Attention.Kind = "review"
				want = "request_rejected"
			case "question":
				result.Attention.Question = "Altered synthetic question"
				want = "request_rejected"
			case "blocking":
				result.Attention.Blocking = false
				want = "request_rejected"
			}
			transport := attentionTestTransport(t, func(context.Context, daemon.Request) (map[string]any, error) {
				return map[string]any{"agent_attention": result}, nil
			})
			_, err := transport.RequestAttention(context.Background(), boundary, binding, AttentionRequest{Kind: "clarification", Question: "Synthetic question", Blocking: true}, "substitute-attention-001")
			if CodeOf(err) != want {
				t.Fatal("substituted result released", changed, err, want)
			}
		})
	}
}

func TestRPCAttentionReadSeparatesHistoricalOriginAndCurrentBinding(t *testing.T) {
	for _, changed := range []string{"historical", "provisional", "foreign-run", "wrong-id", "missing-binding", "session", "provider", "observed"} {
		t.Run(changed, func(t *testing.T) {
			boundary, binding, result := attentionWireFixture()
			id, want := result.Attention.Id, ""
			current := &binding
			other := "01K6R7DT00DDDDDDDDDDDDDDDD"
			switch changed {
			case "historical":
				result.Origin.RunExecutionId = other
				result.Origin.AssignmentGeneration = 1
			case "provisional":
				current = nil
				result.AuthorityBinding = nil
			case "foreign-run":
				result.Origin.RunId = other
				want = "boundary_escape"
			case "wrong-id":
				result.Attention.Id = other
				want = "boundary_escape"
			case "missing-binding":
				result.AuthorityBinding = nil
				want = "session_conflict"
			case "session":
				result.AuthorityBinding.ProviderSessionId = other
				want = "session_conflict"
			case "provider":
				result.AuthorityBinding.Provider = "codex"
				want = "session_conflict"
			case "observed":
				result.AuthorityBinding.ObservedSessionId = "other-observed-session"
				want = "session_conflict"
			}
			transport := attentionTestTransport(t, func(context.Context, daemon.Request) (map[string]any, error) {
				return map[string]any{"agent_attention": result}, nil
			})
			_, err := transport.GetAttention(context.Background(), boundary, current, id, "historical-attention-001")
			if (want == "" && err != nil) || (want != "" && CodeOf(err) != want) {
				t.Fatal("original/current authority conflated", changed, err, want)
			}
		})
	}
}

func TestRPCAttentionWaitStalledActualSocketReturnsPending(t *testing.T) {
	paths := attentionTestPaths(t)
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: paths.Socket, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	if err := os.Chmod(paths.Socket, 0600); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	received := make(chan generated.LocalRpcEnvelope, 1)
	go func() {
		defer close(done)
		connection, err := listener.AcceptUnix()
		if err != nil {
			return
		}
		defer connection.Close()
		_ = connection.SetDeadline(time.Now().Add(2 * time.Second))
		reader := bufio.NewReader(connection)
		statusData, err := reader.ReadBytes('\n')
		if err != nil {
			return
		}
		var status generated.LocalRpcEnvelope
		if json.Unmarshal(statusData, &status) != nil {
			return
		}
		data, _ := daemon.EncodeEnvelope(daemon.Response(status.Method, status.RequestId, map[string]any{"methods": []string{"mcp.v4.get_attention"}}, nil))
		_, _ = connection.Write(data)
		requestData, err := reader.ReadBytes('\n')
		if err != nil {
			return
		}
		var request generated.LocalRpcEnvelope
		if json.Unmarshal(requestData, &request) != nil {
			return
		}
		received <- request
		_, _ = reader.ReadByte() // Client must interrupt this unanswered socket.
	}()
	boundary, _, result := attentionWireFixture()
	transport := RPCTransport{Paths: paths, Correlation: "synthetic-private-correlation"}
	host := NewHost(HostDeps{Capability: NewCapability(boundary, &fakeBindings{}, &fakeAuthority{}), Transport: transport})
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	outcome, err := host.CallTool(ctx, "bfb_wait_for_attention", map[string]any{"attention_id": result.Attention.Id, "request_id": "socket-wait-001"})
	<-done
	if err != nil || outcome.(map[string]any)["status"] != "pending" || len(outcome.(map[string]any)) != 1 || time.Since(start) > time.Second {
		t.Fatal("stalled v4 reply became malformed request or escaped deadline", outcome, err, time.Since(start))
	}
	select {
	case request := <-received:
		if request.SchemaVersion != 4 || request.Method != "mcp.v4.get_attention" {
			t.Fatal("wrong real lane", request)
		}
	default:
		t.Fatal("wait did not reach actual private socket")
	}
	if host.capability.State() != StateProvisional || host.seen["socket-wait-001"].result != nil {
		t.Fatal("timeout activated a session or cached a private outcome")
	}
	if _, err := os.Stat(filepath.Join(paths.Root, "local-mcp-journal.sqlite")); !os.IsNotExist(err) {
		t.Fatal("stalled attention created journal", err)
	}
}

func TestRPCAttentionWaitActualAuthorityDenialRemainsVisible(t *testing.T) {
	boundary, _, result := attentionWireFixture()
	transport := attentionTestTransport(t, func(context.Context, daemon.Request) (map[string]any, error) {
		return nil, &daemon.Failure{Code: "revoked"}
	})
	host := NewHost(HostDeps{Capability: NewCapability(boundary, &fakeBindings{}, &fakeAuthority{}), Transport: transport})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if outcome, err := host.CallTool(ctx, "bfb_wait_for_attention", map[string]any{"attention_id": result.Attention.Id, "request_id": "denied-wait-001"}); CodeOf(err) != "revoked" || outcome != nil || host.capability.State() != StateClosed {
		t.Fatal("actual denial became pending", outcome, err)
	}
}
