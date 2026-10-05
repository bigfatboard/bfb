// ABOUTME: Builds immutable signed work intents from daemon-verified confirmation and original typed input.
// ABOUTME: Preserves business identity and admits offline permission only within the original capture window.

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

type captureSigner func(context.Context, generated.AgentWorkCapture) (string, error)

type capturePermission struct {
	AllowedTools         []string `json:"allowed_tools"`
	MaxPendingAgeSeconds int64    `json:"max_pending_age_seconds"`
}

type capturedWriteReference struct {
	Reference       generated.AgentWorkRequest      `json:"reference"`
	Binding         generated.AgentSessionReference `json:"binding"`
	ExpectedVersion *int64                          `json:"expected_version"`
	ParentTaskID    *string                         `json:"parent_task_id"`
}

// The caller establishes current native scope and verifies the cloud response
// before populating timing. This helper grants no authority from typed input
// alone and never signs an existing journal identity again.
func prepareWorkIntent(ctx context.Context, commandName string, original []byte, confirmation generated.AgentCaptureConfirmationResult, timing *captureTiming, sign captureSigner) (journalIntent, error) {
	command, known := agentWorkCommand(commandName)
	if !known || sign == nil || timing == nil || timing.requestID != confirmation.ConfirmationId {
		return journalIntent{}, errWorkInvalid
	}
	canonical, err := protocol.CanonicalAgentWriteRequest(commandName, original)
	if err != nil {
		return journalIntent{}, errWorkInvalid
	}
	var request capturedWriteReference
	if json.Unmarshal([]byte(canonical), &request) != nil ||
		request.Reference.RunExecutionId != confirmation.RunExecutionId ||
		request.Reference.AssignmentGeneration != confirmation.AssignmentGeneration ||
		request.Binding != confirmation.Binding ||
		(request.ParentTaskID != nil && *request.ParentTaskID != confirmation.SourceTaskId) {
		return journalIntent{}, errWorkInvalid
	}
	confirmationJSON, err := json.Marshal(confirmation)
	if err != nil || len(confirmationJSON) > 4096 || !protocol.DecodeWireDocument("agent-capture-confirmation-result", confirmationJSON).OK {
		return journalIntent{}, errWorkInvalid
	}
	if err := matchingCaptureTiming(timing, confirmation); err != nil {
		return journalIntent{}, err
	}
	key, err := agentOperationKey(commandName, request.Reference)
	if err != nil {
		return journalIntent{}, err
	}
	capturedAt, err := timing.captureTime()
	if err != nil {
		return journalIntent{}, err
	}
	digest := sha256.Sum256([]byte(canonical))
	fingerprint := hex.EncodeToString(digest[:])
	var expectedVersion, targetTask, parentTask any
	if request.ExpectedVersion != nil {
		expectedVersion = *request.ExpectedVersion
	}
	if command.action != "proposal" {
		targetTask = confirmation.SourceTaskId
	}
	if request.ParentTaskID != nil {
		parentTask = *request.ParentTaskID
	}
	capture := generated.AgentWorkCapture{
		SchemaVersion: 1, Confirmation: confirmation,
		Operation: map[string]any{
			"command_name": command.name, "tool": command.tool, "operation_schema_version": request.Reference.SchemaVersion,
			"operation_key": key, "request_id": request.Reference.RequestId, "payload_hash": "sha256:" + fingerprint,
			"expected_version": expectedVersion, "target_task_id": targetTask, "parent_task_id": parentTask,
		},
		AdmissionMode: "online_only", AdmittedPermission: map[string]any{"allowed_tools": []string{}, "max_pending_age_seconds": int64(0)},
		CapturedAt: capturedAt.Format("2006-01-02T15:04:05.000Z"),
	}
	permissionJSON, err := json.Marshal(confirmation.ConfiguredPermission)
	var permission capturePermission
	if err != nil || json.Unmarshal(permissionJSON, &permission) != nil {
		return journalIntent{}, errWorkInvalid
	}
	allowed := false
	for _, tool := range permission.AllowedTools {
		allowed = allowed || tool == command.tool
	}
	if allowed && confirmation.SnapshotRepositoryConfigHash == confirmation.ApprovedRepositoryConfigHash {
		capture.AdmissionMode = "offline_admitted"
		// Keep the exact configured set/order, not a widened or reconstructed grant.
		capture.AdmittedPermission = confirmation.ConfiguredPermission
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
	// Signing can wait on the credential store. Expiry or a clock fault during
	// that wait prevents durable admission even if a signature was produced.
	if err := checkAdmissionDeadline(timing, capture); err != nil {
		return journalIntent{}, err
	}
	capture.Signature = signature
	captureJSON, err := json.Marshal(capture)
	if err != nil || len(captureJSON) > 8192 || !protocol.DecodeWireDocument("agent-work-capture", captureJSON).OK {
		return journalIntent{}, errWorkInvalid
	}
	intent := journalIntent{
		OperationKey: key, Fingerprint: fingerprint, Tool: command.tool, RunID: confirmation.RunId,
		AdmissionMode: capture.AdmissionMode, RequestJSON: canonical,
		ConfirmationJSON: string(confirmationJSON), CaptureJSON: string(captureJSON),
	}
	if validateJournalIntent(intent) != nil {
		return journalIntent{}, errWorkInvalid
	}
	return intent, nil
}

func matchingCaptureTiming(timing *captureTiming, confirmation generated.AgentCaptureConfirmationResult) error {
	timing.mu.Lock()
	defer timing.mu.Unlock()
	if timing.failure != nil {
		return timing.failure
	}
	if !timing.hasSend || !timing.hasReceipt {
		return timing.invalidate(errCaptureTimingMissing)
	}
	confirmed, err := time.Parse(time.RFC3339Nano, confirmation.ConfirmedAt)
	lease, leaseErr := time.Parse(time.RFC3339Nano, confirmation.LeaseExpiresAt)
	credential, credentialErr := time.Parse(time.RFC3339Nano, confirmation.CredentialExpiresAt)
	if err != nil || leaseErr != nil || credentialErr != nil || timing.requestID != confirmation.ConfirmationId ||
		!timing.confirmedAt.Equal(confirmed) || !timing.leaseExpiresAt.Equal(lease) || !timing.credentialExpiresAt.Equal(credential) {
		return timing.invalidate(errCaptureTimingInvalid)
	}
	return nil
}

func checkAdmissionDeadline(timing *captureTiming, capture generated.AgentWorkCapture) error {
	now, err := timing.captureTime()
	if err != nil {
		return err
	}
	if capture.IntentExpiresAt != nil {
		expires, err := time.Parse(time.RFC3339Nano, *capture.IntentExpiresAt)
		if err != nil || !now.Before(expires) {
			return errCaptureTimingExpired
		}
	}
	return nil
}
