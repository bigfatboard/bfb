// ABOUTME: Tests one-shot CLI result submission over actual negotiated v5 sockets with real peer startup checks.
// ABOUTME: Preserves original optional input and typed certainty while leaving daemon journal evidence untouched.

package cli

import (
	"bufio"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

func resultTestKey(canonical string) string {
	return fmt.Sprintf("agent:%x", sha256.Sum256([]byte(canonical)))
}

func runResultSocket(t *testing.T, dir string, reply func(generated.LocalRpcEnvelope) generated.LocalRpcEnvelope) <-chan error {
	t.Helper()
	paths, err := daemon.StatePaths(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err = paths.Prepare(); err != nil {
		t.Fatal(err)
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: paths.Socket, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	if os.Chmod(paths.Socket, 0600) != nil {
		t.Fatal("socket permissions")
	}
	t.Cleanup(func() { _ = listener.Close() })
	done := make(chan error, 1)
	go func() {
		connection, err := listener.AcceptUnix()
		if err != nil {
			done <- err
			return
		}
		defer connection.Close()
		_ = connection.SetDeadline(time.Now().Add(3 * time.Second))
		reader := bufio.NewReaderSize(connection, daemon.MaxRPCBytes+1)
		read := func() (generated.LocalRpcEnvelope, error) {
			line, err := reader.ReadBytes('\n')
			var req generated.LocalRpcEnvelope
			if err == nil {
				err = json.Unmarshal(line, &req)
			}
			return req, err
		}
		status, err := read()
		if err != nil {
			done <- err
			return
		}
		data, err := daemon.EncodeEnvelope(daemon.Response(status.Method, status.RequestId, map[string]any{"methods": []string{"mcp.v5.submit_result"}}, nil))
		if err != nil {
			done <- err
			return
		}
		_, _ = connection.Write(data)
		request, err := read()
		if err != nil {
			done <- err
			return
		}
		encoded, _ := json.Marshal(request)
		if !protocol.DecodeWireDocument("local-agent-result-rpc", encoded).OK {
			done <- &daemon.Failure{Code: "invalid_request"}
			return
		}
		data, err = daemon.EncodeEnvelope(reply(request))
		if err != nil {
			done <- err
			return
		}
		_, err = connection.Write(data)
		done <- err
	}()
	return done
}

func TestRunSubmitProtectedV5PreservesInputAndReceipt(t *testing.T) {
	for _, outcome := range []string{"committed", "pending", "blocked", "rejected", "applied", "denied"} {
		t.Run(outcome, func(t *testing.T) {
			submitEnv(t, nil)
			dir := shortDataDir(t)
			seedAssignments(t, filepath.Join(dir, "state.sqlite"), "running", testToken)
			// Evidence files are private daemon data and must never be opened by CLI.
			journalPath := filepath.Join(dir, "local-mcp-journal.sqlite")
			if os.WriteFile(journalPath, []byte("retained-corrupt-evidence"), 0600) != nil {
				t.Fatal("seed evidence")
			}
			var observed map[string]any
			done := runResultSocket(t, dir, func(request generated.LocalRpcEnvelope) generated.LocalRpcEnvelope {
				local := request.Payload["agent_result_request"].(map[string]any)
				observed = local
				if outcome == "denied" {
					return daemon.ResponseVersion(5, request.Method, request.RequestId, nil, &daemon.Failure{Code: "forbidden"})
				}
				if outcome == "committed" {
					return daemon.ResponseVersion(5, request.Method, request.RequestId, map[string]any{"agent_result": generated.AgentResultResult{SubmissionId: daemon.NewRequestID(), Version: 1, ResultState: "submitted", TaskState: "review", RunVersion: 2, TaskVersion: 2, Origin: generated.AgentEffectOrigin{RunId: testRun, RunExecutionId: testExecution, AssignmentGeneration: 7, ProviderSessionId: daemon.NewRequestID()}}}, nil)
				}
				reference := local["request"].(map[string]any)["reference"]
				identity := map[string]any{"tool": "submit_result"}
				for key, value := range reference.(map[string]any) {
					identity[key] = value
				}
				raw, _ := json.Marshal(identity)
				normalized, _ := protocol.NormalizeJSON(raw)
				key := resultTestKey(normalized)
				expires := "2026-10-06T12:05:00.000Z"
				receipt := generated.AgentResultReceipt{SchemaVersion: 1, OperationKey: key, RequestId: "cli-submit-001", Tool: "bfb_submit_result", AdmissionMode: "offline_admitted", DeliveryState: "pending_sync", EffectCertainty: "not_attempted", CapturedAt: "2026-10-06T12:00:00.000Z", IntentExpiresAt: &expires}
				switch outcome {
				case "blocked":
					reason := "work_unavailable"
					receipt.ReasonCode = &reason
					receipt.DeliveryState = "delivery_blocked"
					receipt.EffectCertainty = "possibly_applied"
				case "rejected":
					reason := "invalid_transition"
					receipt.ReasonCode = &reason
					receipt.DeliveryState = "rejected"
				case "applied":
					receipt.DeliveryState = "applied"
					receipt.EffectCertainty = "confirmed"
				}
				return daemon.ResponseVersion(5, request.Method, request.RequestId, map[string]any{"agent_result_receipt": receipt}, nil)
			})
			args := []string{"run", "submit", "--summary", "  Synthetic original summary  ", "--limitations", "", "--evidence-refs-json", "[]", "--request-id", "cli-submit-001"}
			code, output := executeRun(t, dir, args)
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			want := 0
			switch outcome {
			case "blocked":
				want = 4
			case "rejected":
				want = 6
			case "denied":
				want = 3
			}
			if code != want {
				t.Fatal("wrong exit category", code, output)
			}
			value := decodeLine(t, output)
			if outcome == "committed" && (value["version"] != float64(1) || value["task_state"] != "review") {
				t.Fatal("wrong committed projection", value)
			}
			if _, present := observed["expected_binding"]; present {
				t.Fatal("fresh CLI invented canonical binding")
			}
			input := observed["request"].(map[string]any)
			if input["summary"] != "  Synthetic original summary  " || input["limitations"] != "" || len(input["evidence_refs"].([]any)) != 0 {
				t.Fatal("original optional bytes normalized", input)
			}
			if _, present := input["binding"]; present {
				t.Fatal("client selected binding")
			}
			retained, err := os.ReadFile(journalPath)
			if err != nil || string(retained) != "retained-corrupt-evidence" {
				t.Fatal("CLI opened or modified journal", err)
			}
		})
	}
}
