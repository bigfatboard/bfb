// ABOUTME: Exercises possession transport over real TLS with isolated synthetic signing keys.
// ABOUTME: Covers concurrent rotation, response loss, clock skew, redirects and actual request-body binding.

package runner

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
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
)

type memoryCredentials struct {
	mu      sync.Mutex
	key     *ecdsa.PrivateKey
	public  []byte
	secrets map[string][]byte
	writes  int
	signs   int
}

func (store *memoryCredentials) CreateKey(context.Context, auth.CredentialRef) ([]byte, error) {
	return store.public, nil
}
func (store *memoryCredentials) PublicKey(context.Context, auth.CredentialRef) ([]byte, error) {
	return store.public, nil
}
func (store *memoryCredentials) Sign(_ context.Context, _ auth.CredentialRef, data []byte) ([]byte, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.signs++
	digest := sha256.Sum256(data)
	r, s, err := ecdsa.Sign(rand.Reader, store.key, digest[:])
	if err != nil {
		return nil, err
	}
	result := make([]byte, 64)
	r.FillBytes(result[:32])
	s.FillBytes(result[32:])
	return result, nil
}
func (store *memoryCredentials) Read(_ context.Context, ref auth.CredentialRef) ([]byte, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	account, _ := ref.Account()
	return append([]byte(nil), store.secrets[account]...), nil
}
func (store *memoryCredentials) Write(_ context.Context, ref auth.CredentialRef, value []byte) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	account, _ := ref.Account()
	store.secrets[account] = append([]byte(nil), value...)
	store.writes++
	return nil
}
func (store *memoryCredentials) Delete(_ context.Context, ref auth.CredentialRef) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	account, _ := ref.Account()
	delete(store.secrets, account)
	return nil
}

func testEnrollment(t *testing.T) (Enrollment, *memoryCredentials) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	public, _ := json.Marshal(map[string]string{"crv": "P-256", "kty": "EC", "x": base64.RawURLEncoding.EncodeToString(key.X.FillBytes(make([]byte, 32))), "y": base64.RawURLEncoding.EncodeToString(key.Y.FillBytes(make([]byte, 32)))})
	digest := sha256.Sum256(public)
	enrollment := Enrollment{RunnerID: daemon.NewRequestID(), WorkspaceID: daemon.NewRequestID(), Origin: "https://bfb.synthetic.test", Label: "Synthetic Mac", PublicKey: public, Thumbprint: "sha256:" + hex.EncodeToString(digest[:]), State: "pending_approval"}
	return enrollment, &memoryCredentials{key: key, public: public, secrets: map[string][]byte{}}
}

func testChallenge(enrollment Enrollment, now time.Time, epoch int64) generated.RunnerChallenge {
	return generated.RunnerChallenge{SchemaVersion: 1, ChallengeId: daemon.NewRequestID(), ServerNonce: base64.RawURLEncoding.EncodeToString(make([]byte, 32)), WorkspaceId: enrollment.WorkspaceID, RunnerId: enrollment.RunnerID, Audience: Audience, Origin: enrollment.Origin, PublicKeyThumbprint: enrollment.Thumbprint, Purpose: "token", AuthorizationEpoch: 1, OwnerAuthorizationEpoch: 2, GrantEpoch: 3, TokenEpoch: epoch, IssuedAt: now.UTC().Format(time.RFC3339Nano), ExpiresAt: now.Add(time.Minute).UTC().Format(time.RFC3339Nano)}
}

func testClaims(enrollment Enrollment, challenge generated.RunnerChallenge) tokenClaims {
	issued, _ := time.Parse(time.RFC3339Nano, challenge.IssuedAt)
	claims := tokenClaims{Version: 1, Subject: enrollment.RunnerID, WorkspaceID: enrollment.WorkspaceID, Audience: Audience, Issuer: enrollment.Origin, TokenID: daemon.NewRequestID(), Issued: issued.Unix(), Expires: issued.Add(5 * time.Minute).Unix(), AuthorizationEpoch: challenge.AuthorizationEpoch, OwnerAuthorizationEpoch: challenge.OwnerAuthorizationEpoch, GrantEpoch: challenge.GrantEpoch, TokenEpoch: challenge.TokenEpoch + 1}
	claims.Confirmation.Thumbprint = enrollment.Thumbprint
	return claims
}

type possessionServer struct {
	mu             sync.Mutex
	enrollment     Enrollment
	key            *ecdsa.PublicKey
	challenges     map[string]generated.RunnerChallenge
	epoch          int64
	claims         tokenClaims
	token          string
	shift          time.Duration
	loseResponse   bool
	alterChallenge bool
	proofs         []string
	requests       int
	redirect       string
}

func (server *possessionServer) handler(writer http.ResponseWriter, request *http.Request) {
	server.mu.Lock()
	defer server.mu.Unlock()
	if request.Header.Get("Cookie") != "" || request.Header.Get("Origin") != "" || request.Header.Get("Authorization") != "" {
		writer.WriteHeader(403)
		return
	}
	body, _ := io.ReadAll(io.LimitReader(request.Body, 65537))
	action := strings.TrimPrefix(request.URL.Path, server.enrollment.basePath()+"/")
	if action == "challenge" {
		var input struct {
			Purpose string          `json:"purpose"`
			Token   string          `json:"token"`
			Request *RequestBinding `json:"request"`
		}
		if strictJSON(body, &input) != nil {
			writer.WriteHeader(403)
			return
		}
		challenge := testChallenge(server.enrollment, time.Now().Add(server.shift), server.epoch)
		if input.Purpose == "request" {
			if input.Token != server.token || server.token == "" || input.Request == nil {
				writer.WriteHeader(403)
				return
			}
			challenge.Purpose = "request"
			challenge.TokenId = &server.claims.TokenID
			challenge.Request = map[string]any{"method": input.Request.Method, "path": input.Request.Path, "body_sha256": input.Request.BodySHA256}
		}
		server.challenges[challenge.ChallengeId] = challenge
		if server.alterChallenge {
			challenge.Origin = "https://other.synthetic.test"
		}
		_ = json.NewEncoder(writer).Encode(map[string]any{"challenge": challenge})
		return
	}
	var proof possessionProof
	if action == "token" {
		if strictJSON(body, &proof) != nil {
			writer.WriteHeader(403)
			return
		}
	} else {
		decoded, err := base64.RawURLEncoding.DecodeString(request.Header.Get(ProofHeader))
		if err != nil || strictJSON(decoded, &proof) != nil {
			writer.WriteHeader(403)
			return
		}
	}
	challenge, ok := server.challenges[proof.ChallengeID]
	signature, err := base64.RawURLEncoding.DecodeString(proof.Signature)
	digest := sha256.Sum256(challengeTranscript(challenge))
	if !ok || err != nil || proof.Nonce != challenge.ServerNonce || len(signature) != 64 || !ecdsa.Verify(server.key, digest[:], new(big.Int).SetBytes(signature[:32]), new(big.Int).SetBytes(signature[32:])) || challenge.TokenEpoch != server.epoch {
		writer.WriteHeader(403)
		return
	}
	delete(server.challenges, proof.ChallengeID)
	server.proofs = append(server.proofs, proof.ChallengeID)
	if action == "token" {
		if challenge.Purpose != "token" || proof.Token != "" {
			writer.WriteHeader(403)
			return
		}
		server.claims = testClaims(server.enrollment, challenge)
		server.epoch = server.claims.TokenEpoch
		claims, _ := json.Marshal(server.claims)
		server.token = "bfb_runner_" + base64.RawURLEncoding.EncodeToString(claims) + "." + base64.RawURLEncoding.EncodeToString(make([]byte, 32))
		if server.loseResponse {
			server.loseResponse = false
			writer.WriteHeader(503)
			return
		}
		_ = json.NewEncoder(writer).Encode(map[string]any{"token": server.token, "token_type": "bfb-runner-pop", "expires_at": time.Unix(server.claims.Expires, 0).UTC().Format(time.RFC3339Nano)})
		return
	}
	actual := binding(request.Method, request.URL.Path, body)
	if proof.Token != server.token || challenge.Purpose != "request" || challenge.Request["method"] != actual.Method || challenge.Request["path"] != actual.Path || challenge.Request["body_sha256"] != actual.BodySHA256 {
		writer.WriteHeader(403)
		return
	}
	server.requests++
	if server.redirect != "" {
		http.Redirect(writer, request, server.redirect, 302)
		return
	}
	_ = json.NewEncoder(writer).Encode(map[string]bool{"ok": true})
}

func testConnection(t *testing.T, shift time.Duration) (*Connection, *memoryCredentials, *possessionServer) {
	t.Helper()
	enrollment, credentials := testEnrollment(t)
	server := &possessionServer{enrollment: enrollment, key: &credentials.key.PublicKey, challenges: map[string]generated.RunnerChallenge{}, shift: shift}
	endpoint := httptest.NewTLSServer(http.HandlerFunc(server.handler))
	t.Cleanup(endpoint.Close)
	enrollment.Origin = endpoint.URL
	server.enrollment = enrollment
	connection, err := NewConnection(enrollment, credentials, endpoint.Client(), func(context.Context, int64) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	return connection, credentials, server
}

func TestTLSRotationSerializesAndBindsActualRequest(t *testing.T) {
	connection, credentials, server := testConnection(t, 12*time.Hour)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var workers sync.WaitGroup
	for range 12 {
		workers.Go(func() {
			if err := connection.Renew(ctx, 0); err != nil {
				t.Error(err)
			}
		})
	}
	workers.Wait()
	if credentials.writes != 1 || server.epoch != 1 {
		t.Fatalf("rotation did not have one local winner: %d/%d", credentials.writes, server.epoch)
	}
	epoch, due := connection.Credential()
	if epoch != 1 || time.Until(due) < 4*time.Minute || time.Until(due) > 5*time.Minute {
		t.Fatal("server clock skew corrupted credential lifetime")
	}
	if data, err := connection.Request(ctx, "POST", "echo", []byte(`{"synthetic":true}`)); err != nil || string(data) != "{\"ok\":true}\n" {
		t.Fatalf("bound request failed: %v", err)
	}
	if server.requests != 1 {
		t.Fatal("missing authenticated request")
	}
	if _, err := connection.Request(ctx, "POST", "../outside", nil); err != ErrProtocol {
		t.Fatal("unsafe action accepted")
	}
}

func TestAmbiguousRenewalUsesNewChallenge(t *testing.T) {
	connection, credentials, server := testConnection(t, -12*time.Hour)
	ctx := context.Background()
	server.loseResponse = true
	if err := connection.Renew(ctx, 0); err != ErrOffline {
		t.Fatalf("lost response: %v", err)
	}
	if epoch, _ := connection.Credential(); epoch != 0 || credentials.writes != 0 {
		t.Fatal("ambiguous token became active")
	}
	if err := connection.Renew(ctx, 0); err != nil {
		t.Fatal(err)
	}
	if len(server.proofs) != 2 || server.proofs[0] == server.proofs[1] || server.epoch != 2 || credentials.writes != 1 {
		t.Fatal("ambiguous exchange replayed instead of rotating")
	}
	if err := connection.Revoke(ctx); err != nil {
		t.Fatal(err)
	}
	if err := connection.Renew(ctx, 0); err != ErrRevoked {
		t.Fatal("revoked connection renewed")
	}
	if _, err := connection.Request(ctx, "GET", "echo", nil); err != ErrRevoked {
		t.Fatal("revoked connection sent request")
	}
}

func TestUntrustedChallengeNeverSignsOrStores(t *testing.T) {
	connection, credentials, server := testConnection(t, 0)
	server.alterChallenge = true
	if err := connection.Renew(context.Background(), 0); err != ErrProtocol {
		t.Fatal(err)
	}
	if credentials.signs != 0 || credentials.writes != 0 {
		t.Fatal("unbound challenge reached signer")
	}
}

func TestPersistenceFailureAndRedirectFailClosed(t *testing.T) {
	connection, credentials, server := testConnection(t, 0)
	connection.persistEpoch = func(context.Context, int64) error { return errors.New("synthetic write failure") }
	if err := connection.Renew(context.Background(), 0); err == nil {
		t.Fatal("lost epoch persistence accepted")
	}
	if epoch, _ := connection.Credential(); epoch != 0 {
		t.Fatal("uncommitted credential active")
	}
	connection.persistEpoch = func(context.Context, int64) error { return nil }
	if err := connection.Renew(context.Background(), 0); err != nil {
		t.Fatal(err)
	}
	if credentials.writes != 2 || server.epoch != 2 {
		t.Fatal("failed persistence did not force fresh rotation")
	}
	var destinationCalls int
	destination := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { destinationCalls++ }))
	defer destination.Close()
	server.redirect = destination.URL
	if _, err := connection.Request(context.Background(), "GET", "echo", nil); err != ErrProtocol {
		t.Fatal("redirect accepted")
	}
	if destinationCalls != 0 {
		t.Fatal("credential crossed a redirect")
	}
}
