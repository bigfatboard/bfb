// ABOUTME: Simulates confirmation retry, suspend, restart and clock faults with injected elapsed samples.
// ABOUTME: Requires original timing anchors, strict horizons and conservative canonical capture milliseconds.

package agentwork

import (
	"errors"
	"sync"
	"testing"
	"time"
)

const captureTestID = "01K6XB4NS00000000000000001"
const captureFreshTestID = "01K6XB4NS00000000000000002"

var captureServerTime = time.Date(2026, 10, 6, 12, 0, 0, 123_000_000, time.UTC)

type captureTestClock struct {
	now time.Duration
	err error
}

func (clock *captureTestClock) read() (time.Duration, error) { return clock.now, clock.err }

func confirmedCaptureTiming(t *testing.T, clock *captureTestClock, lease, credential time.Duration) *captureTiming {
	t.Helper()
	timing, err := newCaptureTiming(captureTestID, clock.read)
	if err != nil {
		t.Fatal(err)
	}
	if err := timing.receive(captureTestID, captureServerTime, captureServerTime.Add(lease), captureServerTime.Add(credential)); err != nil {
		t.Fatal(err)
	}
	return timing
}

func TestCaptureTimingUsesShortestStrictSendHorizon(t *testing.T) {
	for _, test := range []struct {
		name                       string
		lease, credential, horizon time.Duration
	}{
		{"confirmation", time.Minute, 5 * time.Minute, 45 * time.Second},
		{"lease", 12 * time.Second, 5 * time.Minute, 12 * time.Second},
		{"credential", time.Minute, 8 * time.Second, 8 * time.Second},
	} {
		t.Run(test.name, func(t *testing.T) {
			clock := &captureTestClock{now: time.Hour}
			timing := confirmedCaptureTiming(t, clock, test.lease, test.credential)
			clock.now += test.horizon - time.Millisecond
			actual, err := timing.captureTime()
			if err != nil || !actual.Equal(captureServerTime.Add(test.horizon-time.Millisecond)) {
				t.Fatalf("inside horizon: %v, %v", actual, err)
			}
			clock.now += time.Millisecond
			if _, err := timing.captureTime(); !errors.Is(err, errCaptureTimingExpired) {
				t.Fatalf("exact horizon admitted: %v", err)
			}
			clock.now = time.Hour
			if _, err := timing.captureTime(); !errors.Is(err, errCaptureTimingExpired) {
				t.Fatalf("expired confirmation recovered after rollback: %v", err)
			}
		})
	}
}

func TestCaptureTimingCountsSuspendWithoutWallClock(t *testing.T) {
	clock := &captureTestClock{now: 10 * time.Hour}
	timing := confirmedCaptureTiming(t, clock, time.Minute, 5*time.Minute)
	clock.now += 2 * time.Second
	if actual, err := timing.captureTime(); err != nil || !actual.Equal(captureServerTime.Add(2*time.Second)) {
		t.Fatalf("server-anchored capture time: %v, %v", actual, err)
	}
	// Simulated suspend advances the continuous clock while a Go uptime clock
	// or a rolled-back wall clock could remain unchanged. Neither is an input.
	clock.now += 44 * time.Second
	if _, err := timing.captureTime(); !errors.Is(err, errCaptureTimingExpired) {
		t.Fatalf("suspend extended capture permission: %v", err)
	}
}

func TestCaptureTimingDelayedRetryKeepsBothOriginalAnchors(t *testing.T) {
	clock := &captureTestClock{now: time.Hour}
	timing, err := newCaptureTiming(captureTestID, clock.read)
	if err != nil {
		t.Fatal(err)
	}
	clock.now += 20 * time.Second
	if err := timing.receive(captureTestID, captureServerTime, captureServerTime.Add(time.Minute), captureServerTime.Add(5*time.Minute)); err != nil {
		t.Fatal(err)
	}
	clock.now += 10 * time.Second
	if err := timing.receive(captureTestID, captureServerTime, captureServerTime.Add(time.Minute), captureServerTime.Add(5*time.Minute)); err != nil {
		t.Fatal(err)
	}
	clock.now += 10 * time.Second
	actual, err := timing.captureTime()
	if err != nil || !actual.Equal(captureServerTime.Add(20*time.Second)) {
		t.Fatalf("retry reset first receipt or used send for capture time: %v, %v", actual, err)
	}
	if timing.sent != time.Hour || timing.received != time.Hour+20*time.Second {
		t.Fatalf("original anchors replaced: %v, %v", timing.sent, timing.received)
	}
	clock.now += 5 * time.Second
	if err := timing.receive(captureTestID, captureServerTime, captureServerTime.Add(time.Minute), captureServerTime.Add(5*time.Minute)); !errors.Is(err, errCaptureTimingExpired) {
		t.Fatalf("cached response restarted send horizon: %v", err)
	}
}

func TestCaptureTimingLostReplyDoesNotRestartAtFirstReceipt(t *testing.T) {
	clock := &captureTestClock{}
	timing, err := newCaptureTiming(captureTestID, clock.read)
	if err != nil {
		t.Fatal(err)
	}
	// The first network reply was lost. A cached retry arrives at the deadline.
	clock.now = 45 * time.Second
	if err := timing.receive(captureTestID, captureServerTime, captureServerTime.Add(time.Minute), captureServerTime.Add(5*time.Minute)); !errors.Is(err, errCaptureTimingExpired) {
		t.Fatalf("lost-reply retry acquired a new send anchor: %v", err)
	}
}

func TestCaptureTimingMissingAnchorsCannotBeRestored(t *testing.T) {
	for _, test := range []struct {
		name   string
		timing *captureTiming
	}{
		{"restart", &captureTiming{}},
		{"serialized times without send", &captureTiming{requestID: captureTestID, confirmedAt: captureServerTime, leaseExpiresAt: captureServerTime.Add(time.Minute), credentialExpiresAt: captureServerTime.Add(5 * time.Minute)}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := test.timing.receive(captureTestID, captureServerTime, captureServerTime.Add(time.Minute), captureServerTime.Add(5*time.Minute)); !errors.Is(err, errCaptureTimingMissing) {
				t.Fatalf("missing anchor reconstructed: %v", err)
			}
			if _, err := test.timing.captureTime(); !errors.Is(err, errCaptureTimingMissing) {
				t.Fatalf("missing anchor failure not sticky: %v", err)
			}
		})
	}
	clock := &captureTestClock{}
	timing, err := newCaptureTiming(captureTestID, clock.read)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := timing.captureTime(); !errors.Is(err, errCaptureTimingMissing) {
		t.Fatalf("unverified receipt admitted: %v", err)
	}
	if err := timing.receive(captureTestID, captureServerTime, captureServerTime.Add(time.Minute), captureServerTime.Add(time.Minute)); !errors.Is(err, errCaptureTimingMissing) {
		t.Fatalf("missing receipt failure was reset: %v", err)
	}
	// The consumer must use a new daemon request identity for a new live send.
	fresh, err := newCaptureTiming(captureFreshTestID, clock.read)
	if err != nil {
		t.Fatal(err)
	}
	if err := fresh.receive(captureFreshTestID, captureServerTime, captureServerTime.Add(time.Minute), captureServerTime.Add(time.Minute)); err != nil {
		t.Fatalf("fresh live confirmation failed: %v", err)
	}
}

func TestCaptureTimingClockFaultsRemainSticky(t *testing.T) {
	for _, fault := range []string{"unavailable", "negative", "backwards", "wrapped"} {
		t.Run(fault, func(t *testing.T) {
			clock := &captureTestClock{now: time.Hour}
			timing := confirmedCaptureTiming(t, clock, time.Minute, time.Minute)
			clock.now += time.Second
			if _, err := timing.captureTime(); err != nil {
				t.Fatal(err)
			}
			switch fault {
			case "unavailable":
				clock.err = errCaptureClockUnavailable
			case "negative":
				clock.now = -1
			case "backwards":
				clock.now -= time.Nanosecond
			case "wrapped":
				clock.now = time.Duration(-1 << 63)
			}
			_, original := timing.captureTime()
			if original == nil {
				t.Fatal("invalid elapsed clock admitted")
			}
			clock.err, clock.now = nil, 2*time.Hour
			if _, err := timing.captureTime(); err != original {
				t.Fatalf("clock recovery reset sticky failure: %v -> %v", original, err)
			}
			if err := timing.receive(captureTestID, captureServerTime, captureServerTime.Add(time.Minute), captureServerTime.Add(time.Minute)); err != original {
				t.Fatalf("same-ID retry reset clock failure: %v", err)
			}
			fresh, err := newCaptureTiming(captureFreshTestID, clock.read)
			if err != nil || fresh.failure != nil {
				t.Fatalf("fresh timing could not acquire new anchor: %v", err)
			}
		})
	}
	for _, clock := range []captureClock{nil, func() (time.Duration, error) { return 0, errCaptureClockUnavailable }, func() (time.Duration, error) { return -1, nil }} {
		timing, err := newCaptureTiming(captureTestID, clock)
		if err == nil || timing == nil || timing.failure != err {
			t.Fatalf("initial clock failure lost its sticky object: %v, %v", timing, err)
		}
	}
}

func TestCaptureTimingRejectsChangedOrInvalidConfirmation(t *testing.T) {
	for _, change := range []string{"identity", "confirmed", "lease", "credential", "fractional", "zero", "range", "expired lease", "expired credential"} {
		t.Run(change, func(t *testing.T) {
			clock := &captureTestClock{}
			timing := confirmedCaptureTiming(t, clock, time.Minute, time.Minute)
			id, confirmed, lease, credential := captureTestID, captureServerTime, captureServerTime.Add(time.Minute), captureServerTime.Add(time.Minute)
			switch change {
			case "identity":
				id = captureFreshTestID
			case "confirmed":
				confirmed = confirmed.Add(time.Millisecond)
			case "lease":
				lease = lease.Add(time.Millisecond)
			case "credential":
				credential = credential.Add(time.Millisecond)
			case "fractional":
				confirmed = confirmed.Add(time.Nanosecond)
			case "zero":
				confirmed = time.Time{}
			case "range":
				credential = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
			case "expired lease":
				lease = confirmed
			case "expired credential":
				credential = confirmed.Add(-time.Millisecond)
			}
			if err := timing.receive(id, confirmed, lease, credential); !errors.Is(err, errCaptureTimingInvalid) {
				t.Fatalf("changed/invalid confirmation accepted: %v", err)
			}
			if _, err := timing.captureTime(); !errors.Is(err, errCaptureTimingInvalid) {
				t.Fatalf("invalid confirmation retained permission: %v", err)
			}
		})
	}
}

func TestCaptureTimingRoundsUpCanonicalMillisecondsAndRechecksDeadline(t *testing.T) {
	clock := &captureTestClock{}
	timing := confirmedCaptureTiming(t, clock, time.Minute, time.Minute)
	clock.now = time.Nanosecond
	actual, err := timing.captureTime()
	if err != nil || actual.Format("2006-01-02T15:04:05.000Z") != "2026-10-06T12:00:00.124Z" {
		t.Fatalf("capture time did not round conservatively to UTC milliseconds: %v, %v", actual, err)
	}
	for _, horizon := range []time.Duration{45 * time.Second, 8 * time.Second} {
		clock := &captureTestClock{}
		timing := confirmedCaptureTiming(t, clock, horizon, time.Minute)
		clock.now = horizon - time.Nanosecond
		if _, err := timing.captureTime(); !errors.Is(err, errCaptureTimingExpired) {
			t.Fatalf("rounded signed time crossed strict deadline %v: %v", horizon, err)
		}
	}
	for _, elapsed := range []time.Duration{-1, time.Duration(maxCaptureClockNanos)} {
		if actual, err := ceilCaptureMillis(elapsed); !errors.Is(err, errCaptureClockInvalid) || actual != 0 {
			t.Fatalf("rounding invalid/overflowed elapsed accepted: %v, %v", actual, err)
		}
	}
}

func TestCaptureTimingSerializesConcurrentObservations(t *testing.T) {
	clock := &captureTestClock{}
	timing := confirmedCaptureTiming(t, clock, time.Minute, time.Minute)
	clock.now = time.Second
	var observers sync.WaitGroup
	for range 16 {
		observers.Go(func() {
			if actual, err := timing.captureTime(); err != nil || !actual.Equal(captureServerTime.Add(time.Second)) {
				t.Errorf("concurrent observation failed: %v, %v", actual, err)
			}
		})
	}
	observers.Wait()
}
