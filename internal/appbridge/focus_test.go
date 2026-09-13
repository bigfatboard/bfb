// ABOUTME: Verifies exact focus payloads and signed-app checks against the original pending delivery.
// ABOUTME: Covers wrong peers, cancellation, expiry and ambiguous results without operating Terminal.

package appbridge

import (
	"context"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
)

func syntheticFocus() generated.LocalExecutionFocus {
	now := time.Now().UTC()
	return generated.LocalExecutionFocus{SchemaVersion: 1, TerminalIntentId: terminalID, ControlId: daemon.NewRequestID(), RunExecutionId: daemon.NewRequestID(), AssignmentGeneration: 2,
		Tty: "/dev/ttys001", AuthorizedAt: now.Format(time.RFC3339Nano), ExpiresAt: now.Add(time.Minute).Format(time.RFC3339Nano)}
}

func TestFocusChecksOnlyTheOriginalPendingNativeDelivery(t *testing.T) {
	for _, result := range []string{"terminal_focused", "session_locked", "app_delivery_unknown", "expired_intent"} {
		t.Run(result, func(t *testing.T) {
			b := syntheticBridge(t, Options{})
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			target := syntheticFocus()
			var checks atomic.Int32
			done := make(chan error, 1)
			go func() {
				done <- b.FocusTerminal(ctx, target, func(context.Context) error { checks.Add(1); return nil })
			}()
			peer := daemon.Peer{UID: os.Getuid(), PID: os.Getpid()}
			payload, err := b.poll(ctx, peer, "available")
			if err != nil || len(payload) != 3 || payload["app_action"] != "focus_terminal" || payload["execution_focus"] != target {
				t.Fatal("focus routing changed or leaked another action", err)
			}
			id := payload["app_delivery_id"].(string)
			if failureCode(b.complete(peer, id, "terminal_focused")) != "invalid_request" {
				t.Fatal("unchecked app report became focus success")
			}
			for _, candidate := range []struct {
				peer daemon.Peer
				id   string
			}{
				{peer, target.ControlId}, {peer, target.TerminalIntentId}, {daemon.Peer{UID: peer.UID, PID: peer.PID + 1}, id},
			} {
				if failureCode(b.checkFocus(ctx, candidate.peer, candidate.id)) != "expired_intent" {
					t.Fatal("another identity or app process authorized a native check")
				}
			}
			if checks.Load() != 0 {
				t.Fatal("invalid routing invoked native authorization")
			}
			for range 4 {
				if err := b.checkFocus(ctx, peer, id); err != nil {
					t.Fatal(err)
				}
			}
			if checks.Load() != 4 {
				t.Fatal("native authorization was cached between effects")
			}
			for _, wrong := range []string{"terminal_opened", "notification_delivered"} {
				if failureCode(b.complete(peer, id, wrong)) != "invalid_request" {
					t.Fatal("wrong action acknowledged focus")
				}
			}
			if err := b.complete(peer, id, result); err != nil {
				t.Fatal(err)
			}
			if err := b.complete(peer, id, result); err != nil {
				t.Fatal("lost app reply was not idempotent", err)
			}
			if failureCode(<-done) != failureCode(outcome(result)) {
				t.Fatal("focus outcome was rewritten")
			}
			if failureCode(b.checkFocus(ctx, peer, id)) != "expired_intent" {
				t.Fatal("completed delivery retained native authority")
			}
		})
	}
}

func TestFocusNativeCheckCannotOutliveDeliveryOrChangeApp(t *testing.T) {
	for _, fault := range []string{"cancel", "reject", "stale_poll", "locked", "other_app"} {
		t.Run(fault, func(t *testing.T) {
			b := syntheticBridge(t, Options{})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			started, release := make(chan struct{}), make(chan struct{})
			done := make(chan error, 1)
			go func() {
				done <- b.FocusTerminal(ctx, syntheticFocus(), func(context.Context) error {
					close(started)
					<-release
					if fault == "reject" {
						return &daemon.Failure{Code: "containment_unknown"}
					}
					return nil
				})
			}()
			peer := daemon.Peer{UID: os.Getuid(), PID: os.Getpid()}
			payload, err := b.poll(ctx, peer, "available")
			if err != nil {
				t.Fatal(err)
			}
			id := payload["app_delivery_id"].(string)
			checked := make(chan error, 1)
			go func() { checked <- b.checkFocus(context.Background(), peer, id) }()
			<-started
			switch fault {
			case "cancel":
				cancel()
			case "stale_poll":
				b.mu.Lock()
				b.lastPoll = time.Now().Add(-6 * time.Second)
				b.mu.Unlock()
			case "locked":
				b.mu.Lock()
				b.state = "locked"
				b.mu.Unlock()
			case "other_app":
				b.mu.Lock()
				b.appPID++
				b.mu.Unlock()
			}
			close(release)
			if err := <-checked; err == nil {
				t.Fatal("native check escaped its pending delivery")
			}
			if fault != "cancel" && failureCode(b.complete(peer, id, "terminal_focused")) != "invalid_request" {
				t.Fatal("failed native check enabled success")
			}
			cancel()
			if failureCode(<-done) != "app_delivery_unknown" {
				t.Fatal("offered focus was silently replayable")
			}
		})
	}
}

func TestFocusRoutingRefusesCallerPathsAndMissingNativeGuard(t *testing.T) {
	b := syntheticBridge(t, Options{WakeApp: func(context.Context) error { t.Error("invalid focus woke an app"); return nil }})
	for _, tty := range []string{"/dev/tty", "/dev/ttys001\n", "/dev/ttys001;echo", "file:///dev/ttys001", "/synthetic/private"} {
		target := syntheticFocus()
		target.Tty = tty
		if failureCode(b.FocusTerminal(context.Background(), target, func(context.Context) error { return nil })) != "invalid_request" {
			t.Fatal("unbounded routing device accepted")
		}
	}
	if failureCode(b.FocusTerminal(context.Background(), syntheticFocus(), nil)) != "invalid_request" {
		t.Fatal("missing native guard accepted")
	}
}
