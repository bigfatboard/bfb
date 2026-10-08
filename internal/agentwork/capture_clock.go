// ABOUTME: Defines private suspend-inclusive elapsed samples for daemon capture confirmation timing.
// ABOUTME: Rejects malformed or overflowing clock values without a wall-clock fallback.

package agentwork

import (
	"errors"
	"time"
)

type captureClock func() (time.Duration, error)

var errCaptureClockUnavailable = errors.New("capture elapsed clock unavailable")
var errCaptureClockInvalid = errors.New("capture elapsed clock invalid")

const maxCaptureClockNanos = int64(1<<63 - 1)

func checkedCaptureTimespec(seconds, nanoseconds int64) (time.Duration, error) {
	if seconds < 0 || nanoseconds < 0 || nanoseconds >= int64(time.Second) || seconds > maxCaptureClockNanos/int64(time.Second) {
		return 0, errCaptureClockInvalid
	}
	whole := seconds * int64(time.Second)
	if nanoseconds > maxCaptureClockNanos-whole {
		return 0, errCaptureClockInvalid
	}
	return time.Duration(whole + nanoseconds), nil
}
