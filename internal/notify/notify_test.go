// ABOUTME: Proves the X01 macOS poller offers opaque intents and acks only settled outcomes.
// ABOUTME: The bridge path runs through the real app bridge with a synthetic app peer.

package notify

import (
	"context"
	"encoding/json"
	"fmt"
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
const workspaceID = "01JX01W0RKSPACE00000000001"
const runnerID = "01JX01RVNNER00000000000001"

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
	body, err := json.Marshal(map[string]any{
		"schema_version": 1,
		"workspace_id":   workspaceID,
		"runner_id":      runnerID,
		"deliveries":     deliveries,
	})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func serviceFor(connection *fakeConnection, notifier Notifier) *Service {
	return &Service{
		Connections: func(string) (Connection, error) { return connection, nil },
		Enrollments: func(context.Context) ([]Enrollment, error) {
			return []Enrollment{{WorkspaceID: workspaceID, RunnerID: runnerID}}, nil
		},
		Notifier: notifier,
		Interval: time.Millisecond,
	}
}

func TestProductionPullEnvelopeOffersAndAcksDelivered(t *testing.T) {
	connection := &fakeConnection{pullBody: pullBody(t, deliveryA, deliveryB)}
	notifier := &fakeNotifier{}
	if err := serviceFor(connection, notifier).PollOnce(context.Background()); err != nil {
		t.Fatalf("production-shaped v1 pull response must be accepted: %v", err)
	}
	if len(notifier.offered) != 2 || notifier.offered[0] != deliveryA || notifier.offered[1] != deliveryB {
		t.Fatalf("unexpected offers: %#v", notifier.offered)
	}
	if len(connection.acks) != 1 || len(connection.acks[0]) != 2 || connection.acks[0][0] != deliveryA || connection.acks[0][1] != deliveryB {
		t.Fatalf("production deliveries must be acknowledged by their exact IDs: %#v", connection.acks)
	}
}

func TestProductionPullEnvelopeRejectsUnboundTuple(t *testing.T) {
	for _, test := range []struct {
		name  string
		field string
		value any
	}{
		{name: "missing_workspace", field: "workspace_id"},
		{name: "missing_runner", field: "runner_id"},
		{name: "wrong_workspace", field: "workspace_id", value: deliveryA},
		{name: "wrong_runner", field: "runner_id", value: deliveryB},
		{name: "malformed_workspace", field: "workspace_id", value: 1},
		{name: "malformed_runner", field: "runner_id", value: "not-a-runner-id"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var envelope map[string]any
			if err := json.Unmarshal(pullBody(t, deliveryA), &envelope); err != nil {
				t.Fatal(err)
			}
			if test.value == nil {
				delete(envelope, test.field)
			} else {
				envelope[test.field] = test.value
			}
			body, err := json.Marshal(envelope)
			if err != nil {
				t.Fatal(err)
			}
			connection := &fakeConnection{pullBody: body}
			notifier := &fakeNotifier{}
			if err := serviceFor(connection, notifier).PollOnce(context.Background()); err == nil {
				t.Fatal("an unbound enrollment tuple must fail the poll")
			}
			if len(notifier.offered) != 0 || len(connection.acks) != 0 {
				t.Fatalf("an unbound tuple must have no bridge or acknowledgement effects: %#v %#v", notifier.offered, connection.acks)
			}
		})
	}
}

func TestMalformedDeliveryBatchOffersNothing(t *testing.T) {
	for _, test := range []struct {
		name string
		ids  []string
	}{
		{name: "invalid_later_id", ids: []string{deliveryA, "not-a-ulid"}},
		{name: "duplicate_id", ids: []string{deliveryA, deliveryA}},
	} {
		t.Run(test.name, func(t *testing.T) {
			connection := &fakeConnection{pullBody: pullBody(t, test.ids...)}
			notifier := &fakeNotifier{}
			if err := serviceFor(connection, notifier).PollOnce(context.Background()); err == nil {
				t.Fatal("a malformed delivery batch must fail the poll")
			}
			if len(notifier.offered) != 0 || len(connection.acks) != 0 {
				t.Fatalf("the whole batch must be validated before any offer: %#v %#v", notifier.offered, connection.acks)
			}
		})
	}
}

func TestPullBatchRequiresBoundedArray(t *testing.T) {
	oversized := make([]map[string]string, pullLimit+1)
	for index := range oversized {
		oversized[index] = map[string]string{"delivery_id": fmt.Sprintf("%026d", index+1)}
	}
	for _, test := range []struct {
		name       string
		deliveries any
	}{
		{name: "missing"},
		{name: "null", deliveries: json.RawMessage(`null`)},
		{name: "over_limit", deliveries: oversized},
	} {
		t.Run(test.name, func(t *testing.T) {
			var envelope map[string]any
			if err := json.Unmarshal(pullBody(t, deliveryA), &envelope); err != nil {
				t.Fatal(err)
			}
			if test.deliveries == nil {
				delete(envelope, "deliveries")
			} else {
				envelope["deliveries"] = test.deliveries
			}
			body, err := json.Marshal(envelope)
			if err != nil {
				t.Fatal(err)
			}
			connection := &fakeConnection{pullBody: body}
			notifier := &fakeNotifier{}
			if err := serviceFor(connection, notifier).PollOnce(context.Background()); err == nil {
				t.Fatal("the pull envelope must contain a bounded delivery array")
			}
			if len(notifier.offered) != 0 || len(connection.acks) != 0 {
				t.Fatalf("an invalid batch shape must have no bridge or acknowledgement effects: %#v %#v", notifier.offered, connection.acks)
			}
		})
	}
}

func TestMissingEnrollmentWorkspaceDoesNotConnect(t *testing.T) {
	connection := &fakeConnection{pullBody: pullBody(t, deliveryA)}
	notifier := &fakeNotifier{}
	service := serviceFor(connection, notifier)
	connected := false
	service.Connections = func(string) (Connection, error) {
		connected = true
		return connection, nil
	}
	service.Enrollments = func(context.Context) ([]Enrollment, error) {
		return []Enrollment{{RunnerID: runnerID}}, nil
	}
	if err := service.PollOnce(context.Background()); err == nil {
		t.Fatal("a missing enrollment workspace must fail the poll")
	}
	if connected || len(notifier.offered) != 0 || len(connection.acks) != 0 {
		t.Fatal("an invalid stored enrollment must have no transport or bridge effects")
	}
}

func TestStrictJSONRejectsTrailingValue(t *testing.T) {
	for _, suffix := range []string{` {}`, ` true`} {
		t.Run(suffix, func(t *testing.T) {
			var response ackResponse
			if err := strictJSON([]byte(`{"schema_version":1,"acked":1}`+suffix), &response); err == nil {
				t.Fatal("a response must contain exactly one JSON value")
			}
		})
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
	var envelope map[string]any
	if err := json.Unmarshal(pullBody(t, deliveryA), &envelope); err != nil {
		t.Fatal(err)
	}
	envelope["extra"] = 1
	body, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	connection := &fakeConnection{pullBody: body}
	notifier := &fakeNotifier{}
	service := serviceFor(connection, notifier)
	if err := service.PollOnce(context.Background()); err == nil {
		t.Fatal("expected unknown pull fields to fail closed")
	}
	if len(notifier.offered) != 0 || len(connection.acks) != 0 {
		t.Fatalf("unknown fields must have no bridge or acknowledgement effects: %#v %#v", notifier.offered, connection.acks)
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
