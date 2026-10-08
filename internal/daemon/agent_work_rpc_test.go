// ABOUTME: Exercises negotiated work receipts and strict version pairing through actual Unix sockets.
// ABOUTME: Proves unsupported or uncorrelated endpoints cannot receive or return private work input.

package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/qdis/bfb/internal/protocol/generated"
)

func agentWorkInput() map[string]any {
	return map[string]any{"agent_comment_request": generated.AgentCommentLocalRequest{
		Correlation: "private-synthetic-correlation",
		Request: generated.AgentCommentRequest{
			Reference: generated.AgentWorkRequest{SchemaVersion: 1, RunExecutionId: NewRequestID(), AssignmentGeneration: 1, RequestId: "agent-write-001"},
			Binding:   generated.AgentSessionReference{ProviderSessionId: NewRequestID(), Provider: "codex", ObservedSessionId: "synthetic-observed-session"},
			Body:      "synthetic private body",
		},
	}}
}

func pendingWorkReceipt() map[string]any {
	return map[string]any{"agent_work_receipt": map[string]any{
		"schema_version": 1, "operation_key": "agent:" + strings.Repeat("a", 64),
		"request_id": "agent-write-001", "tool": "bfb_add_comment", "admission_mode": "offline_admitted",
		"delivery_state": "pending_sync", "effect_certainty": "not_attempted",
		"captured_at": "2026-10-06T00:00:00.000Z", "intent_expires_at": "2026-10-06T00:01:00.000Z", "reason_code": nil,
	}}
}

func TestAgentWorkNegotiationDoesNotDowngrade(t *testing.T) {
	ctx := context.Background()
	var oldCalls atomic.Int32
	oldRegistry := NewRegistry()
	if err := oldRegistry.Register("mcp.v2.add_comment", func(context.Context, Request) (map[string]any, error) {
		oldCalls.Add(1)
		return nil, &Failure{Code: "request_rejected"}
	}); err != nil {
		t.Fatal(err)
	}
	old, err := Start(ctx, testPaths(t), oldRegistry)
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()
	reply, err := CallAgentWork(ctx, old.Paths, "mcp.v3.add_comment", agentWorkInput())
	if AsFailure(err).Code != "protocol_unsupported" || reply.SchemaVersion != 3 || oldCalls.Load() != 0 {
		t.Fatal("unsupported daemon received downgraded private work", reply, err, oldCalls.Load())
	}
	for _, method := range []string{"mcp.v3.get_task", "mcp.v3.capture", "mcp.v3.replay", "mcp.v2.add_comment"} {
		if _, err := CallAgentWork(ctx, old.Paths, method, agentWorkInput()); AsFailure(err).Code != "protocol_unsupported" {
			t.Fatal("non-write method entered work lane", method, err)
		}
	}

	registry := NewRegistry()
	if err := registry.Register("mcp.v3.add_comment", func(context.Context, Request) (map[string]any, error) {
		return pendingWorkReceipt(), nil
	}); err != nil {
		t.Fatal(err)
	}
	server, err := Start(ctx, testPaths(t), registry)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	reply, err = CallAgentWork(ctx, server.Paths, "mcp.v3.add_comment", agentWorkInput())
	if err != nil || reply.SchemaVersion != 3 || reply.Payload["agent_work_receipt"] == nil || len(reply.Payload) != 1 {
		t.Fatal("negotiated pending receipt failed", reply, err)
	}
}

func TestAgentWorkEnvelopeKeepsVersionedShapesSeparate(t *testing.T) {
	for _, version := range []int64{1, 2} {
		request := generated.LocalRpcEnvelope{SchemaVersion: version, RequestId: NewRequestID(), Method: "mcp.v3.add_comment", Direction: "request", Payload: agentWorkInput()}
		data, _ := json.Marshal(request)
		if _, err := readEnvelope(bufio.NewReaderSize(strings.NewReader(string(data)+"\n"), MaxRPCBytes+1)); err == nil {
			t.Fatal("work method accepted under older schema", version)
		}
	}
	for _, version := range []int64{1, 2} {
		reply := ResponseVersion(version, "mcp.v2.add_comment", NewRequestID(), pendingWorkReceipt(), nil)
		if _, err := EncodeEnvelope(reply); err == nil {
			t.Fatal("pending receipt widened a historical response", version)
		}
	}
	request := generated.LocalRpcEnvelope{SchemaVersion: 3, RequestId: NewRequestID(), Method: "mcp.v3.add_comment", Direction: "request", Payload: agentWorkInput()}
	data, err := EncodeEnvelope(request)
	if err != nil {
		t.Fatal(err)
	}
	for _, version := range []string{"3.0", "3e0"} {
		raw := strings.Replace(string(data), `"schema_version":3`, `"schema_version":`+version, 1)
		decoded, err := readEnvelope(bufio.NewReaderSize(strings.NewReader(raw), MaxRPCBytes+1))
		if err != nil || decoded.SchemaVersion != 3 {
			t.Fatal("exact integral envelope version rejected", version, err)
		}
	}
}

func TestAgentWorkRejectsUncorrelatedReplies(t *testing.T) {
	for _, changed := range []string{"version", "method", "request_id"} {
		t.Run(changed, func(t *testing.T) {
			paths := testPaths(t)
			if err := paths.Prepare(); err != nil {
				t.Fatal(err)
			}
			listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: paths.Socket, Net: "unix"})
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			if err := os.Chmod(paths.Socket, 0600); err != nil {
				t.Fatal(err)
			}
			done := make(chan struct{})
			go func() {
				defer close(done)
				connection, err := listener.AcceptUnix()
				if err != nil {
					return
				}
				defer connection.Close()
				reader := bufio.NewReaderSize(connection, MaxRPCBytes+1)
				status, err := readEnvelope(reader)
				if err != nil {
					return
				}
				advertised, _ := EncodeEnvelope(Response(status.Method, status.RequestId, map[string]any{"methods": []string{"mcp.v3.add_comment"}}, nil))
				_, _ = connection.Write(advertised)
				request, err := readEnvelope(reader)
				if err != nil {
					return
				}
				reply := ResponseVersion(3, request.Method, request.RequestId, pendingWorkReceipt(), nil)
				switch changed {
				case "version":
					reply.SchemaVersion = 2
				case "method":
					reply.Method = "mcp.v3.report_progress"
				case "request_id":
					reply.RequestId = NewRequestID()
				}
				data, _ := json.Marshal(reply)
				_, _ = connection.Write(append(data, '\n'))
			}()
			_, err = CallAgentWork(context.Background(), paths, "mcp.v3.add_comment", agentWorkInput())
			<-done
			if AsFailure(err).Code != "invalid_request" {
				t.Fatal("uncorrelated work reply accepted", changed, err)
			}
		})
	}
}
