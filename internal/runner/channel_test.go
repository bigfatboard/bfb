// ABOUTME: Reproduces concurrent HTTPS denial and authenticated WebSocket authority fences over real TLS.
// ABOUTME: Checks cancellation, terminal persistence and rejection of stale or cross-workspace notices.

package runner

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/qdis/bfb/internal/auth"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
)

func TestChannelFenceDuringRequest(t *testing.T) {
	for _, scenario := range []string{"pending_http", "denied_http", "grant_change", "wrong_workspace", "stale_epoch", "bare_denial", "parent_cancel"} {
		t.Run(scenario, func(t *testing.T) {
			store, _ := runnerStore(t)
			input, credentials := testEnrollment(t)
			var fixture *possessionServer
			pullStarted := make(chan struct{})
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			endpoint := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				switch {
				case strings.HasSuffix(request.URL.Path, "/connect"):
					socket, err := websocket.Accept(writer, request, &websocket.AcceptOptions{Subprotocols: []string{"bfb.runner.v1"}})
					if err != nil {
						return
					}
					defer socket.CloseNow()
					now := time.Now().UTC()
					fixture.mu.Lock()
					claims := fixture.claims
					fixture.mu.Unlock()
					ready, _ := json.Marshal(map[string]any{"schema_version": 1, "kind": "runner.channel.ready", "workspace_id": fixture.enrollment.WorkspaceID, "runner_id": fixture.enrollment.RunnerID, "connection_id": daemon.NewRequestID(), "token_epoch": claims.TokenEpoch, "server_time": now.Format(time.RFC3339Nano), "auth_expires_at": time.Unix(claims.Expires, 0).UTC().Format(time.RFC3339Nano), "project_ids": []string{}})
					if socket.Write(ctx, websocket.MessageText, ready) != nil {
						return
					}
					select {
					case <-pullStarted:
					case <-ctx.Done():
						return
					}
					if scenario == "parent_cancel" {
						cancel()
						return
					}
					if scenario != "bare_denial" {
						if scenario == "denied_http" {
							time.Sleep(100 * time.Millisecond)
						}
						signal := generated.RunnerChannelClose{SchemaVersion: 1, Kind: "runner.channel.close", SignalId: daemon.NewRequestID(), WorkspaceId: fixture.enrollment.WorkspaceID, RunnerId: fixture.enrollment.RunnerID, AuthorizationEpoch: claims.AuthorizationEpoch + 1, GrantEpoch: claims.GrantEpoch + 1, TokenEpoch: claims.TokenEpoch + 1, Reason: "revoked", CreatedAt: now.Format(time.RFC3339Nano)}
						switch scenario {
						case "grant_change":
							signal.Reason = "grants_changed"
						case "wrong_workspace":
							signal.WorkspaceId = daemon.NewRequestID()
						case "stale_epoch":
							signal.AuthorizationEpoch, signal.GrantEpoch, signal.TokenEpoch = claims.AuthorizationEpoch, claims.GrantEpoch, claims.TokenEpoch
						}
						data, _ := json.Marshal(signal)
						_ = socket.Write(ctx, websocket.MessageText, data)
					}
					_, _, _ = socket.Read(ctx)
				case strings.HasSuffix(request.URL.Path, "/commands/pull"):
					_, _ = io.Copy(io.Discard, request.Body)
					close(pullStarted)
					if scenario == "pending_http" || scenario == "parent_cancel" {
						select {
						case <-request.Context().Done():
						case <-ctx.Done():
						}
					}
					writer.WriteHeader(http.StatusForbidden)
				default:
					fixture.handler(writer, request)
				}
			}))
			defer endpoint.Close()
			enrollment, err := store.Begin(ctx, endpoint.URL, input.WorkspaceID, input.Label)
			if err != nil {
				t.Fatal(err)
			}
			enrollment, err = store.CompleteKey(ctx, enrollment, credentials)
			if err != nil {
				t.Fatal(err)
			}
			fixture = &possessionServer{enrollment: enrollment, key: &credentials.key.PublicKey, challenges: map[string]generated.RunnerChallenge{}}
			connection, err := NewConnection(enrollment, credentials, endpoint.Client(), func(ctx context.Context, epoch int64) error { return store.SaveEpoch(ctx, enrollment.RunnerID, epoch) })
			if err != nil {
				t.Fatal(err)
			}
			defer connection.Disconnect()
			if err = connection.Renew(ctx, 0); err != nil {
				t.Fatal(err)
			}
			manager := &Manager{store: store, heartbeat: 20 * time.Second}
			started := time.Now()
			err = manager.serveChannel(ctx, enrollment, connection)
			if time.Since(started) > 2*time.Second {
				t.Fatal("channel failed to cancel/join promptly", err)
			}
			current, readErr := store.Get(context.Background(), enrollment.RunnerID)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if scenario == "pending_http" || scenario == "denied_http" {
				if !errors.Is(err, ErrRevoked) || current.State != "revoked" {
					t.Fatal("lost authenticated terminal fence", err, current.State)
				}
				secret, _ := credentials.Read(context.Background(), connection.keyRef(auth.RunnerToken))
				if len(secret) != 0 {
					t.Fatal("revoked credential survived cleanup")
				}
			} else {
				if current.State == "revoked" {
					t.Fatal("inferred revocation from non-terminal or untrusted input")
				}
				if scenario == "grant_change" && !errors.Is(err, errRotate) {
					t.Fatal("grant fence did not rotate", err)
				}
			}
		})
	}
}
