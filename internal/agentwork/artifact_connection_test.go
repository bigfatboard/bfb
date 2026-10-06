// ABOUTME: Exercises artifact recovery and local authority fences with a real possession TLS connection.
// ABOUTME: Keeps committed cloud facts separate from private delivery after connection revocation or replacement.

package agentwork

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/auth"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/runner"
)

type artifactTestCredentials struct {
	key    *ecdsa.PrivateKey
	public []byte
}

func (credentials *artifactTestCredentials) CreateKey(context.Context, auth.CredentialRef) ([]byte, error) {
	return credentials.public, nil
}
func (credentials *artifactTestCredentials) PublicKey(context.Context, auth.CredentialRef) ([]byte, error) {
	return credentials.public, nil
}
func (credentials *artifactTestCredentials) Read(context.Context, auth.CredentialRef) ([]byte, error) {
	return nil, nil
}
func (credentials *artifactTestCredentials) Write(context.Context, auth.CredentialRef, []byte) error {
	return nil
}
func (credentials *artifactTestCredentials) Delete(context.Context, auth.CredentialRef) error {
	return nil
}
func (credentials *artifactTestCredentials) Sign(_ context.Context, _ auth.CredentialRef, transcript []byte) ([]byte, error) {
	digest := sha256.Sum256(transcript)
	r, s, err := ecdsa.Sign(rand.Reader, credentials.key, digest[:])
	if err != nil {
		return nil, err
	}
	signature := make([]byte, 64)
	r.FillBytes(signature[:32])
	s.FillBytes(signature[32:])
	return signature, nil
}

// This fixture validates the real possession proof and body binding. It is not
// a Worker/domain acceptance substitute; only its publication response is fake.
func artifactTLSConnection(t *testing.T, cloud *artifactCloudDouble) (*runner.Connection, func(string)) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	public, _ := json.Marshal(map[string]string{"crv": "P-256", "kty": "EC", "x": base64.RawURLEncoding.EncodeToString(key.X.FillBytes(make([]byte, 32))), "y": base64.RawURLEncoding.EncodeToString(key.Y.FillBytes(make([]byte, 32)))})
	thumbprint := sha256.Sum256(public)
	enrollment := runner.Enrollment{RunnerID: workOtherID, WorkspaceID: workTestID, Origin: "https://synthetic.test", Label: "Synthetic Mac", PublicKey: public, Thumbprint: "sha256:" + hex.EncodeToString(thumbprint[:]), State: "connected"}
	var mutex sync.Mutex
	var token, tokenID string
	var epoch int64
	authorizationEpoch, ownerEpoch, grantEpoch := int64(1), int64(2), int64(3)
	challenges := map[string]generated.RunnerChallenge{}
	basePath := "/runner/workspaces/" + enrollment.WorkspaceID + "/runners/" + enrollment.RunnerID + "/"
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mutex.Lock()
		defer mutex.Unlock()
		body, err := io.ReadAll(io.LimitReader(request.Body, 65537))
		if err != nil || len(body) > 65536 || request.Header.Get("Cookie") != "" || request.Header.Get("Authorization") != "" {
			writer.WriteHeader(403)
			return
		}
		action := strings.TrimPrefix(request.URL.Path, basePath)
		if action == "challenge" {
			var input struct {
				Purpose string                 `json:"purpose"`
				Token   string                 `json:"token"`
				Request *runner.RequestBinding `json:"request"`
			}
			if json.Unmarshal(body, &input) != nil {
				writer.WriteHeader(403)
				return
			}
			now := time.Now().UTC()
			challenge := generated.RunnerChallenge{SchemaVersion: 1, ChallengeId: daemon.NewRequestID(), ServerNonce: base64.RawURLEncoding.EncodeToString(make([]byte, 32)), WorkspaceId: enrollment.WorkspaceID, RunnerId: enrollment.RunnerID, Audience: runner.Audience, Origin: enrollment.Origin, PublicKeyThumbprint: enrollment.Thumbprint, Purpose: input.Purpose, AuthorizationEpoch: authorizationEpoch, OwnerAuthorizationEpoch: ownerEpoch, GrantEpoch: grantEpoch, TokenEpoch: epoch, IssuedAt: now.Format(time.RFC3339Nano), ExpiresAt: now.Add(time.Minute).Format(time.RFC3339Nano)}
			if input.Purpose == "request" {
				if input.Token != token || token == "" || input.Request == nil {
					writer.WriteHeader(403)
					return
				}
				challenge.TokenId = &tokenID
				challenge.Request = map[string]any{"method": input.Request.Method, "path": input.Request.Path, "body_sha256": input.Request.BodySHA256}
			}
			challenges[challenge.ChallengeId] = challenge
			_ = json.NewEncoder(writer).Encode(map[string]any{"challenge": challenge})
			return
		}
		proofBytes := body
		if action != "token" {
			proofBytes, err = base64.RawURLEncoding.DecodeString(request.Header.Get(runner.ProofHeader))
		}
		var proof struct {
			ChallengeID string `json:"challenge_id"`
			Nonce       string `json:"server_nonce"`
			Signature   string `json:"signature"`
			Token       string `json:"token"`
		}
		if err != nil || json.Unmarshal(proofBytes, &proof) != nil {
			writer.WriteHeader(403)
			return
		}
		challenge, found := challenges[proof.ChallengeID]
		signature, err := base64.RawURLEncoding.DecodeString(proof.Signature)
		var binding any
		if challenge.Request != nil {
			binding = []any{challenge.Request["method"], challenge.Request["path"], challenge.Request["body_sha256"]}
		}
		var transcript bytes.Buffer
		transcript.WriteString("BFB-RUNNER-POSSESSION-V1\n")
		encoder := json.NewEncoder(&transcript)
		encoder.SetEscapeHTML(false)
		_ = encoder.Encode([]any{challenge.ChallengeId, challenge.ServerNonce, challenge.WorkspaceId, challenge.RunnerId, challenge.Audience, challenge.Origin, challenge.PublicKeyThumbprint, challenge.Purpose, challenge.AuthorizationEpoch, challenge.OwnerAuthorizationEpoch, challenge.GrantEpoch, challenge.TokenEpoch, challenge.TokenId, binding, challenge.IssuedAt, challenge.ExpiresAt})
		digest := sha256.Sum256(transcript.Bytes())
		if !found || err != nil || len(signature) != 64 || proof.Nonce != challenge.ServerNonce || !ecdsa.Verify(&key.PublicKey, digest[:], new(big.Int).SetBytes(signature[:32]), new(big.Int).SetBytes(signature[32:])) {
			writer.WriteHeader(403)
			return
		}
		delete(challenges, proof.ChallengeID)
		if action == "token" {
			epoch++
			tokenID = daemon.NewRequestID()
			issued, _ := time.Parse(time.RFC3339Nano, challenge.IssuedAt)
			expires := issued.Add(5 * time.Minute)
			claims, _ := json.Marshal(map[string]any{"v": 1, "sub": enrollment.RunnerID, "workspace_id": enrollment.WorkspaceID, "aud": runner.Audience, "iss": enrollment.Origin, "jti": tokenID, "iat": issued.Unix(), "exp": expires.Unix(), "authorization_epoch": authorizationEpoch, "owner_authorization_epoch": ownerEpoch, "grant_epoch": grantEpoch, "token_epoch": epoch, "cnf": map[string]string{"jkt": enrollment.Thumbprint}})
			token = "bfb_runner_" + base64.RawURLEncoding.EncodeToString(claims) + "." + base64.RawURLEncoding.EncodeToString(make([]byte, 32))
			_ = json.NewEncoder(writer).Encode(map[string]any{"token": token, "token_type": "bfb-runner-pop", "expires_at": expires.Format(time.RFC3339Nano)})
			return
		}
		digest = sha256.Sum256(body)
		if proof.Token != token || challenge.Purpose != "request" || challenge.Request["method"] != request.Method || challenge.Request["path"] != request.URL.Path || challenge.Request["body_sha256"] != hex.EncodeToString(digest[:]) {
			writer.WriteHeader(403)
			return
		}
		if !bytes.Equal(body, mustArtifactJSON(t, cloud.original)) {
			writer.WriteHeader(403)
			_, _ = writer.Write([]byte(`{"error":"request_conflict"}`))
			return
		}
		data, err := cloud.Request(request.Context(), request.Method, action, body)
		if err != nil {
			writer.WriteHeader(503)
			return
		}
		_, _ = writer.Write(data)
	}))
	t.Cleanup(server.Close)
	enrollment.Origin = server.URL
	connection, err := runner.NewConnection(enrollment, &artifactTestCredentials{key: key, public: public}, server.Client(), func(context.Context, int64) error { return nil })
	if err != nil || connection.Renew(context.Background(), 0) != nil {
		t.Fatal("real possession connection did not authenticate", err)
	}
	return connection, func(field string) {
		mutex.Lock()
		defer mutex.Unlock()
		switch field {
		case "authorization":
			authorizationEpoch++
		case "owner":
			ownerEpoch++
		case "grant":
			grantEpoch++
		default:
			t.Fatal("unknown synthetic protected epoch")
		}
	}
}

func mustArtifactJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestArtifactPossessionConflictDoesNotCloseExactOriginalRecovery(t *testing.T) {
	cloud, content := artifactPhaseFixture(t)
	cloud.stage = "available"
	connection, _ := artifactTLSConnection(t, cloud)
	check, err := artifactConnectionCheck(connection, func() (runner.RunnerConnection, error) { return connection, nil })
	if err != nil {
		t.Fatal(err)
	}
	changed := cloud.original
	changed.Role = "log"
	if result, err := publishArtifactSnapshot(context.Background(), connection, changed, workTestID, content, func(context.Context) error { return check() }); daemon.AsFailure(err).Code != "request_conflict" || result.OperationKey != "" {
		t.Fatal("possessed conflict was converted to terminal revocation", err)
	}
	result, err := publishArtifactSnapshot(context.Background(), connection, cloud.original, workTestID, content, func(context.Context) error { return check() })
	if err != nil || result != cloud.result || len(cloud.actions) != 1 {
		t.Fatal("exact original recovery was closed by earlier conflict", err)
	}
}

func TestArtifactPossessionSuccessThenKnownConnectionFenceWithholdsPrivateResult(t *testing.T) {
	for _, stage := range []string{"available", "finalize_required"} {
		for _, fence := range []string{"revoked", "disconnected", "removed", "replaced", "renewed", "authorization", "owner", "grant"} {
			t.Run(stage+"/"+fence, func(t *testing.T) {
				cloud, content := artifactPhaseFixture(t)
				cloud.stage = stage
				connection, advanceEpoch := artifactTLSConnection(t, cloud)
				finalCheck, phases := 2, 1
				if stage == "finalize_required" {
					finalCheck, phases = 3, 2
				}
				var current runner.RunnerConnection = connection
				check, err := artifactConnectionCheck(connection, func() (runner.RunnerConnection, error) {
					if current == nil {
						return nil, runner.ErrOffline
					}
					return current, nil
				})
				if err != nil {
					t.Fatal(err)
				}
				checks := 0
				result, err := publishArtifactSnapshot(context.Background(), connection, cloud.original, workTestID, content, func(context.Context) error {
					checks++
					if checks == finalCheck {
						switch fence {
						case "revoked":
							if err := connection.Revoke(context.Background()); err != nil {
								t.Fatal(err)
							}
							connection.Disconnect()
							current = nil
						case "disconnected":
							connection.Disconnect()
						case "removed":
							current = nil
						case "replaced":
							current, _ = artifactTLSConnection(t, cloud)
						case "authorization", "owner", "grant":
							advanceEpoch(fence)
							if err := connection.Renew(context.Background(), 1); err != nil {
								t.Fatal(err)
							}
						case "renewed":
							if err := connection.Renew(context.Background(), 1); err != nil {
								t.Fatal(err)
							}
						}
					}
					return check()
				})
				if len(cloud.actions) != phases || checks != finalCheck {
					t.Fatal("fence did not follow successful canonical HTTP response", cloud.actions, checks)
				}
				if fence == "renewed" {
					if err != nil || result != cloud.result {
						t.Fatal("ordinary token rotation changed business authority", err)
					}
					return
				}
				want := "work_unavailable"
				if fence == "revoked" || fence == "authorization" || fence == "owner" || fence == "grant" {
					want = "revoked"
				}
				if daemon.AsFailure(err).Code != want || result.OperationKey != "" || cloud.result.State != "available" {
					t.Fatal("known local fence delivered private canonical result", fence, err)
				}
			})
		}
	}
}
