// ABOUTME: Tests bounded wake redemption against durable enrollments without issuing a local intent or command.
// ABOUTME: Covers replay, binding confusion, revocation, malformed receipts and cancellation at the cloud boundary.

package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/runner"
)

func wakeFixture(t *testing.T, count int) (*Service, *daemon.Store, []runner.Enrollment) {
	t.Helper()
	store, local, claim, _ := fixtureIntents(t)
	known := make([]runner.Enrollment, 0, count)
	for index := range count {
		enrollment, err := runner.NewStore(local.DB).Begin(context.Background(), fmt.Sprintf("https://synthetic-%d.example.test", index), claim.Assignment.WorkspaceId, "Synthetic wake")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = local.DB.Exec(`UPDATE runner_enrollments SET token_epoch = 1, key_thumbprint = ?, connection_state = 'online' WHERE id = ?`, "sha256:"+strings.Repeat("a", 64), enrollment.RunnerID); err != nil {
			t.Fatal(err)
		}
		enrollment, err = runner.NewStore(local.DB).Get(context.Background(), enrollment.RunnerID)
		if err != nil {
			t.Fatal(err)
		}
		known = append(known, enrollment)
	}
	service := NewService(ServiceOptions{})
	service.store = store
	close(service.ready)
	return service, local, known
}

func TestWakeRedemptionOnlyPullsTheBoundEnrollmentAndNeverPersistsHint(t *testing.T) {
	service, local, known := wakeFixture(t, 3)
	wakeID, launchID := daemon.NewRequestID(), daemon.NewRequestID()
	var requests atomic.Int32
	var consumed atomic.Bool
	woken := ""
	service.options.Connection = func(id string) (runner.RunnerConnection, error) {
		return &finalConnection{request: func(_ context.Context, method, path string, body []byte) ([]byte, error) {
			requests.Add(1)
			var payload generated.LaunchWakeRedemption
			if method != "POST" || path != "wake/redeem" || json.Unmarshal(body, &payload) != nil || payload.SchemaVersion != 1 || payload.WakeIntentId != wakeID {
				t.Error("wake performed an unexpected operation")
			}
			if id != known[1].RunnerID || consumed.Swap(true) {
				return nil, errors.New("synthetic secret failure")
			}
			return json.Marshal(map[string]string{"runner_id": id, "launch_id": launchID})
		}}, nil
	}
	service.options.WakeRunner = func(id string) error { woken = id; return nil }
	if err := service.Wake(context.Background(), wakeID); err != nil || requests.Load() != 3 || woken != known[1].RunnerID {
		t.Fatal("valid wake failed", err, requests.Load(), woken)
	}
	woken = ""
	if err := service.Wake(context.Background(), wakeID); daemon.AsFailure(err).Code != "execution_authorization_failed" || woken != "" {
		t.Fatal("replayed hint reconnected an enrollment", err)
	}
	for _, table := range []string{"execution_commands", "local_execution_assignments", "runner_command_inbox"} {
		var count int
		if err := local.DB.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != 0 {
			t.Fatal("wake persisted command or launch state", table, count, err)
		}
	}
}

func TestWakeRedemptionRejectsFaultsWithoutNativeEffects(t *testing.T) {
	for _, fault := range []string{"unknown", "wrong_runner", "ambiguous", "revoked_before", "revoked_during", "offline", "wake_failed", "cancelled", "malformed", "no_connection", "no_wake"} {
		t.Run(fault, func(t *testing.T) {
			service, local, known := wakeFixture(t, 2)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var effects atomic.Int32
			service.options.WakeRunner = func(string) error {
				if fault == "wake_failed" {
					return errors.New("synthetic private failure")
				}
				effects.Add(1)
				return nil
			}
			service.options.Connection = func(id string) (runner.RunnerConnection, error) {
				if fault == "offline" {
					return nil, runner.ErrOffline
				}
				return &finalConnection{request: func(_ context.Context, _, _ string, _ []byte) ([]byte, error) {
					if fault == "unknown" || (id != known[0].RunnerID && fault != "ambiguous") {
						return nil, runner.ErrAuthorization
					}
					if fault == "revoked_during" {
						if err := runner.NewStore(local.DB).SetState(ctx, id, "revoked"); err != nil {
							t.Error(err)
						}
					}
					if fault == "cancelled" {
						cancel()
					}
					if fault == "wrong_runner" {
						id = daemon.NewRequestID()
					}
					if fault == "malformed" {
						return []byte(`{"runner_id":"synthetic-private"}`), nil
					}
					return json.Marshal(map[string]string{"runner_id": id, "launch_id": daemon.NewRequestID()})
				}}, nil
			}
			if fault == "revoked_before" {
				if err := runner.NewStore(local.DB).SetState(ctx, known[0].RunnerID, "revoked"); err != nil {
					t.Fatal(err)
				}
			}
			if fault == "no_connection" {
				service.options.Connection = nil
			}
			if fault == "no_wake" {
				service.options.WakeRunner = nil
			}
			if err := service.Wake(ctx, daemon.NewRequestID()); daemon.AsFailure(err).Code != "execution_authorization_failed" || effects.Load() != 0 {
				t.Fatal("unsafe wake effect", err, effects.Load())
			}
		})
	}
}

func TestWakeRedemptionHasOneBoundedBatchAndJoinsCancellation(t *testing.T) {
	service, _, _ := wakeFixture(t, 16)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered := make(chan struct{}, 16)
	var active atomic.Int32
	service.options.Connection = func(string) (runner.RunnerConnection, error) {
		return &finalConnection{request: func(ctx context.Context, _, _ string, _ []byte) ([]byte, error) {
			deadline, ok := ctx.Deadline()
			if !ok || time.Until(deadline) > finalRequestLimit {
				t.Error("wake request has no bounded deadline")
			}
			active.Add(1)
			defer active.Add(-1)
			entered <- struct{}{}
			<-ctx.Done()
			return nil, ctx.Err()
		}}, nil
	}
	service.options.WakeRunner = func(string) error { t.Error("cancelled wake effect"); return nil }
	done := make(chan error, 1)
	go func() { done <- service.Wake(ctx, daemon.NewRequestID()) }()
	for range 16 {
		select {
		case <-entered:
		case <-time.After(2 * time.Second):
			t.Fatal("bounded batch failed to enter its known connections")
		}
	}
	if err := service.Wake(ctx, daemon.NewRequestID()); daemon.AsFailure(err).Code != "execution_authorization_failed" || active.Load() != 16 {
		t.Fatal("another batch escaped the gate", err, active.Load())
	}
	cancel()
	select {
	case err := <-done:
		if err == nil || active.Load() != 0 {
			t.Fatal("cancellation did not join all requests", err, active.Load())
		}
	case <-time.After(time.Second):
		t.Fatal("wake did not honor cancellation")
	}
}

func TestWakeRejectsLocalIntentAndMalformedHintBeforeConnections(t *testing.T) {
	service := NewService(ServiceOptions{
		Connection: func(string) (runner.RunnerConnection, error) {
			t.Error("invalid hint reached connection")
			return nil, runner.ErrOffline
		},
		WakeRunner: func(string) error { t.Error("invalid hint woke runner"); return nil },
	})
	for _, hint := range []string{"", "00000000-0000-4000-8000-000000000001", "synthetic-private", daemon.NewRequestID() + "\n"} {
		if err := service.Wake(context.Background(), hint); daemon.AsFailure(err).Code != "invalid_request" {
			t.Fatal("malformed hint accepted", err)
		}
	}
}

func TestWakeReceiptRejectsConfusedOrAdditionalAuthority(t *testing.T) {
	id := daemon.NewRequestID()
	valid := fmt.Sprintf(`{"launch_id":%q,"runner_id":%q}`, id, id)
	if !validWakeReceipt([]byte(valid), id) {
		t.Fatal("valid hint rejected")
	}
	for _, data := range []string{
		"", "null", "[]", "{}", valid + "{}", valid + "junk", strings.Repeat(" ", 1025) + valid,
		fmt.Sprintf(`{"launch_id":%q,"runner_id":%q,"runner_id":%q}`, id, id, id),
		fmt.Sprintf(`{"launch_id":%q,"runner_id":%q,"argv":[]}`, id, id),
		fmt.Sprintf(`{"launch_id":null,"runner_id":%q}`, id),
		fmt.Sprintf(`{"launch_id":%q,"runner_id":false}`, id),
		fmt.Sprintf(`{"launch_id":%q,"launch_id":%q}`, id, id),
		fmt.Sprintf(`{"launch_id":"00000000-0000-4000-8000-000000000001","runner_id":%q}`, id),
		fmt.Sprintf(`{"launch_id":%q,"runner_id":%q}`, id, daemon.NewRequestID()),
	} {
		if validWakeReceipt([]byte(data), id) {
			t.Fatal("confused wake receipt accepted")
		}
	}
}
