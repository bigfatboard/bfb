// ABOUTME: Tests the control inbox against bounded synthetic cloud receipts without issuing real signals.
// ABOUTME: Covers lost acknowledgements, independent worker capacity and truthful separation of claim from effect.

package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/runner"
)

func controlService(t *testing.T, f *controlFixture, request func(context.Context, string, string, []byte) ([]byte, error)) *Service {
	t.Helper()
	return NewService(ServiceOptions{Now: func() time.Time { return f.now }, Connection: func(id string) (runner.RunnerConnection, error) {
		if id != f.command.RunnerID {
			t.Error("selected a different enrollment")
			return nil, errors.New("wrong enrollment")
		}
		return &finalConnection{request: request}, nil
	}})
}

func TestControlQueueReadsWithoutClaimingOrInventingAnEffect(t *testing.T) {
	for _, action := range []string{"focus_existing", "resume", "interrupt", "terminate", "cancel"} {
		t.Run(action, func(t *testing.T) {
			f := fixtureControl(t, action)
			reads := 0
			service := controlService(t, f, func(_ context.Context, method, path string, body []byte) ([]byte, error) {
				var reference generated.RunControlReference
				if method != "POST" || path != "controls/read" || json.Unmarshal(body, &reference) != nil || reference.ControlId != f.command.ID {
					t.Error("metadata queue tried to claim, signal, resume or acknowledge")
					return nil, errors.New("unexpected request")
				}
				reads++
				return encodedFixture(t, f.receipt), nil
			})
			for range 3 {
				if err := service.processControl(context.Background(), f.store, f.command); err != nil {
					t.Fatal(err)
				}
			}
			current, err := f.store.control(context.Background(), f.command)
			if err != nil || current == nil || current.State != "prepared" || current.StartedAt != "" || current.ResumeLaunchID != "" || reads != 3 {
				t.Fatal("metadata became an effect", err)
			}
			command, _ := f.store.Command(context.Background(), f.command.RunnerID, f.command.ID)
			if command.State == "complete" {
				t.Fatal("read inferred an applied command")
			}
		})
	}
}

func TestControlQueueLostAcknowledgementReconcilesWithoutReclaimOrReplay(t *testing.T) {
	f := fixtureControl(t, "terminate")
	started := f.begin(t)
	if err := f.store.finishControl(context.Background(), started, "applied"); err != nil {
		t.Fatal(err)
	}
	f.receipt.State = "claimed"
	acks := 0
	service := controlService(t, f, func(_ context.Context, method, path string, body []byte) ([]byte, error) {
		if method != "POST" {
			t.Fatal("unexpected method")
		}
		switch path {
		case "controls/read":
			return encodedFixture(t, f.receipt), nil
		case "controls/acknowledge":
			acks++
			var ack generated.RunControlDisposition
			if json.Unmarshal(body, &ack) != nil || ack.ControlId != f.command.ID || ack.IdempotencyKey != started.ClaimKey || ack.RunExecutionId != started.ExecutionID || ack.AssignmentGeneration != started.Generation || ack.Disposition != "applied" {
				t.Fatal("acknowledgement lost original binding or outcome")
			}
			f.receipt.State, f.receipt.Disposition = "applied", new("applied")
			return nil, errors.New("synthetic reply loss after cloud commit")
		default:
			t.Fatal("completed local effect was reclaimed", path)
			return nil, errors.New("unexpected request")
		}
	})
	if err := service.processControl(context.Background(), f.store, f.command); err == nil {
		t.Fatal("lost acknowledgement unexpectedly succeeded")
	}
	command, _ := f.store.Command(context.Background(), f.command.RunnerID, f.command.ID)
	if command.State == "complete" {
		t.Fatal("network loss treated as cloud acknowledgement")
	}
	if err := f.local.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := daemon.OpenStore(context.Background(), f.local.Paths)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	f.store = NewIntentStore(reopened.DB)
	if err := f.store.recoverControls(context.Background()); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := service.processControl(context.Background(), f.store, command); err != nil {
			t.Fatal(err)
		}
	}
	command, _ = f.store.Command(context.Background(), f.command.RunnerID, f.command.ID)
	current, _ := f.store.control(context.Background(), command)
	if command.State != "complete" || current == nil || current.State != "applied" || current.StartedAt != started.StartedAt || acks != 1 {
		t.Fatal("restart replayed or forgot the completed local effect")
	}
}

func TestControlQueueMissingEffectReplyBecomesUnknownWithoutRepeating(t *testing.T) {
	f := fixtureControl(t, "interrupt")
	started := f.begin(t)
	f.now = f.now.Add(2*finalRequestLimit + time.Microsecond)
	f.receipt.State = "claimed"
	acks := 0
	service := controlService(t, f, func(_ context.Context, _, path string, body []byte) ([]byte, error) {
		switch path {
		case "controls/read":
			return encodedFixture(t, f.receipt), nil
		case "controls/acknowledge":
			acks++
			var ack generated.RunControlDisposition
			if json.Unmarshal(body, &ack) != nil || ack.Disposition != "delivery_unknown" || ack.IdempotencyKey != started.ClaimKey {
				t.Fatal("missing helper acknowledgement became success")
			}
			f.receipt.State, f.receipt.Disposition = "rejected", new("delivery_unknown")
			return encodedFixture(t, f.receipt), nil
		default:
			t.Fatal("ambiguous action reclaimed", path)
			return nil, errors.New("unexpected request")
		}
	})
	if err := service.processControl(context.Background(), f.store, f.command); err != nil {
		t.Fatal(err)
	}
	current, _ := f.store.control(context.Background(), f.command)
	if current == nil || current.State != "delivery_unknown" || acks != 1 {
		t.Fatal("missing result did not remain uncertain")
	}
	if err := f.store.finishControl(context.Background(), started, "applied"); err == nil {
		t.Fatal("late result erased acknowledged uncertainty")
	}
}

func TestControlQueueRejectsRetargetingAndClosesExpiredWithoutLocalSuccess(t *testing.T) {
	f := fixtureControl(t, "interrupt")
	prepared := f.prepare(t)
	retarget := true
	claims := 0
	f.now = f.now.Add(120 * time.Second)
	service := controlService(t, f, func(_ context.Context, _, path string, body []byte) ([]byte, error) {
		if path == "controls/read" {
			receipt := f.receipt
			if retarget {
				receipt.Action = "terminate"
			}
			return encodedFixture(t, receipt), nil
		}
		if path != "controls/claim" {
			t.Fatal("unexpected expired-control request", path)
		}
		claims++
		want, _ := prepared.claimRequest()
		if string(want) != string(body) {
			t.Fatal("expiry cleanup changed original claim")
		}
		f.receipt.State, f.receipt.Disposition = "expired", new("expired")
		return encodedFixture(t, f.receipt), nil
	})
	if err := service.processControl(context.Background(), f.store, f.command); err == nil || claims != 0 {
		t.Fatal("changed target reached a cloud claim")
	}
	retarget = false
	if err := service.processControl(context.Background(), f.store, f.command); err != nil {
		t.Fatal(err)
	}
	command, _ := f.store.Command(context.Background(), f.command.RunnerID, f.command.ID)
	current, _ := f.store.control(context.Background(), f.command)
	if claims != 1 || command.State != "complete" || current == nil || *current != prepared {
		t.Fatal("expiry invented a local result or reopened delivery")
	}
}

func TestControlWorkerCapacityIsIndependentOfBlockedLaunches(t *testing.T) {
	f := fixtureControl(t, "interrupt")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	service := NewService(ServiceOptions{Connection: func(string) (runner.RunnerConnection, error) { return nil, nil }})
	// Fill all launch workers with the same bounded waiting operation used by
	// provider preparation. The actual control worker must still reach C09.
	launchStarted := make(chan struct{}, 4)
	for range 3 {
		err := f.store.Accept(ctx, runner.Enrollment{RunnerID: f.command.RunnerID, WorkspaceID: f.command.WorkspaceID}, runner.CommandReference{ID: daemon.NewRequestID(), Kind: "launch", ExpiresAt: f.command.ExpiresAt}, f.now)
		if err != nil {
			t.Fatal(err)
		}
	}
	controlRead := make(chan struct{}, 1)
	service.options.Now = func() time.Time { return f.now }
	service.options.Connection = func(string) (runner.RunnerConnection, error) {
		return &finalConnection{request: func(_ context.Context, _, path string, _ []byte) ([]byte, error) {
			if path != "controls/read" {
				return nil, errors.New("unexpected control effect")
			}
			select {
			case controlRead <- struct{}{}:
			default:
			}
			return encodedFixture(t, f.receipt), nil
		}}, nil
	}
	var workers sync.WaitGroup
	workers.Go(func() {
		service.runCommands(ctx, f.store, "launch", service.wake, time.Minute, time.Second, time.Minute, func(ctx context.Context, _ LocalCommand) error {
			launchStarted <- struct{}{}
			<-ctx.Done()
			return ctx.Err()
		})
	})
	for range 4 {
		select {
		case <-launchStarted:
		case <-time.After(5 * time.Second):
			cancel()
			workers.Wait()
			t.Fatal("launch lane did not fill")
		}
	}
	workers.Go(func() { service.runControlQueue(ctx, f.store) })
	select {
	case <-controlRead:
	case <-time.After(5 * time.Second):
		cancel()
		workers.Wait()
		t.Fatal("blocked launches starved existing execution control")
	}
	cancel()
	workers.Wait()
}
