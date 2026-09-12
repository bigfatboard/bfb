// ABOUTME: Exercises app-delivery correlation, bounded failure states and wake/Terminal separation.
// ABOUTME: Uses real private daemon RPC for negative inputs while keeping native UI effects synthetic.

package appbridge

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
)

const terminalID = "e0da52a9-d0cb-47d8-867b-e08f684b9001"

func syntheticBridge(t *testing.T, options Options) *Bridge {
	t.Helper()
	if options.WakeApp == nil {
		options.WakeApp = func(context.Context) error { return nil }
	}
	if options.AuthorizePeer == nil {
		options.AuthorizePeer = func(daemon.Peer) error { return nil }
	}
	b := New(options)
	close, err := b.Start(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(close)
	return b
}

func failureCode(err error) string {
	if err == nil {
		return ""
	}
	return daemon.AsFailure(err).Code
}

func TestDeliveryAcknowledgementsAndTypedOutcomes(t *testing.T) {
	for _, result := range []string{"terminal_opened", "consent_denied", "session_locked", "app_unavailable", "app_delivery_unknown", "expired_intent", "revoked"} {
		t.Run(result, func(t *testing.T) {
			b := syntheticBridge(t, Options{})
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- b.OpenTerminal(ctx, terminalID) }()
			peer := daemon.Peer{UID: os.Getuid(), PID: os.Getpid()}
			payload, err := b.poll(ctx, peer, "available")
			if err != nil || payload["terminal_intent_id"] != terminalID || payload["app_action"] != "open_terminal" || len(payload) != 3 {
				t.Fatalf("unexpected bounded delivery: %#v, %v", payload, err)
			}
			id := payload["app_delivery_id"].(string)
			wrongPeer := peer
			wrongPeer.PID++
			if failureCode(b.complete(wrongPeer, id, result)) != "expired_intent" {
				t.Fatal("another app process acknowledged an offered delivery")
			}
			if failureCode(b.complete(peer, id, "notification_delivered")) != "invalid_request" {
				t.Fatal("notification acknowledgement completed Terminal delivery")
			}
			if err = b.complete(peer, id, result); err != nil {
				t.Fatal(err)
			}
			if err = b.complete(peer, id, result); err != nil {
				t.Fatal("lost-reply acknowledgement was not idempotent", err)
			}
			if failureCode(b.complete(wrongPeer, id, result)) != "invalid_request" {
				t.Fatal("completed receipt lost process binding")
			}
			if code := failureCode(<-done); code != failureCode(outcome(result)) {
				t.Fatalf("result %s mapped to %s", result, code)
			}
		})
	}
}

func TestNotificationCarriesOnlyOpaqueReference(t *testing.T) {
	b := syntheticBridge(t, Options{})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	id := daemon.NewRequestID()
	done := make(chan error, 1)
	go func() { done <- b.NotifyAttention(ctx, id) }()
	peer := daemon.Peer{UID: os.Getuid(), PID: os.Getpid()}
	payload, err := b.poll(ctx, peer, "available")
	if err != nil || len(payload) != 3 || payload["notification_id"] != id || payload["app_action"] != "notify_attention" {
		t.Fatalf("unexpected notification: %#v %v", payload, err)
	}
	if err := b.complete(peer, payload["app_delivery_id"].(string), "notification_denied"); err != nil {
		t.Fatal(err)
	}
	if failureCode(<-done) != "notification_denied" {
		t.Fatal("notification consent failure was hidden")
	}
}

func TestUnavailableAndAmbiguousDeliveryNeverBlindlyRetry(t *testing.T) {
	for _, state := range []string{"locked", "login_window", "absent", "lost_after_offer"} {
		t.Run(state, func(t *testing.T) {
			b := syntheticBridge(t, Options{})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- b.OpenTerminal(ctx, terminalID) }()
			peer := daemon.Peer{UID: os.Getuid(), PID: os.Getpid()}
			var payload map[string]any
			if state == "lost_after_offer" {
				payload, _ = b.poll(ctx, peer, "available")
			}
			if state == "locked" || state == "login_window" {
				pollCtx, stop := context.WithTimeout(ctx, 50*time.Millisecond)
				defer stop()
				_, _ = b.poll(pollCtx, peer, state)
			}
			cancel()
			want := "app_unavailable"
			if state == "locked" {
				want = "session_locked"
			}
			if state == "lost_after_offer" {
				want = "app_delivery_unknown"
			}
			if code := failureCode(<-done); code != want {
				t.Fatalf("%s: %s != %s", state, code, want)
			}
			if state == "lost_after_offer" && failureCode(b.complete(peer, payload["app_delivery_id"].(string), "terminal_opened")) != "expired_intent" {
				t.Fatal("expired delivery accepted late receipt")
			}
			b.mu.Lock()
			pending := len(b.pending)
			b.mu.Unlock()
			if pending != 0 {
				t.Fatal("abandoned delivery retained for blind replay")
			}
		})
	}
}

func TestWakeAndTerminalHaveDisjointInputs(t *testing.T) {
	var mu sync.Mutex
	var wakes []string
	b := New(Options{
		WakeApp:       func(context.Context) error { t.Error("cloud wake caused native Terminal/app launch"); return nil },
		AuthorizePeer: func(daemon.Peer) error { return nil },
		WakeIntent: func(_ context.Context, id string) error {
			mu.Lock()
			defer mu.Unlock()
			wakes = append(wakes, id)
			return nil
		},
	})
	directory, err := os.MkdirTemp("", "bfb-app-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	paths, err := daemon.StatePaths(directory)
	if err != nil {
		t.Fatal(err)
	}
	registry := daemon.NewRegistry()
	if err = RegisterRPC(registry, b); err != nil {
		t.Fatal(err)
	}
	server, err := daemon.Start(context.Background(), paths, registry)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	id := daemon.NewRequestID()
	for range 2 {
		if _, err = daemon.Call(context.Background(), paths, "app.wake", map[string]any{"wake_intent_id": id}); err != nil {
			t.Fatal(err)
		}
	}
	for _, payload := range []map[string]any{
		{"wake_intent_id": terminalID}, {"wake_intent_id": "/synthetic/path"}, {"wake_intent_id": id + ";bad"},
		{"wake_intent_id": id, "terminal_intent_id": terminalID}, {"terminal_intent_id": terminalID},
		{"wake_intent_id": id, "local_path": "/synthetic/path"},
	} {
		if _, err = daemon.Call(context.Background(), paths, "app.wake", payload); err == nil {
			t.Fatal("invalid wake input accepted")
		}
	}
	for _, invalid := range []string{id, "", terminalID + "\n", terminalID + ";bad"} {
		if failureCode(b.OpenTerminal(context.Background(), invalid)) != "invalid_request" {
			t.Fatal("non-UUID Terminal authority accepted")
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(wakes) != 2 || wakes[0] != id || wakes[1] != id {
		t.Fatalf("wake identities changed or bypassed validation: %#v", wakes)
	}
	if _, err = daemon.Call(context.Background(), paths, "daemon.status", nil); err != nil {
		t.Fatal("app client disconnection stopped daemon", err)
	}
	if err = server.Store.DB.Ping(); err != nil {
		t.Fatal("app client disconnection closed storage", err)
	}
}

func TestNativeDefaultsRejectUnsignedPeerAndUnbundledDaemon(t *testing.T) {
	if failureCode(authorizeApp(daemon.Peer{UID: os.Getuid(), PID: os.Getpid()})) != "peer_denied" {
		t.Fatal("unsigned test binary impersonated native app")
	}
	if code := failureCode(wakeInstalledApp(context.Background())); code != "app_unavailable" && code != "session_locked" {
		t.Fatal("unbundled daemon launched an app", code)
	}
}
