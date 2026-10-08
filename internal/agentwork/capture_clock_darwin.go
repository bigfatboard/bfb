// ABOUTME: Reads Darwin continuous elapsed time through the pinned Unix clock interface.
// ABOUTME: Includes sleep in capture deadlines and checks the returned timespec before conversion.

package agentwork

import (
	"time"

	"golang.org/x/sys/unix"
)

func readCaptureClock() (time.Duration, error) {
	var sample unix.Timespec
	// Apple libc maps Darwin CLOCK_MONOTONIC_RAW to mach_continuous_time:
	// https://github.com/apple-oss-distributions/Libc/blob/main/gen/clock_gettime.c
	if err := unix.ClockGettime(unix.CLOCK_MONOTONIC_RAW, &sample); err != nil {
		return 0, errCaptureClockUnavailable
	}
	return checkedCaptureTimespec(sample.Sec, sample.Nsec)
}
