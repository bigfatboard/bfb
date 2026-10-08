// ABOUTME: Rejects Terminal execution on platforms lacking the required native signed-helper boundary.
// ABOUTME: Preserves portable CLI builds without substituting an unverified process-launch path.

//go:build !darwin || !cgo

package supervisor

import (
	"context"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/provider"
)

func RunHelper(_ context.Context, _ daemon.Paths, intent string, registry *provider.Registry) error {
	if !terminalIntent.MatchString(intent) || registry == nil {
		return failure("invalid_request")
	}
	return failure("platform_unavailable")
}
