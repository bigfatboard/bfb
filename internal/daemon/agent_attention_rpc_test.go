// ABOUTME: Exercises the negotiated online attention lane through actual private Unix sockets.
// ABOUTME: Separates cancellation from malformed replies while preserving typed authority denials.

package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/protocol/generated"
)

func agentAttentionInput() map[string]any {
	return map[string]any{"agent_attention_read_request": generated.AgentAttentionReadLocalRequest{
		Correlation: "synthetic-private-attention-correlation",
		Request:     generated.AgentAttentionReadRequest{Reference: generated.AgentWorkRequest{SchemaVersion: 1, RunExecutionId: NewRequestID(), AssignmentGeneration: 7, RequestId: "attention-read-001"}, AttentionId: NewRequestID()},
	}}
}

func TestAgentAttentionDoesNotDowngradeOrWidenOtherLanes(t *testing.T) {
	registry := NewRegistry()
	var calls atomic.Int32
	if err := registry.Register("mcp.v2.get_task", func(context.Context, Request) (map[string]any, error) {
		calls.Add(1)
		return nil, &Failure{Code: "revoked"}
	}); err != nil {
		t.Fatal(err)
	}
	server, err := Start(context.Background(), testPaths(t), registry)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	reply, err := CallAgentAttention(context.Background(), server.Paths, "mcp.v4.get_attention", agentAttentionInput())
	if AsFailure(err).Code != "protocol_unsupported" || reply.SchemaVersion != 4 || calls.Load() != 0 {
		t.Fatal("private attention downgraded", reply, err)
	}
	for _, method := range []string{"mcp.v4.wait_for_attention", "mcp.v4.replay", "mcp.v4.sign", "mcp.v3.add_comment", "mcp.v2.get_task"} {
		if _, err := CallAgentAttention(context.Background(), server.Paths, method, agentAttentionInput()); AsFailure(err).Code != "protocol_unsupported" {
			t.Fatal("unapproved method admitted", method, err)
		}
	}
	for _, version := range []int64{1, 2, 3} {
		data, _ := json.Marshal(generated.LocalRpcEnvelope{SchemaVersion: version, RequestId: NewRequestID(), Method: "mcp.v4.get_attention", Direction: "request", Payload: agentAttentionInput()})
		if _, err := readEnvelope(bufio.NewReaderSize(strings.NewReader(string(data)+"\n"), MaxRPCBytes+1)); err == nil {
			t.Fatal("historical envelope accepted attention", version)
		}
	}
}

func attentionSocket(t *testing.T, handler func(*net.UnixConn, *bufio.Reader, generated.LocalRpcEnvelope)) (Paths, <-chan struct{}) {
	t.Helper()
	paths := testPaths(t)
	if err := paths.Prepare(); err != nil {
		t.Fatal(err)
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: paths.Socket, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(paths.Socket, 0600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	done := make(chan struct{})
	go func() {
		defer close(done)
		connection, err := listener.AcceptUnix()
		if err != nil {
			return
		}
		defer connection.Close()
		_ = connection.SetDeadline(time.Now().Add(2 * time.Second))
		reader := bufio.NewReaderSize(connection, MaxRPCBytes+1)
		status, err := readEnvelope(reader)
		if err != nil {
			return
		}
		handler(connection, reader, status)
	}()
	return paths, done
}

func TestAgentAttentionSocketDeadlineIsCancellationNotInvalidRequest(t *testing.T) {
	for _, phase := range []string{"negotiation", "private-response"} {
		t.Run(phase, func(t *testing.T) {
			paths, done := attentionSocket(t, func(connection *net.UnixConn, reader *bufio.Reader, status generated.LocalRpcEnvelope) {
				if phase == "private-response" {
					data, _ := EncodeEnvelope(Response(status.Method, status.RequestId, map[string]any{"methods": []string{"mcp.v4.get_attention"}}, nil))
					_, _ = connection.Write(data)
					if _, err := readEnvelope(reader); err != nil {
						return
					}
				}
				// Wait for the client to cancel the socket; never send a business reply.
				_, _ = reader.ReadByte()
			})
			ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
			defer cancel()
			start := time.Now()
			_, err := CallAgentAttention(ctx, paths, "mcp.v4.get_attention", agentAttentionInput())
			<-done
			if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > time.Second {
				t.Fatal("deadline became malformed/unsupported reply or exceeded budget", err, time.Since(start))
			}
		})
	}
}

func TestAgentAttentionActualReplyFailuresRemainDistinct(t *testing.T) {
	for _, changed := range []string{"denial", "version", "method", "request_id", "malformed"} {
		t.Run(changed, func(t *testing.T) {
			paths, done := attentionSocket(t, func(connection *net.UnixConn, reader *bufio.Reader, status generated.LocalRpcEnvelope) {
				data, _ := EncodeEnvelope(Response(status.Method, status.RequestId, map[string]any{"methods": []string{"mcp.v4.get_attention"}}, nil))
				_, _ = connection.Write(data)
				request, err := readEnvelope(reader)
				if err != nil {
					return
				}
				reply := ResponseVersion(4, request.Method, request.RequestId, nil, &Failure{Code: "revoked"})
				switch changed {
				case "version":
					reply.SchemaVersion = 3
				case "method":
					reply.Method = "mcp.v4.request_human"
				case "request_id":
					reply.RequestId = NewRequestID()
				}
				data, _ = json.Marshal(reply)
				if changed == "malformed" {
					data = []byte("{")
				}
				_, _ = connection.Write(append(data, '\n'))
			})
			_, err := CallAgentAttention(context.Background(), paths, "mcp.v4.get_attention", agentAttentionInput())
			<-done
			want := "invalid_request"
			if changed == "denial" {
				want = "revoked"
			}
			if AsFailure(err).Code != want {
				t.Fatal("reply classification lost", changed, err)
			}
		})
	}
}

func TestAgentAttentionIndependentSocketTimeoutRemainsUnavailable(t *testing.T) {
	paths, done := attentionSocket(t, func(connection *net.UnixConn, reader *bufio.Reader, status generated.LocalRpcEnvelope) {
		_ = connection.SetDeadline(time.Now().Add(15 * time.Second))
		data, _ := EncodeEnvelope(Response(status.Method, status.RequestId, map[string]any{"methods": []string{"mcp.v4.get_attention"}}, nil))
		_, _ = connection.Write(data)
		if _, err := readEnvelope(reader); err != nil {
			return
		}
		_, _ = reader.ReadByte()
	})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	start := time.Now()
	_, err := CallAgentAttention(ctx, paths, "mcp.v4.get_attention", agentAttentionInput())
	<-done
	if AsFailure(err).Code != "daemon_offline" || ctx.Err() != nil || time.Since(start) > 12*time.Second {
		t.Fatal("independent socket timeout was hidden or misclassified", err, ctx.Err(), time.Since(start))
	}
}
