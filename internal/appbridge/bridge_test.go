// ABOUTME: Exercises app-delivery correlation, bounded failure states and wake/Terminal separation.
// ABOUTME: Uses real private daemon RPC for negative inputs while keeping native UI effects synthetic.

package appbridge

import (
	"context"
	"os"
	"os/exec"
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

func TestRelaunchWakeRetriesADroppedLaunchOnce(t *testing.T) {
	var mu sync.Mutex
	wakes := 0
	b := syntheticBridge(t, Options{
		WakeApp: func(context.Context) error {
			mu.Lock()
			defer mu.Unlock()
			wakes++
			return nil
		},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- b.OpenTerminal(ctx, terminalID) }()
	deadline := time.Now().Add(4 * time.Second)
	for {
		mu.Lock()
		started := wakes >= 2
		mu.Unlock()
		if started || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	mu.Lock()
	retried := wakes
	mu.Unlock()
	if retried < 2 {
		t.Fatal("dropped launch was never re-issued while no app polled")
	}
	peer := daemon.Peer{UID: os.Getuid(), PID: os.Getpid()}
	payload, err := b.poll(ctx, peer, "available")
	if err != nil {
		t.Fatal(err)
	}
	if err := b.complete(peer, payload["app_delivery_id"].(string), "terminal_opened"); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal("re-issued launch did not deliver", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if wakes != 2 {
		t.Fatalf("re-issued launch woke the app %d times, not twice", wakes)
	}
}

func TestDroppedLaunchWithoutAppStaysUnavailable(t *testing.T) {
	var mu sync.Mutex
	wakes := 0
	b := syntheticBridge(t, Options{
		WakeApp: func(context.Context) error {
			mu.Lock()
			defer mu.Unlock()
			wakes++
			return nil
		},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if code := failureCode(b.OpenTerminal(ctx, terminalID)); code != "app_unavailable" {
		t.Fatalf("dropped launch reported %s instead of app_unavailable", code)
	}
	mu.Lock()
	defer mu.Unlock()
	if wakes != 2 {
		t.Fatalf("dropped launch woke the app %d times instead of exactly twice", wakes)
	}
	b.mu.Lock()
	pending := len(b.pending)
	b.mu.Unlock()
	if pending != 0 {
		t.Fatal("abandoned delivery retained for blind replay")
	}
}

// reapedPID returns a process ID that names no live process: the short-lived
// child is reaped before returning, so kernel liveness fails for it.
func reapedPID(t *testing.T) int {
	t.Helper()
	child := exec.Command("/bin/sleep", "0.01")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	pid := child.Process.Pid
	if err := child.Wait(); err != nil {
		t.Fatal(err)
	}
	return pid
}

func TestOfferReclaimedAfterOfferedAppDeath(t *testing.T) {
	b := syntheticBridge(t, Options{})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- b.OpenTerminal(ctx, terminalID) }()
	// A terminating app's in-flight poll takes the offer, then the app dies
	// without completing: its quit raced the wake exactly like a relaunch.
	dying := daemon.Peer{UID: os.Getuid(), PID: reapedPID(t)}
	stolen, err := b.poll(ctx, dying, "available")
	if err != nil || stolen["app_action"] != "open_terminal" {
		t.Fatalf("dying poll did not take the offer: %#v %v", stolen, err)
	}
	id, _ := stolen["app_delivery_id"].(string)
	if id == "" {
		t.Fatal("offered delivery has no acknowledgement identity")
	}
	// The live relaunched app polls next and must receive the same delivery
	// instead of idling until the handoff times out.
	live := daemon.Peer{UID: os.Getuid(), PID: os.Getpid()}
	fresh, err := b.poll(ctx, live, "available")
	if err != nil || fresh["app_delivery_id"] != id || fresh["app_action"] != "open_terminal" {
		t.Fatalf("dead owner's offer was not reclaimed: %#v %v", fresh, err)
	}
	if err := b.complete(live, id, "terminal_opened"); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal("reclaimed delivery did not complete", err)
	}
	if failureCode(b.complete(dying, id, "terminal_opened")) != "invalid_request" {
		t.Fatal("reclaimed receipt lost its process binding")
	}
}

func TestOfferNeverStolenFromLiveOwner(t *testing.T) {
	b := syntheticBridge(t, Options{})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- b.OpenTerminal(ctx, terminalID) }()
	owner := daemon.Peer{UID: os.Getuid(), PID: os.Getpid()}
	offered, err := b.poll(ctx, owner, "available")
	if err != nil || offered["app_action"] != "open_terminal" {
		t.Fatalf("owner did not take the offer: %#v %v", offered, err)
	}
	// Another live app polling while the owner works must wait, never take
	// the in-flight offer.
	waiter := daemon.Peer{UID: os.Getuid(), PID: os.Getppid()}
	short, cancelShort := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancelShort()
	if again, err := b.poll(short, waiter, "available"); err != nil || len(again) != 0 {
		t.Fatalf("live owner's offer was stolen: %#v %v", again, err)
	}
	if err := b.complete(owner, offered["app_delivery_id"].(string), "terminal_opened"); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestWakeRetriesTransientLaunchFailure(t *testing.T) {
	var mu sync.Mutex
	wakes := 0
	b := syntheticBridge(t, Options{
		WakeApp: func(context.Context) error {
			mu.Lock()
			defer mu.Unlock()
			wakes++
			if wakes < 3 {
				return &daemon.Failure{Code: "app_unavailable"}
			}
			return nil
		},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- b.OpenTerminal(ctx, terminalID) }()
	peer := daemon.Peer{UID: os.Getuid(), PID: os.Getpid()}
	payload, err := b.poll(ctx, peer, "available")
	if err != nil || payload["app_action"] != "open_terminal" {
		t.Fatalf("retried wake never delivered: %#v %v", payload, err)
	}
	if err := b.complete(peer, payload["app_delivery_id"].(string), "terminal_opened"); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if wakes != 3 {
		t.Fatalf("transient launch failure woke the app %d times instead of 3", wakes)
	}
}

func TestWakeStopsAtDeadlineOnPersistentFailure(t *testing.T) {
	var mu sync.Mutex
	wakes := 0
	b := syntheticBridge(t, Options{
		WakeApp: func(context.Context) error {
			mu.Lock()
			defer mu.Unlock()
			wakes++
			return &daemon.Failure{Code: "app_unavailable"}
		},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 1200*time.Millisecond)
	defer cancel()
	start := time.Now()
	if code := failureCode(b.OpenTerminal(ctx, terminalID)); code != "app_unavailable" {
		t.Fatalf("persistent launch failure reported %s", code)
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("wake retry extended the delivery deadline: %v", elapsed)
	}
	mu.Lock()
	defer mu.Unlock()
	if wakes < 2 {
		t.Fatalf("persistent launch failure was never retried: %d wake", wakes)
	}
}

func TestWakeReturnsSessionLockAtOnce(t *testing.T) {
	var mu sync.Mutex
	wakes := 0
	b := syntheticBridge(t, Options{
		WakeApp: func(context.Context) error {
			mu.Lock()
			defer mu.Unlock()
			wakes++
			return &daemon.Failure{Code: "session_locked"}
		},
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := time.Now()
	if code := failureCode(b.OpenTerminal(ctx, terminalID)); code != "session_locked" {
		t.Fatalf("session lock reported %s", code)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("definitive session lock was retried: %v", elapsed)
	}
	mu.Lock()
	defer mu.Unlock()
	if wakes != 1 {
		t.Fatalf("session lock woke the app %d times instead of once", wakes)
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
