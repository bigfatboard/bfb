// ABOUTME: Proves X01 notification intents travel the real bridge as opaque ULIDs only.
// ABOUTME: The synthetic app peer completes deliveries; native UI effects stay out of scope.

package appbridge

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
)

const x01DeliveryA = "01JX01MAC0S000000000000001"

func TestNotifyAttentionOpaqueDelivery(t *testing.T) {
	// WakeApp is doubled: the OS wake step needs an installed app, while the
	// bridge delivery path under test stays real.
	b := syntheticBridge(t, Options{WakeApp: func(context.Context) error { return nil }})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- b.NotifyAttention(ctx, x01DeliveryA) }()
	peer := daemon.Peer{UID: os.Getuid(), PID: os.Getpid()}
	payload, err := b.poll(ctx, peer, "available")
	if err != nil {
		t.Fatalf("app poll failed: %v", err)
	}
	if len(payload) != 3 || payload["app_action"] != "notify_attention" || payload["notification_id"] != x01DeliveryA {
		t.Fatalf("notification delivery carries unexpected fields: %#v", payload)
	}
	id, ok := payload["app_delivery_id"].(string)
	if !ok || id == "" {
		t.Fatalf("notification delivery lacks an id: %#v", payload)
	}
	if err := b.complete(peer, id, "notification_delivered"); err != nil {
		t.Fatalf("app complete failed: %v", err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("NotifyAttention failed: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("NotifyAttention never completed")
	}
}

func TestNotifyAttentionDeniedSurfaces(t *testing.T) {
	b := syntheticBridge(t, Options{WakeApp: func(context.Context) error { return nil }})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- b.NotifyAttention(ctx, x01DeliveryA) }()
	peer := daemon.Peer{UID: os.Getuid(), PID: os.Getpid()}
	payload, err := b.poll(ctx, peer, "available")
	if err != nil {
		t.Fatalf("app poll failed: %v", err)
	}
	id := payload["app_delivery_id"].(string)
	if err := b.complete(peer, id, "notification_denied"); err != nil {
		t.Fatalf("app complete failed: %v", err)
	}
	select {
	case err := <-done:
		if failureCode(err) != "notification_denied" {
			t.Fatalf("denied permission must surface typed, got: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("NotifyAttention never completed")
	}
}

func TestNotifyAttentionRejectsNonOpaqueIDs(t *testing.T) {
	b := syntheticBridge(t, Options{})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	for _, id := range []string{"", "task body with /local/path", "01JX01MAC0S0000000000000!"} {
		if failureCode(b.NotifyAttention(ctx, id)) != "invalid_request" {
			t.Fatalf("non-opaque id %q must fail closed", id)
		}
	}
}
