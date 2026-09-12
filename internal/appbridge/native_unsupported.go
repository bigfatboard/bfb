// ABOUTME: Makes native app delivery explicitly unavailable outside signed macOS execution.
// ABOUTME: Preserves the app bridge contract without a shell or alternate-terminal fallback.

//go:build !darwin || !cgo

package appbridge

import (
	"context"
	"github.com/qdis/bfb/internal/daemon"
)

func wakeInstalledApp(context.Context) error { return &daemon.Failure{Code: "app_unavailable"} }
func authorizeApp(daemon.Peer) error         { return &daemon.Failure{Code: "peer_denied"} }
