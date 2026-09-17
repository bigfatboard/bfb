// ABOUTME: Defines the hook journal failure codes shared by ingest, inbox and upload.
// ABOUTME: Keeps every local rejection attributable without storing secrets or raw provider text.

package journal

import (
	"errors"

	"github.com/qdis/bfb/internal/daemon"
)

func failure(code string) error { return &daemon.Failure{Code: code} }

// asCode returns the raw local failure code without collapsing journal-specific
// codes through the daemon's CLI diagnostic table.
func asCode(err error) string {
	var failure *daemon.Failure
	if errors.As(err, &failure) && failure.Code != "" {
		return failure.Code
	}
	return "internal_error"
}

// fallbackEligible reports whether the hook CLI may retry through the offline
// inbox instead of returning the failure directly to the provider hook.
func fallbackEligible(err error) bool {
	switch asCode(err) {
	case "daemon_offline", "storage_failed", "execution_capacity", "telemetry_degraded":
		return true
	default:
		return false
	}
}
