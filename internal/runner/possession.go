// ABOUTME: Validates server possession challenges against an exact workspace enrollment and request.
// ABOUTME: Matches C06's domain-separated transcript and stateful token without treating public claims as authority.

package runner

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
)

var (
	ErrProtocol      = errors.New("runner protocol rejected")
	ErrOffline       = errors.New("runner connection unavailable")
	ErrAuthorization = errors.New("runner authorization required")
	ErrRevoked       = errors.New("runner enrollment revoked")
	ulidPattern      = regexp.MustCompile(`^[0-7][0-9A-HJKMNP-TV-Z]{25}$`)
	labelPattern     = regexp.MustCompile(`^[\p{L}\p{N}][\p{L}\p{N} ._()'-]{0,79}$`)
)

const Audience = "bfb-runner"
const ProofHeader = "X-BFB-Runner-Proof"
const maxResponseBytes = 65536

type Enrollment struct {
	RunnerID    string          `json:"runner_id"`
	WorkspaceID string          `json:"workspace_id"`
	Origin      string          `json:"app_origin"`
	Label       string          `json:"device_label"`
	PublicKey   json.RawMessage `json:"public_key"`
	Thumbprint  string          `json:"public_key_thumbprint"`
	State       string          `json:"connection_state"`
	TokenEpoch  int64           `json:"token_epoch"`
	CreatedAt   string          `json:"created_at"`
}

func canonicalOrigin(value string) (string, error) {
	origin, err := url.Parse(value)
	if err != nil || origin.Scheme != "https" || origin.Host == "" || origin.Hostname() == "" || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" || origin.Opaque != "" || len(value) > 256 || origin.String() != value || strings.ToLower(origin.Host) != origin.Host {
		return "", ErrProtocol
	}
	return value, nil
}

func (enrollment Enrollment) basePath() string {
	return "/runner/workspaces/" + enrollment.WorkspaceID + "/runners/" + enrollment.RunnerID
}

func (enrollment Enrollment) keyValid() bool {
	var key struct {
		Curve string `json:"crv"`
		Kind  string `json:"kty"`
		X     string `json:"x"`
		Y     string `json:"y"`
	}
	if strictJSON(enrollment.PublicKey, &key) != nil || key.Curve != "P-256" || key.Kind != "EC" || !base64Length(key.X, 32) || !base64Length(key.Y, 32) {
		return false
	}
	canonical, _ := json.Marshal(key)
	digest := sha256.Sum256(canonical)
	return "sha256:"+hex.EncodeToString(digest[:]) == enrollment.Thumbprint
}

func (enrollment Enrollment) validate() error {
	if _, err := canonicalOrigin(enrollment.Origin); err != nil || !ulidPattern.MatchString(enrollment.RunnerID) || !ulidPattern.MatchString(enrollment.WorkspaceID) || !labelPattern.MatchString(enrollment.Label) || !enrollment.keyValid() {
		return ErrProtocol
	}
	return nil
}

type RequestBinding struct {
	Method     string `json:"method"`
	Path       string `json:"path"`
	BodySHA256 string `json:"body_sha256"`
}

func binding(method, path string, body []byte) RequestBinding {
	digest := sha256.Sum256(body)
	return RequestBinding{Method: method, Path: path, BodySHA256: hex.EncodeToString(digest[:])}
}

func challengeTranscript(challenge generated.RunnerChallenge) []byte {
	var request any
	if challenge.Request != nil {
		request = []any{challenge.Request["method"], challenge.Request["path"], challenge.Request["body_sha256"]}
	}
	values := []any{challenge.ChallengeId, challenge.ServerNonce, challenge.WorkspaceId, challenge.RunnerId, challenge.Audience, challenge.Origin, challenge.PublicKeyThumbprint, challenge.Purpose, challenge.AuthorizationEpoch, challenge.OwnerAuthorizationEpoch, challenge.GrantEpoch, challenge.TokenEpoch, challenge.TokenId, request, challenge.IssuedAt, challenge.ExpiresAt}
	var result bytes.Buffer
	result.WriteString("BFB-RUNNER-POSSESSION-V1\n")
	encoder := json.NewEncoder(&result)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(values)
	return result.Bytes()
}

func validateChallenge(data []byte, enrollment Enrollment, request *RequestBinding, token *tokenClaims) (generated.RunnerChallenge, error) {
	var challenge generated.RunnerChallenge
	if !protocol.DecodeWireDocument("runner-challenge", data).OK || json.Unmarshal(data, &challenge) != nil {
		return challenge, ErrProtocol
	}
	if challenge.WorkspaceId != enrollment.WorkspaceID || challenge.RunnerId != enrollment.RunnerID || challenge.Origin != enrollment.Origin || challenge.Audience != Audience || challenge.PublicKeyThumbprint != enrollment.Thumbprint || !base64Length(challenge.ServerNonce, 32) || challenge.TokenEpoch < enrollment.TokenEpoch {
		return challenge, ErrProtocol
	}
	issued, err := time.Parse(time.RFC3339Nano, challenge.IssuedAt)
	expires, expiryError := time.Parse(time.RFC3339Nano, challenge.ExpiresAt)
	if err != nil || expiryError != nil || expires.Sub(issued) != time.Minute {
		return challenge, ErrProtocol
	}
	if request == nil {
		if challenge.Purpose != "token" || challenge.TokenId != nil || challenge.Request != nil {
			return challenge, ErrProtocol
		}
	} else if token == nil || challenge.Purpose != "request" || challenge.TokenId == nil || *challenge.TokenId != token.TokenID || challenge.Request["method"] != request.Method || challenge.Request["path"] != request.Path || challenge.Request["body_sha256"] != request.BodySHA256 || challenge.TokenEpoch != token.TokenEpoch || challenge.AuthorizationEpoch != token.AuthorizationEpoch || challenge.OwnerAuthorizationEpoch != token.OwnerAuthorizationEpoch || challenge.GrantEpoch != token.GrantEpoch {
		return challenge, ErrProtocol
	}
	return challenge, nil
}

type tokenClaims struct {
	Version                 int64  `json:"v"`
	Subject                 string `json:"sub"`
	WorkspaceID             string `json:"workspace_id"`
	Audience                string `json:"aud"`
	Issuer                  string `json:"iss"`
	TokenID                 string `json:"jti"`
	Issued                  int64  `json:"iat"`
	Expires                 int64  `json:"exp"`
	AuthorizationEpoch      int64  `json:"authorization_epoch"`
	OwnerAuthorizationEpoch int64  `json:"owner_authorization_epoch"`
	GrantEpoch              int64  `json:"grant_epoch"`
	TokenEpoch              int64  `json:"token_epoch"`
	Confirmation            struct {
		Thumbprint string `json:"jkt"`
	} `json:"cnf"`
}

func validateToken(token, expiresAt string, enrollment Enrollment, challenge generated.RunnerChallenge) (tokenClaims, error) {
	var claims tokenClaims
	parts := strings.Split(strings.TrimPrefix(token, "bfb_runner_"), ".")
	if !strings.HasPrefix(token, "bfb_runner_") || len(token) > 2048 || len(parts) != 2 || !base64Length(parts[1], 32) {
		return claims, ErrProtocol
	}
	data, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || base64.RawURLEncoding.EncodeToString(data) != parts[0] || strictJSON(data, &claims) != nil {
		return claims, ErrProtocol
	}
	issued, _ := time.Parse(time.RFC3339Nano, challenge.IssuedAt)
	expires, err := time.Parse(time.RFC3339Nano, expiresAt)
	if err != nil || claims.Version != 1 || claims.Subject != enrollment.RunnerID || claims.WorkspaceID != enrollment.WorkspaceID || claims.Audience != Audience || claims.Issuer != enrollment.Origin || !ulidPattern.MatchString(claims.TokenID) || claims.Confirmation.Thumbprint != enrollment.Thumbprint || claims.AuthorizationEpoch != challenge.AuthorizationEpoch || claims.OwnerAuthorizationEpoch != challenge.OwnerAuthorizationEpoch || claims.GrantEpoch != challenge.GrantEpoch || claims.TokenEpoch != challenge.TokenEpoch+1 || claims.Expires-claims.Issued != 300 || claims.Issued < issued.Unix() || claims.Issued >= issued.Add(time.Minute).Unix() || expires.Unix() != claims.Expires {
		return claims, ErrProtocol
	}
	return claims, nil
}

func base64Length(value string, length int) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == length && base64.RawURLEncoding.EncodeToString(decoded) == value
}

func strictJSON(data []byte, target any) error {
	var raw json.RawMessage
	if len(data) == 0 || len(data) > maxResponseBytes || provider.DecodeJSON(data, &raw) != nil {
		return ErrProtocol
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil {
		return ErrProtocol
	}
	if decoder.Decode(new(any)) != io.EOF {
		return ErrProtocol
	}
	return nil
}
