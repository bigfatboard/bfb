// ABOUTME: Proves fixed agent version negotiation and reply correlation on actual Unix sockets.
// ABOUTME: Rejects old or replaced endpoints before private input and checks complete inclusive frame bounds.

package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"github.com/qdis/bfb/internal/protocol/generated"
	"net"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func agentInput() map[string]any {
	return map[string]any{"agent_request": generated.AgentLocalRequest{Correlation: "private-synthetic-correlation", Request: generated.AgentWorkRequest{SchemaVersion: 1, RunExecutionId: NewRequestID(), AssignmentGeneration: 1, RequestId: "agent-fixture-001"}}}
}
func TestAgentNegotiationKeepsV1AndEchoesV2Errors(t *testing.T) {
	ctx := context.Background()
	old, err := Start(ctx, testPaths(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := CallAgent(ctx, old.Paths, "mcp.v2.authority", agentInput())
	if AsFailure(err).Code != "protocol_unsupported" || response.SchemaVersion != 2 {
		t.Fatal("old daemon accepted private v2 request", response, err)
	}
	old.Close()
	registry := NewRegistry()
	handler := func(context.Context, Request) (map[string]any, error) {
		return map[string]any{"agent_authority": map[string]any{"revoked": false, "execution_ended": false, "result_terminal": false}}, nil
	}
	_ = registry.Register("mcp.authority", handler)
	_ = registry.Register("mcp.v2.authority", handler)
	_ = registry.Register("mcp.v2.get_task", func(context.Context, Request) (map[string]any, error) { return nil, &Failure{Code: "session_conflict"} })
	server, err := Start(ctx, testPaths(t), registry)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	for _, version := range []int64{1, 2} {
		var response generated.LocalRpcEnvelope
		if version == 1 {
			response, err = Call(ctx, server.Paths, "mcp.authority", agentInput())
		} else {
			response, err = CallAgent(ctx, server.Paths, "mcp.v2.authority", agentInput())
		}
		if err != nil || response.SchemaVersion != version {
			t.Fatal("mixed client failed", response, err)
		}
	}
	response, err = CallAgent(ctx, server.Paths, "mcp.v2.get_task", agentInput())
	if AsFailure(err).Code != "session_conflict" || response.SchemaVersion != 2 || response.Method != "mcp.v2.get_task" || response.RequestId == "" {
		t.Fatal("v2 error correlation lost", response, err)
	}
	if _, err = CallAgent(ctx, server.Paths, "mcp.v2.get_context", agentInput()); AsFailure(err).Code != "protocol_unsupported" {
		t.Fatal("uninstalled handler advertised", err)
	}
}

func TestAgentSocketReplacementCannotReceiveNegotiatedPrivateRequest(t *testing.T) {
	paths := testPaths(t)
	if err := paths.Prepare(); err != nil {
		t.Fatal(err)
	}
	first, err := net.ListenUnix("unix", &net.UnixAddr{Name: paths.Socket, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	first.SetUnlinkOnClose(false)
	if err = os.Chmod(paths.Socket, 0600); err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	var replacementBytes atomic.Int32
	ready := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		connection, err := first.AcceptUnix()
		if err != nil {
			return
		}
		defer connection.Close()
		status, err := readEnvelope(bufio.NewReaderSize(connection, MaxRPCBytes+1))
		if err != nil {
			return
		}
		// Replace the pathname after accepting status, then keep its original peer.
		_ = os.Remove(paths.Socket)
		second, err := net.ListenUnix("unix", &net.UnixAddr{Name: paths.Socket, Net: "unix"})
		if err != nil {
			return
		}
		defer second.Close()
		_ = os.Chmod(paths.Socket, 0600)
		close(ready)
		advertised, _ := EncodeEnvelope(Response(status.Method, status.RequestId, map[string]any{"methods": []string{"mcp.v2.authority"}}, nil))
		_, _ = connection.Write(advertised)
		_ = connection.Close()
		_ = second.SetDeadline(time.Now().Add(250 * time.Millisecond))
		replaced, err := second.AcceptUnix()
		if err == nil {
			defer replaced.Close()
			_ = replaced.SetDeadline(time.Now().Add(time.Second))
			data := make([]byte, MaxRPCBytes)
			n, _ := replaced.Read(data)
			replacementBytes.Add(int32(n))
		}
	}()
	_, err = CallAgent(context.Background(), paths, "mcp.v2.authority", agentInput())
	<-ready
	<-done
	if err == nil || replacementBytes.Load() != 0 {
		t.Fatal("replacement received private input", replacementBytes.Load(), err)
	}
}

func TestAgentVersionSelectionAndCompleteFrameBound(t *testing.T) {
	envelope := generated.LocalRpcEnvelope{SchemaVersion: 2, RequestId: NewRequestID(), Method: "mcp.v2.authority", Direction: "request", Payload: agentInput()}
	data, err := EncodeEnvelope(envelope)
	if err != nil {
		t.Fatal(err)
	}
	for _, version := range []string{"2.0", "2e0"} {
		raw := strings.Replace(string(data), `"schema_version":2`, `"schema_version":`+version, 1)
		decoded, err := readEnvelope(bufio.NewReaderSize(strings.NewReader(raw), MaxRPCBytes+1))
		if err != nil || decoded.SchemaVersion != 2 {
			t.Fatal("integral version rejected", version, err)
		}
	}
	entries := make([]string, 200)
	envelope = generated.LocalRpcEnvelope{SchemaVersion: 1, RequestId: NewRequestID(), Method: "daemon.status", Direction: "response", Payload: map[string]any{"log_entries": entries}}
	base, _ := json.Marshal(envelope)
	remaining := MaxRPCBytes - 1 - len(base)
	for i := range entries {
		n := min(512, remaining)
		entries[i] = strings.Repeat("x", n)
		remaining -= n
	}
	if remaining != 0 {
		t.Fatal("fixture cannot fill frame")
	}
	data, err = EncodeEnvelope(envelope)
	if err != nil || len(data) != MaxRPCBytes {
		t.Fatal("inclusive bound rejected", len(data), err)
	}
	if _, err = readEnvelope(bufio.NewReaderSize(strings.NewReader(string(data)), MaxRPCBytes+1)); err != nil {
		t.Fatal("encoder/reader bounds differ", err)
	}
	for i := range entries {
		if len(entries[i]) < 512 {
			entries[i] += "x"
			break
		}
	}
	if _, err = EncodeEnvelope(envelope); err == nil {
		t.Fatal("newline excluded from complete frame bound")
	}
}

func TestAgentRejectsUncorrelatedReplies(t *testing.T) {
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
				advertised, _ := EncodeEnvelope(Response(status.Method, status.RequestId, map[string]any{"methods": []string{"mcp.v2.authority"}}, nil))
				_, _ = connection.Write(advertised)
				request, err := readEnvelope(reader)
				if err != nil {
					return
				}
				reply := ResponseVersion(2, request.Method, request.RequestId, map[string]any{"agent_authority": map[string]any{"revoked": false, "execution_ended": false, "result_terminal": false}}, nil)
				switch changed {
				case "version":
					reply.SchemaVersion = 1
				case "method":
					reply.Method = "mcp.v2.bound_authority"
				case "request_id":
					reply.RequestId = NewRequestID()
				}
				data, _ := json.Marshal(reply)
				_, _ = connection.Write(append(data, '\n'))
			}()
			_, err = CallAgent(context.Background(), paths, "mcp.v2.authority", agentInput())
			<-done
			if AsFailure(err).Code != "invalid_request" {
				t.Fatal("uncorrelated reply accepted", changed, err)
			}
		})
	}
	legacy := generated.LocalRpcEnvelope{SchemaVersion: 1, RequestId: NewRequestID(), Method: "mcp.v2.authority", Direction: "request", Payload: agentInput()}
	data, _ := json.Marshal(legacy)
	if _, err := readEnvelope(bufio.NewReaderSize(strings.NewReader(string(data)+"\n"), MaxRPCBytes+1)); err == nil {
		t.Fatal("version-qualified method accepted under legacy document")
	}
}
