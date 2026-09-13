// ABOUTME: Verifies local recovery authenticates its caller before reading persistent execution evidence.
// ABOUTME: Rejects malformed targeting, untrusted peers and missing containment proof without creating state.

package supervisor

import (
	"context"
	"reflect"
	"testing"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
)

func TestRecoveryRPCRejectsMalformedTargetBeforePeerInspection(t *testing.T) {
	service := NewService(ServiceOptions{InspectHelper: func(daemon.Peer) (SupervisorIdentity, error) {
		t.Fatal("malformed target reached native inspection")
		return SupervisorIdentity{}, nil
	}})
	for _, payload := range []map[string]any{
		nil, {}, {"terminal_intent_id": "01K00000000000000000000001"},
		{"terminal_intent_id": "00000000-0000-4000-8000-000000000001", "daemon_pid": 1234},
	} {
		reply, err := service.recover(context.Background(), daemon.Request{Envelope: generated.LocalRpcEnvelope{Payload: payload}})
		assertFailure(t, err, "invalid_request")
		if reply != nil {
			t.Fatal("invalid target received recovery data")
		}
	}
	assertFailure(t, RecoverExecution(context.Background(), daemon.Paths{}, "01K00000000000000000000001"), "invalid_request")
}

func TestRecoveryRPCRequiresSignedPeerAndExistingNativeProof(t *testing.T) {
	store, local, claim, now := fixtureIntents(t)
	assignment := issueFixture(t, store, claim, now)
	allowed := false
	wantPeer := daemon.Peer{UID: 501, PID: 1200}
	service := NewService(ServiceOptions{InspectHelper: func(peer daemon.Peer) (SupervisorIdentity, error) {
		if peer != wantPeer || !allowed {
			return SupervisorIdentity{}, failure("peer_denied")
		}
		return SupervisorIdentity{Process: fixtureProcess(1200, 1, 1200)}, nil
	}})
	request := daemon.Request{Peer: wantPeer, Envelope: generated.LocalRpcEnvelope{Payload: map[string]any{"terminal_intent_id": assignment.IntentID}}}
	// Not-ready state must not delay refusal of an untrusted caller.
	_, err := service.recover(context.Background(), request)
	assertFailure(t, err, "peer_denied")
	allowed = true
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = service.recover(ctx, request)
	assertFailure(t, err, "daemon_offline")
	service.store, service.paths = store, local.Paths
	close(service.ready)
	for range 2 {
		_, err = service.recover(context.Background(), request)
		assertFailure(t, err, "containment_unknown")
	}
	after, err := store.ByIntent(context.Background(), assignment.IntentID)
	if err != nil || !reflect.DeepEqual(after, assignment) {
		t.Fatal("recovery fabricated a supervisor or changed an unregistered assignment", err)
	}
	service.store = nil
	_, err = service.recover(context.Background(), request)
	assertFailure(t, err, "daemon_offline")
}
