// ABOUTME: Tests online artifact v6 negotiation and correlation on real private Unix sockets.
// ABOUTME: Refuses old lanes before sending private paths and preserves cancellation or authority denial.

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

func artifactRPCInput() map[string]any {
	return map[string]any{"agent_artifact_request": map[string]any{"correlation": "synthetic-artifact-correlation", "request": map[string]any{
		"reference": generated.AgentWorkRequest{SchemaVersion: 1, RunExecutionId: NewRequestID(), AssignmentGeneration: 1, RequestId: "artifact-publish-001"}, "path": "review.md", "format": "markdown", "role": "review",
	}}}
}

func TestArtifactRPCRefusesUnadvertisedMethodsAndFrozenLanes(t *testing.T) {
	server, err := Start(context.Background(), testPaths(t), NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	reply, err := CallAgentArtifact(context.Background(), server.Paths, "mcp.v6.publish_artifact", artifactRPCInput())
	if AsFailure(err).Code != "protocol_unsupported" || reply.SchemaVersion != 6 {
		t.Fatal("artifact downgraded", err)
	}
	for _, method := range []string{"mcp.v6.upload", "mcp.v6.replay", "mcp.v5.publish_artifact", "artifact.publish", "mcp.v6.submit_result"} {
		if _, err := CallAgentArtifact(context.Background(), server.Paths, method, artifactRPCInput()); AsFailure(err).Code != "protocol_unsupported" {
			t.Fatal("unsupported artifact method accepted", method)
		}
	}
	for _, version := range []int64{1, 2, 3, 4, 5} {
		data, _ := json.Marshal(generated.LocalRpcEnvelope{SchemaVersion: version, RequestId: NewRequestID(), Method: "mcp.v6.publish_artifact", Direction: "request", Payload: artifactRPCInput()})
		if _, err := readEnvelope(bufio.NewReaderSize(strings.NewReader(string(data)+"\n"), MaxRPCBytes+1)); err == nil {
			t.Fatal("old envelope widened to artifact", version)
		}
	}
}

func TestArtifactRPCCheckedSocketDenialAndCancellation(t *testing.T) {
	for _, fault := range []string{"denial", "wrong_version", "wrong_id", "disconnect", "timeout"} {
		t.Run(fault, func(t *testing.T) {
			paths, done := attentionSocket(t, func(connection *net.UnixConn, reader *bufio.Reader, status generated.LocalRpcEnvelope) {
				data, _ := EncodeEnvelope(Response(status.Method, status.RequestId, map[string]any{"methods": []string{"mcp.v6.publish_artifact"}}, nil))
				_, _ = connection.Write(data)
				request, err := readEnvelope(reader)
				if err != nil || fault == "disconnect" {
					return
				}
				if fault == "timeout" {
					_, _ = reader.ReadByte()
					return
				}
				reply := ResponseVersion(6, request.Method, request.RequestId, nil, &Failure{Code: "revoked"})
				if fault == "wrong_version" {
					reply.SchemaVersion = 5
				}
				if fault == "wrong_id" {
					reply.RequestId = NewRequestID()
				}
				data, _ = json.Marshal(reply)
				_, _ = connection.Write(append(data, '\n'))
			})
			ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
			defer cancel()
			_, err := CallAgentArtifact(ctx, paths, "mcp.v6.publish_artifact", artifactRPCInput())
			<-done
			if fault == "timeout" {
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Fatal("artifact cancellation lost", err)
				}
				return
			}
			want := "invalid_request"
			if fault == "denial" {
				want = "revoked"
			}
			if fault == "disconnect" {
				want = "daemon_offline"
			}
			if AsFailure(err).Code != want {
				t.Fatal("artifact socket failure misclassified", fault, err)
			}
		})
	}
}
