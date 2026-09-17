// ABOUTME: Proves the X01 macOS poller offers opaque intents and acks only settled outcomes.
// ABOUTME: The bridge path runs through the real app bridge with a synthetic app peer.

package notify

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/appbridge"
	"github.com/qdis/bfb/internal/daemon"
)

// The production bridge satisfies the poller interface without an adapter.
var _ Notifier = (*appbridge.Bridge)(nil)

const deliveryA = "01JX01MAC0S000000000000001"
const deliveryB = "01JX01MAC0S000000000000002"

type fakeConnection struct {
	mu       sync.Mutex
	pulls    int
	pullBody []byte
	pullErr  error
	acks     [][]string
	ackErr   error
}

func (fake *fakeConnection) pullCount() int {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return fake.pulls
}

func (fake *fakeConnection) Request(_ context.Context, _, action string, body []byte) ([]byte, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	switch action {
	case pullAction:
		fake.pulls++
		if fake.pullErr != nil {
			return nil, fake.pullErr
		}
		return fake.pullBody, nil
	case ackAction:
		var decoded struct {
			IDs []string `json:"delivery_ids"`
		}
		if strictJSON(body, &decoded) != nil {
			return nil, context.DeadlineExceeded
		}
		fake.acks = append(fake.acks, decoded.IDs)
		if fake.ackErr != nil {
			return nil, fake.ackErr
		}
		acked, _ := json.Marshal(map[string]any{"schema_version": 1, "acked": len(decoded.IDs)})
		return acked, nil
	default:
		return nil, context.DeadlineExceeded
	}
}

type fakeNotifier struct {
	mu      sync.Mutex
	offered []string
	codes   map[string]string
}

func (fake *fakeNotifier) NotifyAttention(_ context.Context, notificationID string) error {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.offered = append(fake.offered, notificationID)
	if code, ok := fake.codes[notificationID]; ok && code != "" {
		return &daemon.Failure{Code: code}
	}
	return nil
}

func pullBody(t *testing.T, ids ...string) []byte {
	t.Helper()
	deliveries := make([]map[string]string, 0, len(ids))
	for _, id := range ids {
		deliveries = append(deliveries, map[string]string{"delivery_id": id})
	}
	body, err := json.Marshal(map[string]any{"schema_version": 1, "deliveries": deliveries})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func serviceFor(connection *fakeConnection, notifier Notifier) *Service {
	return &Service{
		Connections: func(string) (Connection, error) { return connection, nil },
		Enrollments: func(context.Context) ([]Enrollment, error) {
			return []Enrollment{{RunnerID: "runner-x01"}}, nil
		},
		Notifier: notifier,
		Interval: time.Millisecond,
	}
}

func TestPollOffersAndAcksDelivered(t *testing.T) {
	connection := &fakeConnection{pullBody: pullBody(t, deliveryA, deliveryB)}
	notifier := &fakeNotifier{}
	service := serviceFor(connection, notifier)
	if err := service.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(notifier.offered) != 2 || notifier.offered[0] != deliveryA || notifier.offered[1] != deliveryB {
		t.Fatalf("unexpected offers: %#v", notifier.offered)
	}
	if len(connection.acks) != 1 || len(connection.acks[0]) != 2 {
		t.Fatalf("unexpected acks: %#v", connection.acks)
	}
}

func TestDeniedAcksWhileTransientStaysUnacked(t *testing.T) {
	connection := &fakeConnection{pullBody: pullBody(t, deliveryA, deliveryB)}
	notifier := &fakeNotifier{codes: map[string]string{
		deliveryA: "notification_denied",
		deliveryB: "app_unavailable",
	}}
	service := serviceFor(connection, notifier)
	if err := service.PollOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(connection.acks) != 1 || len(connection.acks[0]) != 1 || connection.acks[0][0] != deliveryA {
		t.Fatalf("only the denied intent acks: %#v", connection.acks)
	}
}

func TestInvalidDeliveryIDOffersNothing(t *testing.T) {
	connection := &fakeConnection{pullBody: pullBody(t, "not-a-ulid")}
	notifier := &fakeNotifier{}
	service := serviceFor(connection, notifier)
	if err := service.PollOnce(context.Background()); err == nil {
		t.Fatal("expected an invalid delivery id to fail the poll")
	}
	if len(notifier.offered) != 0 || len(connection.acks) != 0 {
		t.Fatalf("invalid rows must not reach the bridge: %#v %#v", notifier.offered, connection.acks)
	}
}

func TestUnknownPullFieldsRejected(t *testing.T) {
	connection := &fakeConnection{pullBody: []byte(`{"schema_version":1,"deliveries":[],"extra":1}`)}
	service := serviceFor(connection, &fakeNotifier{})
	if err := service.PollOnce(context.Background()); err == nil {
		t.Fatal("expected unknown pull fields to fail closed")
	}
}

func TestUnconfiguredServiceStaysIdle(t *testing.T) {
	service := &Service{}
	if err := service.PollOnce(context.Background()); err == nil {
		t.Fatal("expected PollOnce to refuse an unconfigured service")
	}
	stop := service.Start(context.Background())
	stop()
}

func TestServiceStartPollsUntilStopped(t *testing.T) {
	connection := &fakeConnection{pullBody: pullBody(t)}
	service := serviceFor(connection, &fakeNotifier{})
	ctx, cancel := context.WithCancel(context.Background())
	stop := service.Start(ctx)
	deadline := time.Now().Add(5 * time.Second)
	for connection.pullCount() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	stop()
	if connection.pullCount() == 0 {
		t.Fatal("expected the service loop to poll at least once")
	}
}
