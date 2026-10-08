// ABOUTME: Exposes explicit local containment recovery only to a mutually authenticated signed helper.
// ABOUTME: Accepts a local intent without cloud controls, process identities or replacement execution authority.

package supervisor

import (
	"context"

	"github.com/qdis/bfb/internal/daemon"
)

func (service *Service) recover(ctx context.Context, request daemon.Request) (map[string]any, error) {
	intent, ok := request.Envelope.Payload["terminal_intent_id"].(string)
	if !ok || len(request.Envelope.Payload) != 1 || !terminalIntent.MatchString(intent) {
		return nil, failure("invalid_request")
	}
	if _, err := service.options.InspectHelper(request.Peer); err != nil {
		return nil, failure("peer_denied")
	}
	if err := service.waitReady(ctx); err != nil {
		return nil, err
	}
	return map[string]any{}, service.RecoverLocal(ctx, intent)
}

func RecoverExecution(ctx context.Context, paths daemon.Paths, intent string) error {
	if !terminalIntent.MatchString(intent) {
		return failure("invalid_request")
	}
	response, err := daemon.CallWithPeerAuthorization(ctx, paths, "execution.recover", map[string]any{"terminal_intent_id": intent}, func(peer daemon.Peer) error {
		_, err := InspectHelper(peer)
		return err
	})
	if err != nil {
		return err
	}
	if len(response.Payload) != 0 {
		return failure("invalid_request")
	}
	return nil
}
