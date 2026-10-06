// ABOUTME: Signs and verifies closed agent-work capture metadata with the locally enrolled runner key.
// ABOUTME: Derives credential scope and a fixed transcript internally without exposing a signing RPC.

package runner

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"strings"

	"github.com/qdis/bfb/internal/auth"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

const agentCapturePrefix = "BFB-AGENT-WORK-CAPTURE-V1\n"
const maxAgentCaptureBytes = 8192

// SignAgentWorkCapture is called only after daemon admission has derived and
// verified all capture fields. It does not grant admission or refresh authority.
// Existing signatures cannot be replaced to give an old intent new provenance.
func (manager *Manager) SignAgentWorkCapture(ctx context.Context, capture generated.AgentWorkCapture) (string, error) {
	if capture.Signature != "" {
		return "", ErrProtocol
	}
	transcript, err := agentCaptureTranscript(capture)
	if err != nil {
		return "", err
	}
	return manager.signCapture(ctx, capture.Confirmation.WorkspaceId, capture.Confirmation.RunnerId, capture.Confirmation.RunnerKeyThumbprint, transcript)
}

func (manager *Manager) signCapture(ctx context.Context, workspaceID, runnerID, thumbprint string, transcript []byte) (string, error) {
	enrollment, err := manager.captureEnrollment(ctx, workspaceID, runnerID, thumbprint)
	if err != nil {
		return "", err
	}
	ref := auth.CredentialRef{Kind: auth.RunnerKey, WorkspaceID: enrollment.WorkspaceID, ID: enrollment.RunnerID}
	signature, err := manager.credentials.Sign(ctx, ref, transcript)
	if err != nil {
		return "", err
	}
	if !verifyAgentCaptureSignature(enrollment, transcript, signature) {
		return "", ErrProtocol
	}
	// Key access may block. Do not return a signature after observing a changed
	// enrollment or known local authorization denial during that wait.
	current, err := manager.captureEnrollment(ctx, workspaceID, runnerID, thumbprint)
	if err != nil {
		return "", err
	}
	if current.Thumbprint != enrollment.Thumbprint {
		return "", ErrProtocol
	}
	return base64.RawURLEncoding.EncodeToString(signature), nil
}

// VerifyAgentWorkCapture checks original capture provenance against the enrolled
// key. The caller must separately verify payload identity and current authority.
func (manager *Manager) VerifyAgentWorkCapture(ctx context.Context, capture generated.AgentWorkCapture) error {
	if !base64Length(capture.Signature, 64) {
		return ErrProtocol
	}
	transcript, err := agentCaptureTranscript(capture)
	if err != nil {
		return err
	}
	return manager.verifyCapture(ctx, capture.Confirmation.WorkspaceId, capture.Confirmation.RunnerId, capture.Confirmation.RunnerKeyThumbprint, transcript, capture.Signature)
}

func (manager *Manager) verifyCapture(ctx context.Context, workspaceID, runnerID, thumbprint string, transcript []byte, encodedSignature string) error {
	if !base64Length(encodedSignature, 64) {
		return ErrProtocol
	}
	enrollment, err := manager.captureEnrollment(ctx, workspaceID, runnerID, thumbprint)
	if err != nil {
		return err
	}
	signature, _ := base64.RawURLEncoding.DecodeString(encodedSignature)
	if !verifyAgentCaptureSignature(enrollment, transcript, signature) {
		return ErrProtocol
	}
	return nil
}

func (manager *Manager) captureEnrollment(ctx context.Context, workspaceID, runnerID, thumbprint string) (Enrollment, error) {
	manager.mu.Lock()
	store, lifetime := manager.store, manager.ctx
	manager.mu.Unlock()
	if store == nil || lifetime == nil || lifetime.Err() != nil {
		return Enrollment{}, ErrOffline
	}
	enrollment, err := store.Get(ctx, runnerID)
	if err != nil {
		if ctx.Err() != nil {
			return Enrollment{}, ErrOffline
		}
		return Enrollment{}, &daemon.Failure{Code: "storage_failed"}
	}
	switch enrollment.State {
	case "revoked":
		return Enrollment{}, ErrRevoked
	case "online", "offline", "connecting":
	default:
		return Enrollment{}, ErrAuthorization
	}
	if enrollment.validate() != nil || enrollment.WorkspaceID != workspaceID || enrollment.Thumbprint != thumbprint {
		return Enrollment{}, ErrProtocol
	}
	return enrollment, nil
}

func agentCaptureTranscript(capture generated.AgentWorkCapture) ([]byte, error) {
	// Validate the complete closed shape before removing its signature. The
	// placeholder is only for unsigned typed input, never accepted as provenance.
	if capture.Signature == "" {
		capture.Signature = strings.Repeat("A", 86)
	}
	return captureTranscript(capture, "agent-work-capture", agentCapturePrefix)
}

// Callers select fixed capture families; this helper is not an RPC or signer
// service and accepts no unvalidated caller-selected transcript or key.
func captureTranscript(capture any, document, prefix string) ([]byte, error) {
	encoded, err := json.Marshal(capture)
	if err != nil || len(encoded) > maxAgentCaptureBytes {
		return nil, ErrProtocol
	}
	decoded := protocol.DecodeWireDocument(document, encoded)
	if !decoded.OK {
		return nil, ErrProtocol
	}
	delete(decoded.Value, "signature")
	unsigned, err := json.Marshal(decoded.Value)
	if err != nil {
		return nil, ErrProtocol
	}
	canonical, err := protocol.NormalizeJSON(unsigned)
	if err != nil {
		return nil, ErrProtocol
	}
	transcript := []byte(prefix + canonical + "\n")
	if len(transcript) > maxAgentCaptureBytes {
		return nil, ErrProtocol
	}
	return transcript, nil
}

func verifyAgentCaptureSignature(enrollment Enrollment, transcript, signature []byte) bool {
	if len(signature) != 64 {
		return false
	}
	var jwk struct {
		Curve string `json:"crv"`
		Kind  string `json:"kty"`
		X     string `json:"x"`
		Y     string `json:"y"`
	}
	if strictJSON(enrollment.PublicKey, &jwk) != nil || jwk.Curve != "P-256" || jwk.Kind != "EC" || !base64Length(jwk.X, 32) || !base64Length(jwk.Y, 32) {
		return false
	}
	x, _ := base64.RawURLEncoding.DecodeString(jwk.X)
	y, _ := base64.RawURLEncoding.DecodeString(jwk.Y)
	key := &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}
	if !key.Curve.IsOnCurve(key.X, key.Y) {
		return false
	}
	digest := sha256.Sum256(transcript)
	return ecdsa.Verify(key, digest[:], new(big.Int).SetBytes(signature[:32]), new(big.Int).SetBytes(signature[32:]))
}
