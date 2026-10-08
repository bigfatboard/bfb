// ABOUTME: Constructs result-only signed capture from independently verified daemon confirmation.
// ABOUTME: Preserves exact submission identity and refuses new capture without current submission eligibility.

package agentwork

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"

	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

type resultCaptureSigner func(context.Context, generated.AgentResultCapture) (string, error)

type resultPermission struct {
	AllowSubmitResult    bool  `json:"allow_submit_result"`
	MaxPendingAgeSeconds int64 `json:"max_pending_age_seconds"`
}

func prepareResultIntent(ctx context.Context, original []byte, confirmation generated.AgentResultConfirmationResult, timing *captureTiming, sign resultCaptureSigner) (journalIntent, error) {
	if sign == nil || timing == nil || timing.requestID != confirmation.ConfirmationId || !confirmation.CanSubmit {
		return journalIntent{}, errWorkInvalid
	}
	canonical, err := protocol.CanonicalAgentWriteRequest("result.submit", original)
	if err != nil {
		return journalIntent{}, errWorkInvalid
	}
	var request generated.AgentResultRequest
	if json.Unmarshal([]byte(canonical), &request) != nil || request.Reference.RunExecutionId != confirmation.RunExecutionId ||
		request.Reference.AssignmentGeneration != confirmation.AssignmentGeneration || request.Binding != confirmation.Binding {
		return journalIntent{}, errWorkInvalid
	}
	confirmationJSON, err := json.Marshal(confirmation)
	if err != nil || len(confirmationJSON) > 4096 || !protocol.DecodeWireDocument("agent-result-confirmation-result", confirmationJSON).OK {
		return journalIntent{}, errWorkInvalid
	}
	if err := matchingCaptureTimes(timing, confirmation.ConfirmationId, confirmation.ConfirmedAt, confirmation.LeaseExpiresAt, confirmation.CredentialExpiresAt); err != nil {
		return journalIntent{}, err
	}
	key, err := agentOperationKey("result.submit", request.Reference)
	if err != nil {
		return journalIntent{}, err
	}
	capturedAt, err := timing.captureTime()
	if err != nil {
		return journalIntent{}, err
	}
	digest := sha256.Sum256([]byte(canonical))
	fingerprint := hex.EncodeToString(digest[:])
	capture := generated.AgentResultCapture{
		SchemaVersion: 1, Confirmation: confirmation,
		Operation: map[string]any{
			"command_name": "result.submit", "tool": "bfb_submit_result", "operation_schema_version": request.Reference.SchemaVersion,
			"operation_key": key, "request_id": request.Reference.RequestId, "payload_hash": "sha256:" + fingerprint,
			"expected_version": nil, "target_task_id": confirmation.SourceTaskId, "parent_task_id": nil,
		},
		AdmissionMode: "online_only", AdmittedPermission: map[string]any{"allow_submit_result": false, "max_pending_age_seconds": int64(0)},
		CapturedAt: capturedAt.Format("2006-01-02T15:04:05.000Z"),
	}
	permissionJSON, err := json.Marshal(confirmation.ConfiguredPermission)
	var permission resultPermission
	if err != nil || json.Unmarshal(permissionJSON, &permission) != nil {
		return journalIntent{}, errWorkInvalid
	}
	if permission.AllowSubmitResult && confirmation.SnapshotRepositoryConfigHash == confirmation.ApprovedRepositoryConfigHash {
		capture.AdmissionMode, capture.AdmittedPermission = "offline_admitted", confirmation.ConfiguredPermission
		expiresAt := capturedAt.Add(time.Duration(permission.MaxPendingAgeSeconds) * time.Second)
		if !canonicalCaptureInstant(expiresAt) {
			return journalIntent{}, errWorkInvalid
		}
		stamp := expiresAt.Format("2006-01-02T15:04:05.000Z")
		capture.IntentExpiresAt = &stamp
	}
	signature, err := sign(ctx, capture)
	if err != nil {
		return journalIntent{}, err
	}
	if err := checkCaptureExpiry(timing, capture.IntentExpiresAt); err != nil {
		return journalIntent{}, err
	}
	capture.Signature = signature
	captureJSON, err := json.Marshal(capture)
	if err != nil || len(captureJSON) > 8192 || !protocol.DecodeWireDocument("agent-result-capture", captureJSON).OK {
		return journalIntent{}, errWorkInvalid
	}
	intent := journalIntent{
		OperationKey: key, Fingerprint: fingerprint, Tool: "bfb_submit_result", RunID: confirmation.RunId,
		AdmissionMode: capture.AdmissionMode, RequestJSON: canonical, ConfirmationJSON: string(confirmationJSON), CaptureJSON: string(captureJSON),
		CaptureFamily: "agent_result", CaptureVersion: 1,
	}
	if validateJournalIntent(intent) != nil {
		return journalIntent{}, errWorkInvalid
	}
	return intent, nil
}
