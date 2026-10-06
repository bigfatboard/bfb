// ABOUTME: Exercises the result-only v5 lane over checked private Unix sockets.
// ABOUTME: Proves negotiation, method isolation, cancellation and typed denial boundaries.

package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/protocol/generated"
)

func agentResultInput() map[string]any {
	return map[string]any{"agent_result_request": map[string]any{"correlation": "synthetic-result-correlation", "request": map[string]any{
		"reference": generated.AgentWorkRequest{SchemaVersion: 1, RunExecutionId: NewRequestID(), AssignmentGeneration: 1, RequestId: "result-submit-001"}, "summary": "Synthetic result",
	}}}
}

func TestAgentResultDoesNotDowngradeOrWidenFrozenLanes(t *testing.T) {
	server, err := Start(context.Background(), testPaths(t), NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	reply, err := CallAgentResult(context.Background(), server.Paths, "mcp.v5.submit_result", agentResultInput())
	if AsFailure(err).Code != "protocol_unsupported" || reply.SchemaVersion != 5 {
		t.Fatal("result downgraded", reply, err)
	}
	for _, method := range []string{"mcp.v5.replay", "mcp.v5.sign", "mcp.v5.add_comment", "mcp.v4.get_attention", "mcp.v3.submit_result", "mcp.v2.submit_result"} {
		if _, err := CallAgentResult(context.Background(), server.Paths, method, agentResultInput()); AsFailure(err).Code != "protocol_unsupported" {
			t.Fatal("unapproved method", method, err)
		}
	}
	for _, version := range []int64{1, 2, 3, 4} {
		data, _ := json.Marshal(generated.LocalRpcEnvelope{SchemaVersion: version, RequestId: NewRequestID(), Method: "mcp.v5.submit_result", Direction: "request", Payload: agentResultInput()})
		if _, err := readEnvelope(bufio.NewReaderSize(strings.NewReader(string(data)+"\n"), MaxRPCBytes+1)); err == nil {
			t.Fatal("historical envelope accepted result", version)
		}
	}
}

func TestAgentResultSocketDeadlinePreservesCancellation(t *testing.T) {
	for _, phase := range []string{"negotiation", "private-response"} {
		t.Run(phase, func(t *testing.T) {
			paths, done := attentionSocket(t, func(connection *net.UnixConn, reader *bufio.Reader, status generated.LocalRpcEnvelope) {
				if phase == "private-response" {
					data, _ := EncodeEnvelope(Response(status.Method, status.RequestId, map[string]any{"methods": []string{"mcp.v5.submit_result"}}, nil))
					_, _ = connection.Write(data)
					if _, err := readEnvelope(reader); err != nil {
						return
					}
				}
				_, _ = reader.ReadByte()
			})
			ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
			defer cancel()
			_, err := CallAgentResult(ctx, paths, "mcp.v5.submit_result", agentResultInput())
			<-done
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatal("cancellation misclassified", err)
			}
		})
	}
}

func TestAgentResultReplyFailuresRemainDistinct(t *testing.T) {
	for _, changed := range []string{"denial", "version", "method", "request_id", "malformed", "disconnect"} {
		t.Run(changed, func(t *testing.T) {
			paths, done := attentionSocket(t, func(connection *net.UnixConn, reader *bufio.Reader, status generated.LocalRpcEnvelope) {
				data, _ := EncodeEnvelope(Response(status.Method, status.RequestId, map[string]any{"methods": []string{"mcp.v5.submit_result"}}, nil))
				_, _ = connection.Write(data)
				request, err := readEnvelope(reader)
				if err != nil {
					return
				}
				if changed == "disconnect" {
					return
				}
				reply := ResponseVersion(5, request.Method, request.RequestId, nil, &Failure{Code: "policy_rejected"})
				switch changed {
				case "version":
					reply.SchemaVersion = 4
				case "method":
					reply.Method = "mcp.v5.replay"
				case "request_id":
					reply.RequestId = NewRequestID()
				}
				data, _ = json.Marshal(reply)
				if changed == "malformed" {
					data = []byte("{")
				}
				_, _ = connection.Write(append(data, '\n'))
			})
			_, err := CallAgentResult(context.Background(), paths, "mcp.v5.submit_result", agentResultInput())
			<-done
			want := "invalid_request"
			if changed == "denial" {
				want = "policy_rejected"
			}
			if changed == "disconnect" {
				want = "daemon_offline"
			}
			if AsFailure(err).Code != want {
				t.Fatal("reply classification lost", changed, err)
			}
		})
	}
}
