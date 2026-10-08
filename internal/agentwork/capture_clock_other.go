// ABOUTME: Denies capture timing on platforms without an implemented suspend-inclusive clock.
// ABOUTME: Keeps unsupported systems from silently falling back to wall or Go monotonic time.

//go:build !darwin && !linux

package agentwork

import "time"

func readCaptureClock() (time.Duration, error) {
	return 0, errCaptureClockUnavailable
}
