// ABOUTME: Exercises gate RPCs through a real private socket, durable SQLite and held native worktree locks.
// ABOUTME: Rejects stale authorization and confused process bindings while preserving lost-response ownership.

package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/runner"
)

type finalConnection struct {
	request func(context.Context, string, string, []byte) ([]byte, error)
}

func (*finalConnection) Renew(context.Context, int64) error { return errors.New("unexpected renewal") }
func (*finalConnection) Open(context.Context) (*websocket.Conn, error) {
	return nil, errors.New("unexpected channel")
}
func (*finalConnection) Credential() (int64, time.Time) { return 0, time.Time{} }
func (connection *finalConnection) Request(ctx context.Context, method, path string, body []byte) ([]byte, error) {
	return connection.request(ctx, method, path, body)
}

type gateRPCFixture struct {
	store      *IntentStore
	local      *daemon.Store
	service    *Service
	assignment generated.LocalExecutionAssignment
	lock       *WorktreeLock
	now        time.Time
	connection *finalConnection
	requests   atomic.Int32
}

func finalFixture(t *testing.T) *gateRPCFixture {
	t.Helper()
	store, local, claim, now := fixtureIntents(t)
	issued := issueFixture(t, store, claim, now)
	if offered, err := store.Offer(context.Background(), issued.IntentID); err != nil || !offered {
		t.Fatal("offer", err)
	}
	fixture := &gateRPCFixture{store: store, local: local, now: now}
	fixture.connection = &finalConnection{request: func(ctx context.Context, method, path string, body []byte) ([]byte, error) {
		fixture.requests.Add(1)
		var request generated.LaunchFinalRequest
		if json.Unmarshal(body, &request) != nil || method != "POST" || path != "launch/authorize" || request != finalRequest(fixture.assignment, fixture.lock.record.LockID) {
			t.Errorf("cloud request did not derive the stored assignment: %s %s", method, path)
			return nil, failure("invalid_request")
		}
		stored, err := store.ByIntent(ctx, issued.IntentID)
		if err != nil || stored.LockID != request.LocalLockId || stored.Supervisor == nil || stored.Supervisor.wire() != request.Supervisor {
			t.Error("network request preceded durable lock pin")
			return nil, failure("storage_failed")
		}
		return json.Marshal(fixture.authorized())
	}}
	service := NewService(ServiceOptions{
		Now: func() time.Time { return fixture.now },
		InspectHelper: func(peer daemon.Peer) (SupervisorIdentity, error) {
			table, err := InspectProcesses()
			process, exists := table[peer.PID]
			if err != nil || !exists || process.UID != peer.UID || process.Zombie {
				return SupervisorIdentity{}, failure("peer_denied")
			}
			// Only the signing boundary is compiled-test injected; PID/start,
			// parent/group, flock, persistence and socket identity are native.
			return SupervisorIdentity{Process: process, ExecutableHash: "sha256:" + strings.Repeat("a", 64)}, nil
		},
		Connection: func(id string) (runner.RunnerConnection, error) {
			if id != claim.Assignment.RunnerId {
				t.Error("wrong enrollment selected")
				return nil, runner.ErrOffline
			}
			return fixture.connection, nil
		},
	})
	fixture.service = service
	files, err := OpenAssignmentFiles(local.Paths.Root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = files.Close() })
	service.store, service.files, service.paths = store, files, local.Paths
	close(service.ready)
	registry := daemon.NewRegistry()
	// This fixture owns only gate RPC I/O. Starting background maintenance
	// against its authorization-only transport races unrelated reconcile
	// requests into the fault counters. Worker integration has separate gates.
	for method, handler := range map[string]daemon.Handler{
		"execution.register":  service.register,
		"execution.authorize": service.authorize,
		"execution.group":     service.recordGroup,
	} {
		if err := registry.Register(method, handler); err != nil {
			t.Fatal(err)
		}
	}
	server, err := daemon.Start(context.Background(), local.Paths, registry)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Close)
	reply, err := daemon.Call(context.Background(), local.Paths, "execution.register", map[string]any{"terminal_intent_id": issued.IntentID})
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(reply.Payload["execution_assignment"])
	if err := json.Unmarshal(data, &fixture.assignment); err != nil {
		t.Fatal(err)
	}
	locks, err := OpenLockStore(worktreeLocksPath(local.Paths))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = locks.Close() })
	fixture.lock, err = locks.Acquire(LockBinding{ExecutionID: claim.Assignment.RunExecutionId, AssignmentGeneration: claim.Assignment.AssignmentGeneration, FencingGeneration: claim.FencingGeneration, PhysicalWorktreeHash: claim.Snapshot.PhysicalWorktreeHash})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = fixture.lock.Close() })
	return fixture
}

func (fixture *gateRPCFixture) authorized() generated.FinalAuthorization {
	claim := fixture.assignment.Claim
	return generated.FinalAuthorization{SchemaVersion: 1, LaunchId: claim.Specification.LaunchId, RunExecutionId: claim.Assignment.RunExecutionId, AssignmentGeneration: claim.Assignment.AssignmentGeneration, Decision: "authorized", AuthorizedAt: localTimestamp(fixture.now)}
}

func (fixture *gateRPCFixture) payload() map[string]any {
	return map[string]any{"terminal_intent_id": fixture.assignment.TerminalIntentId, "local_lock_id": fixture.lock.record.LockID}
}

func (fixture *gateRPCFixture) call(method string, payload map[string]any) (generated.LocalRpcEnvelope, error) {
	return daemon.Call(context.Background(), fixture.local.Paths, method, payload)
}

func ownedGateTestChild(t *testing.T) Process {
	t.Helper()
	command := exec.Command("/bin/sleep", "30")
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	// This direct child has no descendants and is never reaped before cleanup.
	t.Cleanup(func() { _ = command.Process.Kill(); _ = command.Wait() })
	table, err := InspectProcesses()
	child := table[command.Process.Pid]
	if err != nil || child.PID != child.GroupID || child.ParentPID != os.Getpid() {
		t.Fatal("native test group missing", err)
	}
	return child
}

func TestGateRPCCommitsOwnershipAndReauthorizesEveryRequest(t *testing.T) {
	fixture := finalFixture(t)
	for range 2 {
		reply, err := fixture.call("execution.authorize", fixture.payload())
		if err != nil || len(reply.Payload) != 1 {
			t.Fatal("initial authorization", err)
		}
		data, _ := json.Marshal(reply.Payload["final_authorization"])
		if _, err := decodeFinalAuthorization(data, finalRequest(fixture.assignment, fixture.lock.record.LockID), fixture.now, fixture.now); err != nil {
			t.Fatal(err)
		}
	}
	if fixture.requests.Load() != 2 {
		t.Fatal("duplicate authorization reused a cached grant")
	}
	child := ownedGateTestChild(t)
	if err := fixture.lock.Attach(child); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.call("execution.authorize", fixture.payload()); err == nil {
		t.Fatal("authorization bypassed durable group registration")
	}
	payload := fixture.payload()
	payload["process_group_id"] = child.GroupID
	for range 2 {
		reply, err := fixture.call("execution.group", payload)
		if err != nil || len(reply.Payload) != 0 {
			t.Fatal("group registration", err)
		}
		stored, err := fixture.store.ByIntent(context.Background(), fixture.assignment.TerminalIntentId)
		if err != nil || stored.Group == nil || *stored.Group != child || stored.State != "group_ready" || stored.LockID != fixture.lock.record.LockID {
			t.Fatal("reply preceded native group commit", err)
		}
	}
	if _, err := fixture.call("execution.authorize", fixture.payload()); err != nil || fixture.requests.Load() != 3 {
		t.Fatal("second-stage final authorization", err)
	}
	if _, err := fixture.call("execution.register", map[string]any{"terminal_intent_id": fixture.assignment.TerminalIntentId}); err == nil {
		t.Fatal("registered group reopened bootstrap registration")
	}
}

func TestGateRPCRechecksNativeHistoryAfterOnlineAuthorization(t *testing.T) {
	fixture := finalFixture(t)
	fixture.connection.request = func(ctx context.Context, method, path string, body []byte) ([]byte, error) {
		fixture.requests.Add(1)
		assignment, err := fixture.store.ByIntent(ctx, fixture.assignment.TerminalIntentId)
		if err != nil {
			return nil, err
		}
		// Retention can succeed even when the event sink cannot create a
		// detached event. Assignment state alone cannot authorize this reply.
		if _, err := fixture.store.rememberNative(ctx, assignment, nativeHistory{Uncertain: true}); err != nil {
			return nil, err
		}
		return json.Marshal(fixture.authorized())
	}
	if _, err := fixture.call("execution.authorize", fixture.payload()); err == nil || fixture.requests.Load() != 1 {
		t.Fatal("online reply ignored newly retained native uncertainty", err)
	}
	if _, err := fixture.call("execution.authorize", fixture.payload()); err == nil || fixture.requests.Load() != 1 {
		t.Fatal("uncertain history allowed another online authorization", err)
	}
}

func TestGateRPCRejectsUnverifiedOwnershipBeforeCloud(t *testing.T) {
	for _, fault := range []string{"wrong_lock", "wrong_intent", "extra_pid", "expired", "ended", "unsigned", "reused_parent", "other_parent", "lock_closed", "lock_changed", "group_without_pin", "wrong_group", "wrong_child_build", "reused_child"} {
		t.Run(fault, func(t *testing.T) {
			fixture := finalFixture(t)
			payload, method := fixture.payload(), "execution.authorize"
			inspect := fixture.service.options.InspectHelper
			switch fault {
			case "wrong_lock":
				payload["local_lock_id"] = daemon.NewRequestID()
			case "wrong_intent":
				payload["terminal_intent_id"] = "00000000-0000-4000-8000-000000000001"
			case "extra_pid":
				payload["daemon_pid"] = os.Getpid()
			case "expired":
				fixture.now = fixture.now.Add(2 * time.Minute)
			case "ended":
				if _, err := fixture.store.db.Exec("UPDATE local_execution_assignments SET state = 'ended'"); err != nil {
					t.Fatal(err)
				}
			case "unsigned":
				fixture.service.options.InspectHelper = func(daemon.Peer) (SupervisorIdentity, error) { return SupervisorIdentity{}, failure("peer_denied") }
			case "reused_parent", "other_parent":
				fixture.service.options.InspectHelper = func(peer daemon.Peer) (SupervisorIdentity, error) {
					identity, err := inspect(peer)
					if fault == "reused_parent" {
						identity.Process.StartIdentity = "1:1"
					} else {
						identity.Process.PID++
					}
					return identity, err
				}
			case "lock_closed":
				if err := fixture.lock.Close(); err != nil {
					t.Fatal(err)
				}
			case "lock_changed":
				fixture.lock.record.Binding.FencingGeneration++
				if err := fixture.lock.persist(); err != nil {
					t.Fatal(err)
				}
			case "group_without_pin", "wrong_group", "wrong_child_build", "reused_child":
				child := ownedGateTestChild(t)
				if err := fixture.lock.Attach(child); err != nil {
					t.Fatal(err)
				}
				method, payload["process_group_id"] = "execution.group", child.GroupID
				if fault == "wrong_group" {
					payload["process_group_id"] = os.Getpid()
				}
				if fault == "wrong_child_build" || fault == "reused_child" {
					fixture.service.options.InspectHelper = func(peer daemon.Peer) (SupervisorIdentity, error) {
						identity, err := inspect(peer)
						if peer.PID == child.PID {
							if fault == "wrong_child_build" {
								identity.ExecutableHash = "sha256:" + strings.Repeat("b", 64)
							} else {
								identity.Process.StartIdentity = "1:1"
							}
						}
						return identity, err
					}
				}
			}
			if _, err := fixture.call(method, payload); err == nil || fixture.requests.Load() != 0 {
				t.Fatal("unverified ownership reached cloud authorization", err)
			}
			stored, err := fixture.store.ByIntent(context.Background(), fixture.assignment.TerminalIntentId)
			if err != nil || stored.Group != nil || stored.LockID != "" {
				t.Fatal("failed request changed durable ownership", err)
			}
		})
	}
}

func TestGateRPCLostResponsePinsLockAndPostRequestLossBlocks(t *testing.T) {
	for _, fault := range []string{"response_lost", "lock_lost", "ended", "identity_lost"} {
		t.Run(fault, func(t *testing.T) {
			fixture := finalFixture(t)
			original := fixture.connection.request
			fixture.connection.request = func(ctx context.Context, method, path string, body []byte) ([]byte, error) {
				data, err := original(ctx, method, path, body)
				if err != nil {
					return nil, err
				}
				switch fault {
				case "response_lost":
					return nil, runner.ErrOffline
				case "lock_lost":
					err = fixture.lock.Close()
				case "ended":
					_, err = fixture.store.db.ExecContext(ctx, "UPDATE local_execution_assignments SET state = 'ended'")
				case "identity_lost":
					fixture.service.options.InspectHelper = func(daemon.Peer) (SupervisorIdentity, error) { return SupervisorIdentity{}, failure("peer_denied") }
				}
				return data, err
			}
			if _, err := fixture.call("execution.authorize", fixture.payload()); err == nil {
				t.Fatal("failed online/native evidence returned authorization")
			}
			stored, err := fixture.store.ByIntent(context.Background(), fixture.assignment.TerminalIntentId)
			if err != nil || stored.LockID != fixture.lock.record.LockID || stored.Supervisor == nil || stored.Supervisor.wire() != fixture.assignment.Supervisor {
				t.Fatal("ambiguous response erased cleanup identity", err)
			}
			if fault == "response_lost" {
				fixture.connection.request = original
				if _, err := fixture.call("execution.authorize", fixture.payload()); err != nil || fixture.requests.Load() != 2 {
					t.Fatal("same live owner could not reauthorize", err)
				}
			}
		})
	}
}

func TestFinalAuthorizationRejectsConfusionAndStaleReceipts(t *testing.T) {
	fixture := finalFixture(t)
	request := finalRequest(fixture.assignment, fixture.lock.record.LockID)
	for _, fault := range []string{"launch", "execution", "generation", "rejected", "old", "future", "slow", "backwards_clock", "duplicate", "extra", "empty", "huge"} {
		t.Run(fault, func(t *testing.T) {
			authorization := fixture.authorized()
			completed := fixture.now
			switch fault {
			case "launch":
				authorization.LaunchId = daemon.NewRequestID()
			case "execution":
				authorization.RunExecutionId = daemon.NewRequestID()
			case "generation":
				authorization.AssignmentGeneration++
			case "rejected":
				authorization.Decision = "rejected"
				authorization.Rejection = &generated.TypedError{SchemaVersion: 1, Category: "authorization_denied", Code: "launch_blocked", Message: "synthetic rejection"}
			case "old":
				authorization.AuthorizedAt = localTimestamp(fixture.now.Add(-6 * time.Second))
			case "future":
				authorization.AuthorizedAt = localTimestamp(fixture.now.Add(6 * time.Second))
			case "slow":
				completed = completed.Add(6 * time.Second)
			case "backwards_clock":
				completed = completed.Add(-time.Second)
			}
			data, _ := json.Marshal(authorization)
			switch fault {
			case "duplicate":
				data = []byte(strings.Replace(string(data), `"decision":"authorized"`, `"decision":"rejected","decision":"authorized"`, 1))
			case "extra":
				data = append(data[:len(data)-1], []byte(`,"local_path":"/synthetic"}`)...)
			case "empty":
				data = nil
			case "huge":
				data = append(data, []byte(strings.Repeat(" ", 4096))...)
			}
			if _, err := decodeFinalAuthorization(data, request, fixture.now, completed); err == nil {
				t.Fatal("invalid final response reached provider gate")
			}
		})
	}
}
