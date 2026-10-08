// ABOUTME: Reproduces inventory refresh cadence through a real TLS runner channel.
// ABOUTME: Delays initial synchronization to prove heartbeat scheduling cannot skip a provider freshness window.

package runner

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
)

func TestChannelInventoryRefreshDoesNotSkipDelayedInitialSync(t *testing.T) {
	for _, acknowledge := range []bool{true, false} {
		name := "without_alive_reply"
		if acknowledge {
			name = "first_alive_before_sync_interval"
		}
		t.Run(name, func(t *testing.T) { testChannelInventoryRefresh(t, acknowledge) })
	}
}

func testChannelInventoryRefresh(t *testing.T, acknowledge bool) {
	t.Helper()
	// Scale only the existing private test seam, preserving the production
	// ratio: heartbeat 20 s, provider observation validity 30 s.
	const heartbeat = 300 * time.Millisecond
	const freshness = 450 * time.Millisecond
	store, _ := runnerStore(t)
	input, credentials := testEnrollment(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var fixture *possessionServer
	var revision atomic.Int64
	observations := make(chan time.Time, 8)
	alive := make(chan time.Time, 8)
	endpoint := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if strings.HasSuffix(request.URL.Path, "/connect") {
			socket, err := websocket.Accept(writer, request, &websocket.AcceptOptions{Subprotocols: []string{"bfb.runner.v1"}})
			if err != nil {
				return
			}
			defer socket.CloseNow()
			fixture.mu.Lock()
			claims := fixture.claims
			fixture.mu.Unlock()
			connectionID := daemon.NewRequestID()
			message := func(kind string) []byte {
				now := time.Now().UTC().Format(time.RFC3339Nano)
				expiry := time.Unix(claims.Expires, 0).UTC().Format(time.RFC3339Nano)
				data, _ := json.Marshal(map[string]any{"schema_version": 1, "kind": kind, "workspace_id": fixture.enrollment.WorkspaceID, "runner_id": fixture.enrollment.RunnerID, "connection_id": connectionID, "token_epoch": claims.TokenEpoch, "server_time": now, "auth_expires_at": expiry, "project_ids": []string{}})
				return data
			}
			if socket.Write(ctx, websocket.MessageText, message("runner.channel.ready")) != nil {
				return
			}
			for {
				_, _, err := socket.Read(ctx)
				if err != nil {
					return
				}
				alive <- time.Now()
				if acknowledge && socket.Write(ctx, websocket.MessageText, message("runner.channel.alive")) != nil {
					return
				}
			}
		}
		if strings.HasSuffix(request.URL.Path, "/commands/pull") || strings.HasSuffix(request.URL.Path, "/inventory") {
			// Authenticate the actual signed request before returning the fixture's
			// fixed business response; inventory is not a connectivity observation.
			authorized := httptest.NewRecorder()
			fixture.handler(authorized, request)
			if authorized.Code != http.StatusOK {
				writer.WriteHeader(authorized.Code)
				_, _ = io.Copy(writer, authorized.Body)
				return
			}
			if strings.HasSuffix(request.URL.Path, "/commands/pull") {
				_ = json.NewEncoder(writer).Encode(map[string]any{"schema_version": 1, "workspace_id": fixture.enrollment.WorkspaceID, "runner_id": fixture.enrollment.RunnerID, "commands": []any{}, "more": false})
			} else {
				_ = json.NewEncoder(writer).Encode(map[string]bool{"ok": true})
			}
			return
		}
		fixture.handler(writer, request)
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
	if err := connection.Renew(ctx, 0); err != nil {
		t.Fatal(err)
	}
	manager := &Manager{store: store, heartbeat: heartbeat, inventory: func(ctx context.Context, enrollment Enrollment, _ []string, _ time.Duration) ([]byte, error) {
		now := time.Now()
		current := revision.Add(1)
		observations <- now
		if current == 1 {
			timer := time.NewTimer(heartbeat / 2)
			defer timer.Stop()
			select {
			case <-timer.C:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		return json.Marshal(generated.RunnerInventory{SchemaVersion: 1, WorkspaceId: enrollment.WorkspaceID, RunnerId: enrollment.RunnerID, Revision: current, Checkouts: []generated.CheckoutSummary{}, Providers: []map[string]any{}})
	}}
	done := make(chan error, 1)
	go func() { done <- manager.serveChannel(ctx, enrollment, connection) }()
	defer func() {
		cancel()
		// Cancellation may interrupt the HTTPS publication already in flight
		// after the observation, which the transport conservatively calls offline.
		if err := <-done; !errors.Is(err, context.Canceled) && !errors.Is(err, ErrOffline) {
			t.Errorf("channel did not join on cancellation: %v", err)
		}
	}()
	var first time.Time
	select {
	case first = <-observations:
	case <-ctx.Done():
		t.Fatal("initial inventory never ran")
	}
	select {
	case <-alive:
	case <-ctx.Done():
		t.Fatal("first heartbeat was not acknowledged")
	}
	remaining := time.Until(first.Add(freshness))
	if remaining <= 0 {
		t.Fatal("fixture could not reach the first heartbeat inside the freshness window")
	}
	timer := time.NewTimer(remaining)
	defer timer.Stop()
	select {
	case second := <-observations:
		if second.Sub(first) >= freshness {
			t.Fatal("provider observation expired before periodic refresh", second.Sub(first))
		}
	case <-timer.C:
		t.Fatalf("inventory skipped the first heartbeat after a delayed initial sync: no refresh within %s (20 s heartbeat / 30 s freshness ratio)", freshness)
	case <-ctx.Done():
		t.Fatal("channel ended before inventory refresh")
	}
}
