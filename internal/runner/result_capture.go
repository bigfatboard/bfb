// ABOUTME: Signs only closed result-capture metadata with the daemon's enrolled runner key.
// ABOUTME: Separates result proof from task-work capture while sharing exact key and signature validation.

package runner

import (
	"context"
	"strings"

	"github.com/qdis/bfb/internal/protocol/generated"
)

const resultCapturePrefix = "BFB-AGENT-RESULT-CAPTURE-V1\n"

func (manager *Manager) SignAgentResultCapture(ctx context.Context, capture generated.AgentResultCapture) (string, error) {
	if capture.Signature != "" {
		return "", ErrProtocol
	}
	transcript, err := resultCaptureTranscript(capture)
	if err != nil {
		return "", err
	}
	return manager.signCapture(ctx, capture.Confirmation.WorkspaceId, capture.Confirmation.RunnerId, capture.Confirmation.RunnerKeyThumbprint, transcript)
}

func (manager *Manager) VerifyAgentResultCapture(ctx context.Context, capture generated.AgentResultCapture) error {
	if !base64Length(capture.Signature, 64) {
		return ErrProtocol
	}
	transcript, err := resultCaptureTranscript(capture)
	if err != nil {
		return err
	}
	return manager.verifyCapture(ctx, capture.Confirmation.WorkspaceId, capture.Confirmation.RunnerId, capture.Confirmation.RunnerKeyThumbprint, transcript, capture.Signature)
}

func resultCaptureTranscript(capture generated.AgentResultCapture) ([]byte, error) {
	if capture.Signature == "" {
		capture.Signature = strings.Repeat("A", 86)
	}
	return captureTranscript(capture, "agent-result-capture", resultCapturePrefix)
}
