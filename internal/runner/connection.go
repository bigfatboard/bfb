// ABOUTME: Owns one enrollment's fresh-challenge token rotation and authenticated HTTPS/WSS requests.
// ABOUTME: Serializes credential generations and never exports tokens, follows redirects or accepts browser credentials.

package runner

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/qdis/bfb/internal/auth"
	"github.com/qdis/bfb/internal/protocol/generated"
)

type Credentials interface {
	auth.CredentialStore
	auth.RunnerSigner
	CreateKey(context.Context, auth.CredentialRef) ([]byte, error)
}

// RunnerConnection is the only authenticated runner transport boundary. Business
// handlers own command authorization, durable acceptance and event dispositions.
type RunnerConnection interface {
	Renew(context.Context, int64) error
	Request(context.Context, string, string, []byte) ([]byte, error)
	Open(context.Context) (*websocket.Conn, error)
	Credential() (int64, time.Time)
}

type Connection struct {
	mu           sync.Mutex
	enrollment   Enrollment
	credentials  Credentials
	client       *http.Client
	token        []byte
	claims       tokenClaims
	due          time.Time
	closed       bool
	persistEpoch func(context.Context, int64) error
}

func NewConnection(enrollment Enrollment, credentials Credentials, client *http.Client, persistEpoch func(context.Context, int64) error) (*Connection, error) {
	if enrollment.validate() != nil || credentials == nil || persistEpoch == nil {
		return nil, ErrProtocol
	}
	if client == nil {
		client = &http.Client{}
	}
	isolated := *client
	isolated.Jar = nil
	isolated.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	isolated.Timeout = 15 * time.Second
	return &Connection{enrollment: enrollment, credentials: credentials, client: &isolated, persistEpoch: persistEpoch}, nil
}

func (connection *Connection) Credential() (int64, time.Time) {
	connection.mu.Lock()
	defer connection.mu.Unlock()
	return connection.claims.TokenEpoch, connection.due
}

func (connection *Connection) keyRef(kind auth.CredentialKind) auth.CredentialRef {
	return auth.CredentialRef{Kind: kind, WorkspaceID: connection.enrollment.WorkspaceID, ID: connection.enrollment.RunnerID}
}

func (connection *Connection) clearToken() {
	clear(connection.token)
	connection.token = nil
	connection.claims = tokenClaims{}
	connection.due = time.Time{}
}

func (connection *Connection) Renew(ctx context.Context, expectedEpoch int64) error {
	connection.mu.Lock()
	defer connection.mu.Unlock()
	if connection.closed {
		return ErrOffline
	}
	if connection.enrollment.State == "revoked" {
		return ErrRevoked
	}
	if len(connection.token) != 0 && connection.claims.TokenEpoch > expectedEpoch && time.Now().Before(connection.due) {
		return nil
	}
	connection.clearToken()
	started := time.Now()
	challenge, err := connection.challenge(ctx, nil)
	if err != nil {
		return err
	}
	proof, err := connection.proof(ctx, challenge)
	if err != nil {
		return err
	}
	encoded, _ := json.Marshal(proof)
	data, err := connection.send(ctx, "POST", connection.enrollment.basePath()+"/token", encoded, nil)
	if err != nil {
		return err
	}
	var response struct {
		Token     string `json:"token"`
		Kind      string `json:"token_type"`
		ExpiresAt string `json:"expires_at"`
	}
	if strictJSON(data, &response) != nil || response.Kind != "bfb-runner-pop" {
		return ErrProtocol
	}
	claims, err := validateToken(response.Token, response.ExpiresAt, connection.enrollment, challenge)
	if err != nil {
		return err
	}
	issued, _ := time.Parse(time.RFC3339Nano, challenge.IssuedAt)
	expires, _ := time.Parse(time.RFC3339Nano, response.ExpiresAt)
	due := started.Add(expires.Sub(issued))
	if !time.Now().Before(due) {
		return ErrProtocol
	}
	secret := []byte(response.Token)
	defer clear(secret)
	// Keychain and SQLite cannot commit together. Any ambiguous persistence fails
	// closed and the next attempt rotates with a new challenge, never an old proof.
	if err = connection.credentials.Write(ctx, connection.keyRef(auth.RunnerToken), secret); err != nil {
		return err
	}
	if err = connection.persistEpoch(ctx, claims.TokenEpoch); err != nil {
		return err
	}
	connection.token = append([]byte(nil), secret...)
	connection.claims, connection.due = claims, due
	connection.enrollment.TokenEpoch = claims.TokenEpoch
	return nil
}

func (connection *Connection) challenge(ctx context.Context, request *RequestBinding) (generated.RunnerChallenge, error) {
	input := map[string]any{"purpose": "token"}
	if request != nil {
		if len(connection.token) == 0 || !time.Now().Before(connection.due) {
			return generated.RunnerChallenge{}, ErrAuthorization
		}
		input = map[string]any{"purpose": "request", "request": request, "token": string(connection.token)}
	}
	encoded, _ := json.Marshal(input)
	data, err := connection.send(ctx, "POST", connection.enrollment.basePath()+"/challenge", encoded, nil)
	if err != nil {
		return generated.RunnerChallenge{}, err
	}
	var response struct {
		Challenge json.RawMessage `json:"challenge"`
	}
	if strictJSON(data, &response) != nil {
		return generated.RunnerChallenge{}, ErrProtocol
	}
	return validateChallenge(response.Challenge, connection.enrollment, request, &connection.claims)
}

type possessionProof struct {
	ChallengeID string `json:"challenge_id"`
	Nonce       string `json:"server_nonce"`
	Signature   string `json:"signature"`
	Token       string `json:"token,omitempty"`
}

func (connection *Connection) proof(ctx context.Context, challenge generated.RunnerChallenge) (possessionProof, error) {
	signature, err := connection.credentials.Sign(ctx, connection.keyRef(auth.RunnerKey), challengeTranscript(challenge))
	if err != nil {
		return possessionProof{}, err
	}
	if len(signature) != 64 {
		return possessionProof{}, ErrProtocol
	}
	return possessionProof{ChallengeID: challenge.ChallengeId, Nonce: challenge.ServerNonce, Signature: base64.RawURLEncoding.EncodeToString(signature)}, nil
}

var actionPattern = regexp.MustCompile(`^[a-z][a-z0-9/_-]{0,127}$`)

func (connection *Connection) authorization(ctx context.Context, method, path string, body []byte) (http.Header, error) {
	request := binding(method, path, body)
	challenge, err := connection.challenge(ctx, &request)
	if err != nil {
		return nil, err
	}
	proof, err := connection.proof(ctx, challenge)
	if err != nil {
		return nil, err
	}
	proof.Token = string(connection.token)
	data, _ := json.Marshal(proof)
	return http.Header{ProofHeader: []string{base64.RawURLEncoding.EncodeToString(data)}}, nil
}

func (connection *Connection) Request(ctx context.Context, method, action string, body []byte) ([]byte, error) {
	if !actionPattern.MatchString(action) || len(body) > maxResponseBytes || (method != "GET" && method != "POST") || (method == "GET" && len(body) != 0) {
		return nil, ErrProtocol
	}
	connection.mu.Lock()
	defer connection.mu.Unlock()
	if connection.closed {
		return nil, ErrOffline
	}
	if connection.enrollment.State == "revoked" {
		return nil, ErrRevoked
	}
	path := connection.enrollment.basePath() + "/" + action
	headers, err := connection.authorization(ctx, method, path, body)
	if err != nil {
		return nil, err
	}
	return connection.send(ctx, method, path, body, headers)
}

func (connection *Connection) Open(ctx context.Context) (*websocket.Conn, error) {
	connection.mu.Lock()
	defer connection.mu.Unlock()
	if connection.closed {
		return nil, ErrOffline
	}
	if connection.enrollment.State == "revoked" {
		return nil, ErrRevoked
	}
	path := connection.enrollment.basePath() + "/connect"
	headers, err := connection.authorization(ctx, "GET", path, nil)
	if err != nil {
		return nil, err
	}
	socket, response, err := websocket.Dial(ctx, connection.enrollment.Origin+path, &websocket.DialOptions{HTTPClient: connection.client, HTTPHeader: headers, Subprotocols: []string{"bfb.runner.v1"}})
	if err != nil {
		if response != nil && response.StatusCode == http.StatusForbidden {
			return nil, ErrAuthorization
		}
		return nil, ErrOffline
	}
	if socket.Subprotocol() != "bfb.runner.v1" {
		_ = socket.CloseNow()
		return nil, ErrProtocol
	}
	socket.SetReadLimit(8192)
	return socket, nil
}

func (connection *Connection) send(ctx context.Context, method, path string, body []byte, headers http.Header) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, method, connection.enrollment.Origin+path, bytes.NewReader(body))
	if err != nil {
		return nil, ErrProtocol
	}
	if headers != nil {
		request.Header = headers
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	response, err := connection.client.Do(request)
	if err != nil {
		return nil, ErrOffline
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusForbidden {
		return nil, ErrAuthorization
	}
	if response.StatusCode >= 500 {
		return nil, ErrOffline
	}
	if response.StatusCode != http.StatusOK {
		return nil, ErrProtocol
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return nil, ErrOffline
	}
	if len(data) > maxResponseBytes {
		return nil, ErrProtocol
	}
	return data, nil
}

// Revoke is called only after persisting a verified terminal revocation signal.
func (connection *Connection) Revoke(ctx context.Context) error {
	connection.mu.Lock()
	defer connection.mu.Unlock()
	connection.enrollment.State = "revoked"
	connection.clearToken()
	return connection.credentials.Delete(ctx, connection.keyRef(auth.RunnerToken))
}

func (connection *Connection) Disconnect() {
	connection.mu.Lock()
	defer connection.mu.Unlock()
	connection.closed = true
	connection.clearToken()
}

func (connection *Connection) snapshotClaims() tokenClaims {
	connection.mu.Lock()
	defer connection.mu.Unlock()
	return connection.claims
}

func (claims tokenClaims) advancesFence(signal generated.RunnerChannelClose) bool {
	return signal.AuthorizationEpoch >= claims.AuthorizationEpoch && signal.GrantEpoch >= claims.GrantEpoch && signal.TokenEpoch >= claims.TokenEpoch && (signal.AuthorizationEpoch > claims.AuthorizationEpoch || signal.GrantEpoch > claims.GrantEpoch || signal.TokenEpoch > claims.TokenEpoch)
}
