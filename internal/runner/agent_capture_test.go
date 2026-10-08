// ABOUTME: Tests closed capture signatures against real P-256 keys and durable enrollment identities.
// ABOUTME: Rejects substituted scope, metadata, keys, signature encodings and known local revocation.

package runner

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"github.com/qdis/bfb/internal/auth"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
)

type captureCredentials struct {
	*memoryCredentials
	ref        auth.CredentialRef
	transcript []byte
	duringSign func()
}

func (credentials *captureCredentials) Sign(ctx context.Context, ref auth.CredentialRef, transcript []byte) ([]byte, error) {
	credentials.ref = ref
	credentials.transcript = append([]byte(nil), transcript...)
	if credentials.duringSign != nil {
		credentials.duringSign()
	}
	return credentials.memoryCredentials.Sign(ctx, ref, transcript)
}

func captureSignerFixture(t *testing.T) (*Manager, *captureCredentials, generated.AgentWorkCapture) {
	t.Helper()
	store, _ := runnerStore(t)
	enrollment, memory := savedEnrollment(t, store)
	if err := store.SetState(context.Background(), enrollment.RunnerID, "online"); err != nil {
		t.Fatal(err)
	}
	lifetime, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	credentials := &captureCredentials{memoryCredentials: memory}
	manager := &Manager{store: store, credentials: credentials, ctx: lifetime}
	confirmation := map[string]any{
		"schema_version": 1,
		"workspace_id":   enrollment.WorkspaceID, "runner_id": enrollment.RunnerID,
		"runner_key_thumbprint": enrollment.Thumbprint,
		"binding":               map[string]any{"provider_session_id": daemon.NewRequestID(), "provider": "codex", "observed_session_id": "synthetic-session"},
		"configured_permission": map[string]any{"allowed_tools": []string{}, "max_pending_age_seconds": 0},
		"confirmed_at":          "2026-10-06T00:00:00.000Z", "lease_expires_at": "2026-10-06T00:00:45.000Z", "credential_expires_at": "2026-10-06T00:05:00.000Z",
	}
	for _, field := range []string{"confirmation_id", "project_id", "source_task_id", "run_id", "run_execution_id", "checkout_id", "requesting_human_id", "runner_owner_human_id"} {
		confirmation[field] = daemon.NewRequestID()
	}
	for _, field := range []string{"assignment_generation", "fencing_generation", "requesting_human_authorization_epoch", "runner_owner_authorization_epoch", "runner_authorization_epoch", "runner_grant_epoch", "runner_token_epoch", "snapshot_generation", "workspace_policy_version", "project_policy_version", "repository_config_version"} {
		confirmation[field] = 1
	}
	for _, field := range []string{"physical_worktree_hash", "snapshot_hash", "snapshot_repository_config_hash", "approved_repository_config_hash"} {
		confirmation[field] = "sha256:" + strings.Repeat("a", 64)
	}
	value := map[string]any{
		"schema_version": 1, "confirmation": confirmation,
		"operation": map[string]any{
			"command_name": "agent_run.comment", "tool": "bfb_add_comment", "operation_schema_version": 1,
			"operation_key": "agent:" + strings.Repeat("b", 64), "request_id": "synthetic-capture-001", "payload_hash": "sha256:" + strings.Repeat("c", 64),
			"expected_version": nil, "target_task_id": confirmation["source_task_id"], "parent_task_id": nil,
		},
		"admission_mode": "online_only", "admitted_permission": map[string]any{"allowed_tools": []string{}, "max_pending_age_seconds": 0},
		"captured_at": "2026-10-06T00:00:00.001Z", "intent_expires_at": nil, "signature": "",
	}
	encoded, _ := json.Marshal(value)
	var capture generated.AgentWorkCapture
	if err := json.Unmarshal(encoded, &capture); err != nil {
		t.Fatal(err)
	}
	return manager, credentials, capture
}

func TestAgentCaptureSignsOnlyFixedEnrolledMetadata(t *testing.T) {
	manager, credentials, capture := captureSignerFixture(t)
	ctx := context.Background()
	signature, err := manager.SignAgentWorkCapture(ctx, capture)
	if err != nil || !base64Length(signature, 64) {
		t.Fatal("capture signature failed", err)
	}
	wantRef := auth.CredentialRef{Kind: auth.RunnerKey, WorkspaceID: capture.Confirmation.WorkspaceId, ID: capture.Confirmation.RunnerId}
	if credentials.ref != wantRef || credentials.signs != 1 || !strings.HasPrefix(string(credentials.transcript), agentCapturePrefix) || !strings.HasSuffix(string(credentials.transcript), "\n") || len(credentials.transcript) > maxAgentCaptureBytes {
		t.Fatal("signer did not derive the fixed enrolled transcript")
	}
	if strings.Contains(string(credentials.transcript), `"signature"`) || strings.Contains(string(credentials.transcript), "private body") {
		t.Fatal("signature transcript contains forbidden fields")
	}
	capture.Signature = signature
	if err := manager.VerifyAgentWorkCapture(ctx, capture); err != nil {
		t.Fatal("original capture did not verify", err)
	}
	if _, err := manager.SignAgentWorkCapture(ctx, capture); err != ErrProtocol || credentials.signs != 1 {
		t.Fatal("existing capture was re-signed", err)
	}
	decoded, _ := base64.RawURLEncoding.DecodeString(signature)
	enrollment, _ := manager.store.Get(ctx, capture.Confirmation.RunnerId)
	if verifyAgentCaptureSignature(enrollment, []byte("BFB-RUNNER-POSSESSION-V1\n"+strings.TrimPrefix(string(credentials.transcript), agentCapturePrefix)), decoded) {
		t.Fatal("capture signature was valid in another domain")
	}
}

func TestAgentCaptureRejectsScopeAndClosedShapeBeforeSigning(t *testing.T) {
	for _, changed := range []string{"workspace", "runner", "thumbprint", "unknown_operation", "oversize", "online_permission"} {
		t.Run(changed, func(t *testing.T) {
			manager, credentials, capture := captureSignerFixture(t)
			switch changed {
			case "workspace":
				capture.Confirmation.WorkspaceId = daemon.NewRequestID()
			case "runner":
				capture.Confirmation.RunnerId = daemon.NewRequestID()
			case "thumbprint":
				capture.Confirmation.RunnerKeyThumbprint = "sha256:" + strings.Repeat("f", 64)
			case "unknown_operation":
				capture.Operation["private_body"] = "private body"
			case "oversize":
				capture.Operation["request_id"] = strings.Repeat("x", maxAgentCaptureBytes)
			case "online_permission":
				capture.AdmittedPermission = map[string]any{"allowed_tools": []string{"bfb_add_comment"}, "max_pending_age_seconds": 30}
			}
			if signature, err := manager.SignAgentWorkCapture(context.Background(), capture); err == nil || signature != "" || credentials.signs != 0 {
				t.Fatal("invalid capture reached credential signing", changed, err)
			}
		})
	}
}

func TestAgentCaptureRejectsTamperingAndNoncanonicalSignature(t *testing.T) {
	for _, changed := range []string{"payload", "time", "policy", "token", "padding", "pad_bits", "different_key"} {
		t.Run(changed, func(t *testing.T) {
			manager, _, capture := captureSignerFixture(t)
			signature, err := manager.SignAgentWorkCapture(context.Background(), capture)
			if err != nil {
				t.Fatal(err)
			}
			capture.Signature = signature
			switch changed {
			case "payload":
				capture.Operation["payload_hash"] = "sha256:" + strings.Repeat("d", 64)
			case "time":
				capture.CapturedAt = "2026-10-06T00:00:00.002Z"
			case "policy":
				capture.Confirmation.ProjectPolicyVersion++
			case "token":
				capture.Confirmation.RunnerTokenEpoch++
			case "padding":
				capture.Signature += "=="
			case "pad_bits":
				capture.Signature = signature[:85] + "B"
			case "different_key":
				_, other := testEnrollment(t)
				transcript, _ := agentCaptureTranscript(capture)
				foreign, _ := other.Sign(context.Background(), auth.CredentialRef{}, transcript)
				capture.Signature = base64.RawURLEncoding.EncodeToString(foreign)
			}
			if err := manager.VerifyAgentWorkCapture(context.Background(), capture); err == nil {
				t.Fatal("altered capture verified", changed)
			}
		})
	}
}

func TestAgentCaptureKnownLocalDenialAndKeyReplacement(t *testing.T) {
	for _, state := range []string{"revoked", "authorization_required", "pending_approval", "sync_blocked"} {
		t.Run(state, func(t *testing.T) {
			manager, credentials, capture := captureSignerFixture(t)
			if err := manager.store.SetState(context.Background(), capture.Confirmation.RunnerId, state); err != nil {
				t.Fatal(err)
			}
			if signature, err := manager.SignAgentWorkCapture(context.Background(), capture); err == nil || signature != "" || credentials.signs != 0 {
				t.Fatal("known denial reached signing", state, err)
			}
		})
	}
	t.Run("revoked_during_sign", func(t *testing.T) {
		manager, credentials, capture := captureSignerFixture(t)
		credentials.duringSign = func() {
			if err := manager.store.SetState(context.Background(), capture.Confirmation.RunnerId, "revoked"); err != nil {
				t.Fatal(err)
			}
		}
		if signature, err := manager.SignAgentWorkCapture(context.Background(), capture); err != ErrRevoked || signature != "" {
			t.Fatal("signature returned after known revocation", err)
		}
	})
	t.Run("key_replaced_in_credential_store", func(t *testing.T) {
		manager, credentials, capture := captureSignerFixture(t)
		_, replacement := testEnrollment(t)
		credentials.memoryCredentials = replacement
		if signature, err := manager.SignAgentWorkCapture(context.Background(), capture); err != ErrProtocol || signature != "" {
			t.Fatal("replacement key signed original enrollment", err)
		}
	})
	t.Run("stopped_manager", func(t *testing.T) {
		manager, credentials, capture := captureSignerFixture(t)
		stopped, cancel := context.WithCancel(context.Background())
		cancel()
		manager.ctx = stopped
		if signature, err := manager.SignAgentWorkCapture(context.Background(), capture); err != ErrOffline || signature != "" || credentials.signs != 0 {
			t.Fatal("stopped manager signed a capture", err)
		}
	})
}
