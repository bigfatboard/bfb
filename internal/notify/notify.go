// ABOUTME: Polls macOS notification intents and offers them through the existing app bridge.
// ABOUTME: Acks delivered or denied intents; transient bridge failures stay unacked for retry.

package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"time"

	"github.com/qdis/bfb/internal/daemon"
)

// Connection is the authenticated runner transport the poller reads inbox rows over.
type Connection interface {
	Request(ctx context.Context, method, action string, body []byte) ([]byte, error)
}

// ConnectionFunc returns the live connection for one enrolled runner, or an error when offline.
type ConnectionFunc func(runnerID string) (Connection, error)

// Notifier offers one opaque delivery through the existing native bridge.
type Notifier interface {
	NotifyAttention(ctx context.Context, notificationID string) error
}

// Enrollment is the minimal identity the poller needs to pull one runner's inbox.
type Enrollment struct {
	WorkspaceID string
	RunnerID    string
}

// EnrollmentsFunc lists runners the poller should serve on this Mac.
type EnrollmentsFunc func(ctx context.Context) ([]Enrollment, error)

var deliveryPattern = regexp.MustCompile(`^[0-7][0-9A-HJKMNP-TV-Z]{25}$`)

const (
	pullAction   = "notifications/pull"
	ackAction    = "notifications/ack"
	pullLimit    = 25
	pollInterval = 20 * time.Second
	requestTTL   = 15 * time.Second
)

// Service polls every enrollment and offers new intents to the native bridge.
type Service struct {
	Connections ConnectionFunc
	Enrollments EnrollmentsFunc
	Notifier    Notifier
	Interval    time.Duration
}

type pullResponse struct {
	Version     int    `json:"schema_version"`
	WorkspaceID string `json:"workspace_id"`
	RunnerID    string `json:"runner_id"`
	Deliveries  []struct {
		DeliveryID string `json:"delivery_id"`
	} `json:"deliveries"`
}

type ackResponse struct {
	Version int `json:"schema_version"`
	Acked   int `json:"acked"`
}

func strictJSON(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return errors.New("response must contain exactly one JSON value")
	}
	return nil
}

// PollOnce pulls, offers, and acks for every enrollment. One runner's failure
// never blocks another runner's intents.
func (service *Service) PollOnce(ctx context.Context) error {
	if service.Connections == nil || service.Enrollments == nil || service.Notifier == nil {
		return errors.New("notify service is not configured")
	}
	enrollments, err := service.Enrollments(ctx)
	if err != nil {
		return err
	}
	var failed int
	for _, enrollment := range enrollments {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := service.pollRunner(ctx, enrollment); err != nil {
			failed++
		}
	}
	if failed > 0 && failed == len(enrollments) && len(enrollments) > 0 {
		return errors.New("all notification polls failed")
	}
	return nil
}

func (service *Service) pollRunner(ctx context.Context, enrollment Enrollment) error {
	if !deliveryPattern.MatchString(enrollment.WorkspaceID) || !deliveryPattern.MatchString(enrollment.RunnerID) {
		return errors.New("invalid notification enrollment")
	}
	connection, err := service.Connections(enrollment.RunnerID)
	if err != nil {
		return err
	}
	call, cancel := context.WithTimeout(ctx, requestTTL)
	defer cancel()
	raw, err := connection.Request(call, "POST", pullAction, []byte(`{}`))
	if err != nil {
		return err
	}
	var pulled pullResponse
	if strictJSON(raw, &pulled) != nil || pulled.Version != 1 ||
		pulled.WorkspaceID != enrollment.WorkspaceID || pulled.RunnerID != enrollment.RunnerID ||
		pulled.Deliveries == nil || len(pulled.Deliveries) > pullLimit {
		return errors.New("invalid notification pull response")
	}
	seen := make(map[string]struct{}, len(pulled.Deliveries))
	for _, delivery := range pulled.Deliveries {
		if !deliveryPattern.MatchString(delivery.DeliveryID) {
			return errors.New("invalid notification delivery id")
		}
		if _, duplicate := seen[delivery.DeliveryID]; duplicate {
			return errors.New("duplicate notification delivery id")
		}
		seen[delivery.DeliveryID] = struct{}{}
	}
	acked := make([]string, 0, len(pulled.Deliveries))
	for _, delivery := range pulled.Deliveries {
		offer, cancelOffer := context.WithTimeout(ctx, requestTTL)
		err := service.Notifier.NotifyAttention(offer, delivery.DeliveryID)
		cancelOffer()
		if err == nil || daemon.AsFailure(err).Code == "notification_denied" {
			acked = append(acked, delivery.DeliveryID)
		}
	}
	if len(acked) == 0 {
		return nil
	}
	body, err := json.Marshal(map[string]any{"delivery_ids": acked})
	if err != nil {
		return err
	}
	call, cancel = context.WithTimeout(ctx, requestTTL)
	defer cancel()
	raw, err = connection.Request(call, "POST", ackAction, body)
	if err != nil {
		return err
	}
	var done ackResponse
	if strictJSON(raw, &done) != nil || done.Version != 1 {
		return errors.New("invalid notification ack response")
	}
	return nil
}

// Start polls on the configured cadence until ctx ends. It never starts when
// the service is unconfigured, so existing daemon wiring stays untouched.
func (service *Service) Start(ctx context.Context) func() {
	if service.Connections == nil || service.Enrollments == nil || service.Notifier == nil {
		return func() {}
	}
	interval := service.Interval
	if interval <= 0 {
		interval = pollInterval
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		timer := time.NewTimer(interval)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				_ = service.PollOnce(ctx)
				timer.Reset(interval)
			}
		}
	}()
	return func() { <-done }
}
