// ABOUTME: Proves result captures use their own closed signature domain and current enrolled key.
// ABOUTME: Rejects task-proof substitution, metadata tampering and revocation during credential access.

package runner

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"github.com/qdis/bfb/internal/protocol/generated"
)

func resultSignerFixture(t *testing.T) (*Manager, *captureCredentials, generated.AgentResultCapture) {
	t.Helper()
	manager, credentials, task := captureSignerFixture(t)
	data, _ := json.Marshal(task)
	var capture generated.AgentResultCapture
	if err := json.Unmarshal(data, &capture); err != nil {
		t.Fatal(err)
	}
	capture.Confirmation.CanSubmit = true
	capture.Confirmation.ConfiguredPermission = map[string]any{"allow_submit_result": false, "max_pending_age_seconds": 0}
	capture.AdmittedPermission = map[string]any{"allow_submit_result": false, "max_pending_age_seconds": 0}
	capture.Operation["command_name"], capture.Operation["tool"] = "result.submit", "bfb_submit_result"
	return manager, credentials, capture
}

func TestResultCaptureFixedDomainAndCrossFamilyRejection(t *testing.T) {
	manager, credentials, capture := resultSignerFixture(t)
	signature, err := manager.SignAgentResultCapture(context.Background(), capture)
	if err != nil || !strings.HasPrefix(string(credentials.transcript), resultCapturePrefix) {
		t.Fatal("result signature", err)
	}
	capture.Signature = signature
	if err := manager.VerifyAgentResultCapture(context.Background(), capture); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.SignAgentResultCapture(context.Background(), capture); err != ErrProtocol || credentials.signs != 1 {
		t.Fatal("existing capture re-signed", err)
	}
	enrollment, _ := manager.store.Get(context.Background(), capture.Confirmation.RunnerId)
	decoded, _ := base64.RawURLEncoding.DecodeString(signature)
	taskDomain := []byte(agentCapturePrefix + strings.TrimPrefix(string(credentials.transcript), resultCapturePrefix))
	if verifyAgentCaptureSignature(enrollment, taskDomain, decoded) {
		t.Fatal("result signature valid in task capture domain")
	}
	data, _ := json.Marshal(capture)
	var task generated.AgentWorkCapture
	_ = json.Unmarshal(data, &task)
	if err := manager.VerifyAgentWorkCapture(context.Background(), task); err != ErrProtocol {
		t.Fatal("result proof accepted as task capture", err)
	}
}

func TestResultCaptureClosedInputAndTampering(t *testing.T) {
	for _, change := range []string{"ineligible", "task_permission", "task_tool", "workspace", "payload", "time", "padding", "private_body"} {
		t.Run(change, func(t *testing.T) {
			manager, credentials, capture := resultSignerFixture(t)
			signature, err := manager.SignAgentResultCapture(context.Background(), capture)
			if err != nil {
				t.Fatal(err)
			}
			capture.Signature = signature
			switch change {
			case "ineligible":
				capture.Confirmation.CanSubmit = false
			case "task_permission":
				capture.AdmittedPermission = map[string]any{"allowed_tools": []string{}, "max_pending_age_seconds": 0}
			case "task_tool":
				capture.Operation["tool"] = "bfb_add_comment"
			case "workspace":
				capture.Confirmation.WorkspaceId = capture.Confirmation.RunId
			case "payload":
				capture.Operation["payload_hash"] = "sha256:" + strings.Repeat("f", 64)
			case "time":
				capture.CapturedAt = "2026-10-06T00:00:00.002Z"
			case "padding":
				capture.Signature += "=="
			case "private_body":
				capture.Operation["summary"] = "private summary"
			}
			if err := manager.VerifyAgentResultCapture(context.Background(), capture); err == nil {
				t.Fatal("altered result capture accepted")
			}
			if credentials.signs != 1 {
				t.Fatal("verification accessed signer")
			}
		})
	}
}

func TestResultCaptureRevocationDuringSigning(t *testing.T) {
	manager, credentials, capture := resultSignerFixture(t)
	credentials.duringSign = func() {
		if err := manager.store.SetState(context.Background(), capture.Confirmation.RunnerId, "revoked"); err != nil {
			t.Fatal(err)
		}
	}
	if signature, err := manager.SignAgentResultCapture(context.Background(), capture); err != ErrRevoked || signature != "" {
		t.Fatal("result signature escaped known denial", err)
	}
}
