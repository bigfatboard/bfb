// ABOUTME: Exercises run controls through a real private socket, native process groups and held authenticated locks.
// ABOUTME: Proves fresh authorization, exact helper targeting, one-way delivery and restart uncertainty without Terminal acceptance claims.

package supervisor

import (
	"context"
	"encoding/json"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/runner"
)

type signalRPCFixture struct {
	store      *IntentStore
	local      *daemon.Store
	service    *Service
	assignment LocalAssignment
	wire       generated.LocalExecutionAssignment
	lock       *WorktreeLock
	command    LocalCommand
	receipt    generated.RunControlResult
	clock      atomic.Int64
	claims     atomic.Int32
	connection *finalConnection
}

func fixtureSignalRPC(t *testing.T, action string) *signalRPCFixture {
	t.Helper()
	ctx := context.Background()
	store, local, claim, now := fixtureIntents(t)
	assignment := issueFixture(t, store, claim, now)
	if _, err := store.Offer(ctx, assignment.IntentID); err != nil {
		t.Fatal(err)
	}
	table, err := InspectProcesses()
	if err != nil {
		t.Fatal(err)
	}
	owner := SupervisorIdentity{Process: table[os.Getpid()], ExecutableHash: provider.Hash(nil)}
	assignment, err = store.Register(ctx, assignment.IntentID, owner, now)
	if err != nil {
		t.Fatal(err)
	}
	wire, err := assignment.wire()
	if err != nil {
		t.Fatal(err)
	}
	files, err := OpenAssignmentFiles(local.Paths.Root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = files.Close() })
	locks, err := OpenLockStore(worktreeLocksPath(local.Paths))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = locks.Close() })
	lock, err := locks.Acquire(assignment.lockBinding())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lock.Close() })
	child := ownedGateTestChild(t)
	if err := lock.Attach(child); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PinOwnership(ctx, assignment.IntentID, owner, lock.record.LockID, nil, now); err != nil {
		t.Fatal(err)
	}
	assignment, err = store.PinOwnership(ctx, assignment.IntentID, owner, lock.record.LockID, &child, now)
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Hour) // Runtime controls do not reuse an expired launch authorization.
	ref := runner.CommandReference{ID: daemon.NewRequestID(), Kind: "run_control", ExpiresAt: localTimestamp(now.Add(2 * time.Minute))}
	if err := store.Accept(ctx, runner.Enrollment{RunnerID: claim.Assignment.RunnerId, WorkspaceID: claim.Assignment.WorkspaceId}, ref, now); err != nil {
		t.Fatal(err)
	}
	command, err := store.Command(ctx, claim.Assignment.RunnerId, ref.ID)
	if err != nil {
		t.Fatal(err)
	}
	f := &signalRPCFixture{store: store, local: local, assignment: assignment, wire: wire, lock: lock, command: command,
		receipt: generated.RunControlResult{SchemaVersion: 1, ControlId: ref.ID, RunExecutionId: claim.Assignment.RunExecutionId, AssignmentGeneration: claim.Assignment.AssignmentGeneration, RunnerId: command.RunnerID, Action: action, State: "claimed", ExpiresAt: ref.ExpiresAt}}
	f.clock.Store(now.UnixNano())
	f.connection = &finalConnection{request: func(ctx context.Context, method, path string, data []byte) ([]byte, error) {
		f.claims.Add(1)
		var request generated.RunControlClaim
		if method != "POST" || path != "controls/claim" || json.Unmarshal(data, &request) != nil || request.ControlId != command.ID || request.IdempotencyKey != command.ClaimKey || request.Action != action || request.RunExecutionId != claim.Assignment.RunExecutionId || request.AssignmentGeneration != claim.Assignment.AssignmentGeneration {
			t.Error("control claim did not use the original binding")
			return nil, failure("invalid_request")
		}
		return json.Marshal(f.receipt)
	}}
	f.service = NewService(ServiceOptions{
		Now: func() time.Time { return time.Unix(0, f.clock.Load()).UTC() },
		InspectHelper: func(peer daemon.Peer) (SupervisorIdentity, error) {
			table, err := InspectProcesses()
			process, exists := table[peer.PID]
			if err != nil || !exists || process.UID != peer.UID || process.Zombie {
				return SupervisorIdentity{}, failure("peer_denied")
			}
			// Only signature verification is injected. Kernel peer identity,
			// process start, parent/group, HMAC records, flock and SQLite are real.
			return SupervisorIdentity{Process: process, ExecutableHash: provider.Hash(nil)}, nil
		},
		Connection: func(id string) (runner.RunnerConnection, error) {
			if id != command.RunnerID {
				return nil, runner.ErrOffline
			}
			return f.connection, nil
		},
	})
	f.service.store, f.service.files, f.service.paths = store, files, local.Paths
	close(f.service.ready)
	registry := daemon.NewRegistry()
	// Isolate the RPC from observer/lease workers; their independent runtime
	// and shared control queue are covered by their own integration tests.
	if err := registry.Register("execution.control", f.service.pollControl); err != nil {
		t.Fatal(err)
	}
	if err := registry.Register("execution.control_result", f.service.recordControl); err != nil {
		t.Fatal(err)
	}
	server, err := daemon.Start(ctx, local.Paths, registry)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Close)
	metadata := f.receipt
	metadata.State = "pending"
	if _, err := store.rememberControl(ctx, command, metadata); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *signalRPCFixture) poll() (generated.LocalRpcEnvelope, error) {
	return daemon.Call(context.Background(), f.local.Paths, "execution.control", map[string]any{"terminal_intent_id": f.assignment.IntentID})
}

func (f *signalRPCFixture) result(disposition string) error {
	_, err := daemon.Call(context.Background(), f.local.Paths, "execution.control_result", map[string]any{"terminal_intent_id": f.assignment.IntentID, "control_id": f.command.ID, "control_disposition": disposition})
	return err
}

func TestControlRPCBoundDeliveryAndIdempotentResults(t *testing.T) {
	for _, action := range []string{"interrupt", "terminate", "cancel"} {
		t.Run(action, func(t *testing.T) {
			f := fixtureSignalRPC(t, action)
			if err := f.result("applied"); err == nil {
				t.Fatal("unstarted result accepted")
			}
			reply, err := f.poll()
			if err != nil {
				t.Fatal(err)
			}
			now := f.service.options.Now()
			control, err := decodeHelperControl(reply.Payload, f.wire, now, now)
			if err != nil || control == nil || control.Action != action || control.ControlId != f.command.ID {
				t.Fatal("bound control missing", err)
			}
			effect, err := f.store.control(context.Background(), f.command)
			if err != nil || effect.State != "applying" || effect.StartedAt != control.AuthorizedAt {
				t.Fatal("reply preceded durable delivery", err)
			}
			observation, err := f.lock.Observe()
			if err != nil || observation.State != "live" {
				t.Fatal("daemon performed a native effect", err)
			}
			for range 2 {
				if reply, err := f.poll(); err != nil || len(reply.Payload) != 0 {
					t.Fatal("duplicate delivered again", err)
				}
			}
			if f.claims.Load() != 1 {
				t.Fatal("in-flight delivery reclaimed authority")
			}
			// Result authentication must still work after the group has ended.
			killFixture(t, *f.assignment.Group)
			awaitAbsent(t, f.assignment.Group.PID)
			for range 2 {
				if err := f.result("applied"); err != nil {
					t.Fatal("original helper could not acknowledge", err)
				}
			}
			if err := f.result("local_rejected"); err == nil {
				t.Fatal("result was rewritten")
			}
		})
	}
}

func TestControlRPCRejectsAuthorizationAndNativeChanges(t *testing.T) {
	for _, fault := range []string{"offline", "pending", "wrong_target", "wrong_action", "slow", "backwards", "expired", "owner_changed", "group_gone", "history_unknown", "lock_released"} {
		t.Run(fault, func(t *testing.T) {
			f := fixtureSignalRPC(t, "interrupt")
			original := f.connection.request
			f.connection.request = func(ctx context.Context, method, path string, body []byte) ([]byte, error) {
				data, err := original(ctx, method, path, body)
				receipt := f.receipt
				switch fault {
				case "offline":
					return nil, runner.ErrOffline
				case "pending":
					receipt.State = "pending"
				case "wrong_target":
					receipt.RunExecutionId = daemon.NewRequestID()
				case "wrong_action":
					receipt.Action = "terminate"
				case "slow":
					f.clock.Add(int64(6 * time.Second))
				case "backwards":
					f.clock.Add(-int64(time.Second))
				case "expired":
					f.clock.Add(int64(3 * time.Minute))
				case "owner_changed":
					f.service.options.InspectHelper = func(daemon.Peer) (SupervisorIdentity, error) { return SupervisorIdentity{}, failure("peer_denied") }
				case "group_gone", "lock_released":
					killFixture(t, *f.assignment.Group)
					awaitAbsent(t, f.assignment.Group.PID)
					if fault == "lock_released" {
						if err := f.lock.Release(); err != nil {
							t.Error(err)
						}
					}
				case "history_unknown":
					_, err = f.store.rememberNative(ctx, f.assignment, nativeHistory{Uncertain: true})
				}
				if fault == "pending" || fault == "wrong_target" || fault == "wrong_action" {
					return json.Marshal(receipt)
				}
				return data, err
			}
			if reply, err := f.poll(); err == nil || len(reply.Payload) != 0 {
				t.Fatal("unsafe control delivered", err)
			}
			effect, err := f.store.control(context.Background(), f.command)
			if err != nil || effect.State != "prepared" || effect.StartedAt != "" {
				t.Fatal("rejected check began local delivery", err)
			}
		})
	}
}

func TestControlRPCLostReplyCannotReplayAfterRestart(t *testing.T) {
	f := fixtureSignalRPC(t, "interrupt")
	if _, err := f.poll(); err != nil {
		t.Fatal(err)
	}
	if err := f.store.recoverControls(context.Background()); err != nil {
		t.Fatal(err)
	}
	if reply, err := f.poll(); err != nil || len(reply.Payload) != 0 {
		t.Fatal("restart repeated uncertain delivery", err)
	}
	if err := f.result("applied"); err == nil {
		t.Fatal("late reply erased restart uncertainty")
	}
	if f.claims.Load() != 1 {
		t.Fatal("uncertain effect reclaimed online authority")
	}
}

func TestControlRPCConcurrentPollsDeliverOnce(t *testing.T) {
	f := fixtureSignalRPC(t, "interrupt")
	var delivered atomic.Int32
	var workers sync.WaitGroup
	for range 8 {
		workers.Go(func() {
			reply, err := f.poll()
			if err == nil && len(reply.Payload) == 1 {
				delivered.Add(1)
			}
		})
	}
	workers.Wait()
	if delivered.Load() != 1 {
		t.Fatal("concurrent polls did not have exactly one winner", delivered.Load())
	}
}

func TestControlRPCNonSignalActionsAndTerminalClaimsHaveNoDelivery(t *testing.T) {
	for _, action := range []string{"focus_existing", "resume"} {
		t.Run(action, func(t *testing.T) {
			f := fixtureSignalRPC(t, action)
			if reply, err := f.poll(); err != nil || len(reply.Payload) != 0 || f.claims.Load() != 0 {
				t.Fatal("non-signal action reached helper", err)
			}
		})
	}
	for _, state := range []string{"expired", "rejected"} {
		t.Run(state, func(t *testing.T) {
			f := fixtureSignalRPC(t, "interrupt")
			f.receipt.State = state
			disposition := "authorization_lost"
			if state == "expired" {
				disposition = "expired"
			}
			f.receipt.Disposition = &disposition
			if reply, err := f.poll(); err != nil || len(reply.Payload) != 0 {
				t.Fatal("terminal claim delivered effect", err)
			}
			command, err := f.store.Command(context.Background(), f.command.RunnerID, f.command.ID)
			if err != nil || command.State != "complete" {
				t.Fatal("terminal claim not settled", err)
			}
		})
	}
}

func TestControlRPCAuthenticatesBeforePrivateLookupAndRejectsConfusedResults(t *testing.T) {
	f := fixtureSignalRPC(t, "interrupt")
	request := daemon.Request{Peer: daemon.Peer{UID: os.Getuid(), PID: f.assignment.Group.PID}, Envelope: generated.LocalRpcEnvelope{Payload: map[string]any{"terminal_intent_id": f.assignment.IntentID}}}
	if _, err := f.service.pollControl(context.Background(), request); err == nil || f.claims.Load() != 0 {
		t.Fatal("provider child impersonated supervisor")
	}
	for _, payload := range []map[string]any{
		{"terminal_intent_id": f.assignment.IntentID, "process_group_id": f.assignment.Group.PID},
		{"terminal_intent_id": f.command.ID},
	} {
		request.Envelope.Payload = payload
		if _, err := f.service.pollControl(context.Background(), request); err == nil {
			t.Fatal("malformed poll accepted")
		}
	}
	if _, err := f.poll(); err != nil {
		t.Fatal(err)
	}
	request.Envelope.Payload = map[string]any{"terminal_intent_id": f.assignment.IntentID, "control_id": f.command.ID, "control_disposition": "applied"}
	if _, err := f.service.recordControl(context.Background(), request); err == nil {
		t.Fatal("provider acknowledged helper result")
	}
	request.Peer.PID = os.Getpid()
	request.Envelope.Payload["control_id"] = daemon.NewRequestID()
	if _, err := f.service.recordControl(context.Background(), request); err == nil {
		t.Fatal("wrong control acknowledged")
	}
	request.Envelope.Payload["control_id"] = f.command.ID
	request.Envelope.Payload["signal"] = 9
	if _, err := f.service.recordControl(context.Background(), request); err == nil {
		t.Fatal("supplied signal accepted")
	}
	f.service.options.InspectHelper = func(daemon.Peer) (SupervisorIdentity, error) { return SupervisorIdentity{}, failure("peer_denied") }
	f.service.store = nil
	_, err := f.service.runtimeOwner(context.Background(), request.Peer, f.assignment.IntentID)
	assertFailure(t, err, "peer_denied")
}
