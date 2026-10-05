// ABOUTME: Retains original send and first verified receipt anchors for one daemon confirmation.
// ABOUTME: Derives bounded canonical capture times with sticky failure and no anchor reset or restore.

package agentwork

import (
	"errors"
	"sync"
	"time"
)

const captureConfirmationHorizon = 45 * time.Second

var errCaptureTimingInvalid = errors.New("capture confirmation timing invalid")
var errCaptureTimingMissing = errors.New("capture confirmation timing anchor missing")
var errCaptureTimingExpired = errors.New("capture confirmation timing expired")

// This object is not durable authority. The admission consumer creates it at the
// first send using a fresh daemon-owned confirmation ID, retaining it for retries.
// Missing objects and daemon restarts require a new live request with a fresh ID;
// a serialized server confirmation cannot recreate either elapsed anchor.
type captureTiming struct {
	mu                  sync.Mutex
	clock               captureClock
	requestID           string
	sent                time.Duration
	received            time.Duration
	last                time.Duration
	hasSend             bool
	hasReceipt          bool
	confirmedAt         time.Time
	leaseExpiresAt      time.Time
	credentialExpiresAt time.Time
	horizon             time.Duration
	failure             error
}

// Even on an initial clock error, return the invalidated object so the consumer
// retains sticky failure for this ID rather than reconstructing a retry anchor.
func newCaptureTiming(requestID string, clock captureClock) (*captureTiming, error) {
	timing := &captureTiming{requestID: requestID, clock: clock}
	if requestID == "" {
		return timing, timing.invalidate(errCaptureTimingInvalid)
	}
	sample, err := timing.sample()
	if err != nil {
		return timing, err
	}
	timing.sent, timing.hasSend = sample, true
	return timing, nil
}

// The caller must finish wire and authority verification before recording a
// receipt. An exact duplicate can be observed but never renews either anchor.
func (timing *captureTiming) receive(requestID string, confirmedAt, leaseExpiresAt, credentialExpiresAt time.Time) error {
	timing.mu.Lock()
	defer timing.mu.Unlock()
	if timing.failure != nil {
		return timing.failure
	}
	if !timing.hasSend {
		return timing.invalidate(errCaptureTimingMissing)
	}
	if requestID != timing.requestID {
		return timing.invalidate(errCaptureTimingInvalid)
	}
	confirmedAt, leaseExpiresAt, credentialExpiresAt = confirmedAt.UTC(), leaseExpiresAt.UTC(), credentialExpiresAt.UTC()
	if !canonicalCaptureInstant(confirmedAt) || !canonicalCaptureInstant(leaseExpiresAt) || !canonicalCaptureInstant(credentialExpiresAt) || !confirmedAt.Before(leaseExpiresAt) || !confirmedAt.Before(credentialExpiresAt) {
		return timing.invalidate(errCaptureTimingInvalid)
	}
	if timing.hasReceipt && (!confirmedAt.Equal(timing.confirmedAt) || !leaseExpiresAt.Equal(timing.leaseExpiresAt) || !credentialExpiresAt.Equal(timing.credentialExpiresAt)) {
		return timing.invalidate(errCaptureTimingInvalid)
	}
	sample, err := timing.sample()
	if err != nil {
		return err
	}
	if !timing.hasReceipt {
		timing.received, timing.hasReceipt = sample, true
		timing.confirmedAt, timing.leaseExpiresAt, timing.credentialExpiresAt = confirmedAt, leaseExpiresAt, credentialExpiresAt
		timing.horizon = min(captureConfirmationHorizon, leaseExpiresAt.Sub(confirmedAt), credentialExpiresAt.Sub(confirmedAt))
	}
	return timing.checkHorizon(sample)
}

func (timing *captureTiming) captureTime() (time.Time, error) {
	timing.mu.Lock()
	defer timing.mu.Unlock()
	if timing.failure != nil {
		return time.Time{}, timing.failure
	}
	if !timing.hasSend || !timing.hasReceipt {
		return time.Time{}, timing.invalidate(errCaptureTimingMissing)
	}
	sample, err := timing.sample()
	if err != nil {
		return time.Time{}, err
	}
	if err := timing.checkHorizon(sample); err != nil {
		return time.Time{}, err
	}
	elapsed, err := ceilCaptureMillis(sample - timing.received)
	if err != nil {
		return time.Time{}, timing.invalidate(err)
	}
	capturedAt := timing.confirmedAt.Add(elapsed)
	// Ceil cannot place the signed time at or beyond a strict server deadline.
	if !canonicalCaptureInstant(capturedAt) || !capturedAt.Before(timing.confirmedAt.Add(captureConfirmationHorizon)) || !capturedAt.Before(timing.leaseExpiresAt) || !capturedAt.Before(timing.credentialExpiresAt) {
		return time.Time{}, timing.invalidate(errCaptureTimingExpired)
	}
	return capturedAt, nil
}

func (timing *captureTiming) sample() (time.Duration, error) {
	if timing.failure != nil {
		return 0, timing.failure
	}
	if timing.clock == nil {
		return 0, timing.invalidate(errCaptureClockUnavailable)
	}
	sample, err := timing.clock()
	if err != nil {
		return 0, timing.invalidate(err)
	}
	if sample < 0 || (timing.hasSend && sample < timing.last) {
		return 0, timing.invalidate(errCaptureClockInvalid)
	}
	timing.last = sample
	return sample, nil
}

func (timing *captureTiming) checkHorizon(sample time.Duration) error {
	if sample-timing.sent >= timing.horizon {
		return timing.invalidate(errCaptureTimingExpired)
	}
	return nil
}

func (timing *captureTiming) invalidate(err error) error {
	if timing.failure == nil {
		timing.failure = err
	}
	return timing.failure
}

func canonicalCaptureInstant(value time.Time) bool {
	return !value.IsZero() && value.Year() >= 1 && value.Year() <= 9999 && value.Nanosecond()%int(time.Millisecond) == 0
}

func ceilCaptureMillis(elapsed time.Duration) (time.Duration, error) {
	if elapsed < 0 {
		return 0, errCaptureClockInvalid
	}
	remainder := elapsed % time.Millisecond
	if remainder == 0 {
		return elapsed, nil
	}
	roundUp := time.Millisecond - remainder
	if int64(elapsed) > maxCaptureClockNanos-int64(roundUp) {
		return 0, errCaptureClockInvalid
	}
	return elapsed + roundUp, nil
}
