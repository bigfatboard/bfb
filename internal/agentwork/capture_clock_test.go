// ABOUTME: Exercises checked suspend-inclusive clock conversion and the platform reader.
// ABOUTME: Proves invalid fields and overflow fail without fabricated elapsed samples.

package agentwork

import (
	"errors"
	"runtime"
	"testing"
	"time"
)

func TestCaptureClockTimespecConversion(t *testing.T) {
	for _, test := range []struct {
		name                 string
		seconds, nanoseconds int64
		want                 time.Duration
		invalid              bool
	}{
		{name: "zero"},
		{name: "fraction", seconds: 12, nanoseconds: 345_678_901, want: 12*time.Second + 345_678_901},
		{name: "maximum", seconds: maxCaptureClockNanos / int64(time.Second), nanoseconds: maxCaptureClockNanos % int64(time.Second), want: time.Duration(maxCaptureClockNanos)},
		{name: "negative seconds", seconds: -1, invalid: true},
		{name: "negative nanoseconds", nanoseconds: -1, invalid: true},
		{name: "unnormalized nanoseconds", nanoseconds: int64(time.Second), invalid: true},
		{name: "seconds overflow", seconds: maxCaptureClockNanos/int64(time.Second) + 1, invalid: true},
		{name: "addition overflow", seconds: maxCaptureClockNanos / int64(time.Second), nanoseconds: maxCaptureClockNanos%int64(time.Second) + 1, invalid: true},
		{name: "maximum seconds", seconds: maxCaptureClockNanos, invalid: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			actual, err := checkedCaptureTimespec(test.seconds, test.nanoseconds)
			if test.invalid {
				if !errors.Is(err, errCaptureClockInvalid) || actual != 0 {
					t.Fatalf("invalid sample admitted: %v, %v", actual, err)
				}
			} else if err != nil || actual != test.want {
				t.Fatalf("checked sample = %v, %v; want %v", actual, err, test.want)
			}
		})
	}
}

func TestCaptureClockPlatformRead(t *testing.T) {
	first, err := readCaptureClock()
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		if !errors.Is(err, errCaptureClockUnavailable) || first != 0 {
			t.Fatalf("unsupported platform invented elapsed time: %v, %v", first, err)
		}
		return
	}
	if err != nil || first < 0 {
		t.Fatalf("platform elapsed clock unavailable: %v, %v", first, err)
	}
	second, err := readCaptureClock()
	if err != nil || second < first {
		t.Fatalf("platform elapsed clock regressed: %v -> %v, %v", first, second, err)
	}
}
