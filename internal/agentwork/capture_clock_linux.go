// ABOUTME: Reads Linux boot elapsed time including suspended intervals for capture deadlines.
// ABOUTME: Checks the OS timespec and rejects errors instead of using ordinary monotonic time.

package agentwork

import (
	"time"

	"golang.org/x/sys/unix"
)

func readCaptureClock() (time.Duration, error) {
	var sample unix.Timespec
	// Linux BOOTTIME includes suspend; Linux MONOTONIC_RAW does not:
	// https://man7.org/linux/man-pages/man2/clock_gettime.2.html
	if err := unix.ClockGettime(unix.CLOCK_BOOTTIME, &sample); err != nil {
		return 0, errCaptureClockUnavailable
	}
	return checkedCaptureTimespec(int64(sample.Sec), int64(sample.Nsec))
}
