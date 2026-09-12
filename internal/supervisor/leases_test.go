// ABOUTME: Fault-tests fresh lease requests, immutable identity, lost acknowledgements and local-only settlement.
// ABOUTME: Uses synthetic authenticated transport/native fixtures and separately verifies an untouched real successor lock.

package supervisor

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/runner"
)

func leaseFixtureService(now func() time.Time, connection *finalConnection) *Service {
	return NewService(ServiceOptions{Now: now, Connection: func(string) (runner.RunnerConnection, error) { return connection, nil }})
}

func decodedLease(t *testing.T, body []byte) generated.CheckoutLeaseObservation {
	t.Helper()
	var observation generated.CheckoutLeaseObservation
	if !protocol.DecodeWireDocument("checkout-lease-observation", body).OK || strictPrivateJSON(body, &observation) != nil {
		t.Fatal("lease body failed strict protocol", string(body))
	}
	return observation
}

func TestLeaseRenewalUsesFreshPostReconciliationEvidenceAndDurableSequence(t *testing.T) {
	ctx := context.Background()
	store, local, assignment, now := observationFixture(t)
	f, inspector := inspectionFixture(t, assignment)
	f.image = true
	f.table[1203] = fixtureProcess(1203, assignment.Group.PID, assignment.Group.GroupID)
	command, _ := store.Command(ctx, assignment.Claim.Assignment.RunnerId, assignment.Claim.Specification.LaunchId)
	cloudSequence := int64(7)
	observations := []generated.CheckoutLeaseObservation{}
	connection := &finalConnection{request: func(_ context.Context, method, path string, body []byte) ([]byte, error) {
		if method != "POST" {
			t.Fatal("unexpected transport method")
		}
		switch path {
		case "launch/reconcile":
			expected, _ := claimRequest(command)
			if string(expected) != string(body) {
				t.Fatal("lease maintenance changed the winning claim")
			}
			now = now.Add(time.Hour) // Old event/launch timestamps cannot be lease authority.
			receipt := receiptFixture(assignment.Claim, "live")
			receipt.LaunchState, receipt.ObservationSequence = "started", &cloudSequence
			return encodedFixture(t, receipt), nil
		case "leases/observe":
			observation := decodedLease(t, body)
			if observation.Operation != "renew" || observation.ObservedAt != localTimestamp(now) || observation.Sequence != cloudSequence+1 || observation.Supervisor == nil || *observation.Supervisor != assignment.Supervisor.wire() || observation.LocalLockId != assignment.LockID || observation.OwnedGroupId != int64(assignment.Group.PID) || observation.OwnedGroupStartIdentity != assignment.Group.StartIdentity {
				t.Fatal("lease did not use fresh immutable native ownership", observation)
			}
			var durable int64
			if store.db.QueryRow("SELECT lease_sequence FROM local_execution_assignments WHERE intent_id = ?", assignment.IntentID).Scan(&durable) != nil || durable != observation.Sequence {
				t.Fatal("network send preceded durable sequence reservation")
			}
			cloudSequence = observation.Sequence
			observations = append(observations, observation)
			return nil, errors.New("synthetic lost lease reply")
		default:
			t.Fatal("unexpected lease path", path)
			return nil, nil
		}
	}}
	service := leaseFixtureService(func() time.Time { return now }, connection)
	if err := service.maintainLease(ctx, store, inspector, assignment.IntentID); err == nil {
		t.Fatal("lost reply was reported acknowledged")
	}
	// Lease inspection can be the only observer that sees the provider image
	// before its parent exits. The surviving child must retain that startup.
	delete(f.table, assignment.Group.PID)
	child := f.table[1203]
	child.ParentPID = 1
	f.table[child.PID], f.image = child, false
	if err := local.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := daemon.OpenStore(ctx, local.Paths)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	store = NewIntentStore(reopened.DB)
	service = leaseFixtureService(func() time.Time { return now }, connection)
	if err := service.maintainLease(ctx, store, inspector, assignment.IntentID); err == nil {
		t.Fatal("second lost reply was reported acknowledged")
	}
	if len(observations) != 2 || observations[0].Sequence != 8 || observations[1].Sequence != 9 || observations[0].ObservedAt == observations[1].ObservedAt {
		t.Fatal("restart replayed old request-bound evidence", observations)
	}
	if events, err := store.PendingObservations(ctx, 256); err != nil || len(events) != 1 || events[0].Kind != "execution_attached" || events[0].OccurredAt != observations[0].ObservedAt || f.imageCalls != 1 {
		t.Fatal("lease inspection lost its one startup observation or created a replayable lease heartbeat", events, err)
	}
}

func TestLeaseDoesNotRenewWaitingWrapperOrPoisonOrdinaryShutdown(t *testing.T) {
	for _, phase := range []string{"waiting_wrapper", "group_ended", "marker_released_owner_live"} {
		t.Run(phase, func(t *testing.T) {
			store, _, assignment, now := observationFixture(t)
			f, inspector := inspectionFixture(t, assignment)
			if phase != "waiting_wrapper" {
				delete(f.table, assignment.Group.PID)
			}
			if phase == "marker_released_owner_live" {
				f.locked.Held, f.locked.Record.State = false, "released"
			}
			requests := 0
			connection := &finalConnection{request: func(_ context.Context, _, path string, _ []byte) ([]byte, error) {
				requests++
				if path != "launch/reconcile" {
					t.Fatal("waiting/shutting-down helper emitted cloud activity or uncertainty", path)
				}
				return encodedFixture(t, receiptFixture(assignment.Claim, "reserved")), nil
			}}
			service := leaseFixtureService(func() time.Time { return now }, connection)
			if err := service.maintainLease(context.Background(), store, inspector, assignment.IntentID); err != nil || requests != 1 {
				t.Fatal(err, requests)
			}
			var sequence int
			if store.db.QueryRow("SELECT lease_sequence FROM local_execution_assignments WHERE intent_id = ?", assignment.IntentID).Scan(&sequence) != nil || sequence != 0 {
				t.Fatal("unobserved provider consumed a lease sequence")
			}
		})
	}
}

func TestLeaseUnknownPreservesOriginalIdentityAfterNativeFailure(t *testing.T) {
	for _, fault := range []string{"signature", "owner_reuse", "group_reuse", "escape", "missing_lock", "cloud_unknown"} {
		t.Run(fault, func(t *testing.T) {
			ctx := context.Background()
			store, _, assignment, now := observationFixture(t)
			f, inspector := inspectionFixture(t, assignment)
			f.image = true
			captureFixture(t, store, assignment, processCapture{State: "live", ProviderImage: true}, now, "execution_attached")
			observations := 0
			connection := &finalConnection{request: func(_ context.Context, _, path string, body []byte) ([]byte, error) {
				if path == "launch/reconcile" {
					state := "live"
					switch fault {
					case "signature":
						f.helperErr = failure("peer_denied")
					case "owner_reuse":
						owner := f.table[assignment.Supervisor.Process.PID]
						owner.StartIdentity = "9:9"
						f.table[owner.PID] = owner
					case "group_reuse":
						leader := f.table[assignment.Group.PID]
						leader.StartIdentity = "9:9"
						f.table[leader.PID] = leader
					case "escape":
						f.table[1203] = fixtureProcess(1203, assignment.Group.PID, 1203)
					case "missing_lock":
						f.lockErr = failure("containment_unknown")
					case "cloud_unknown":
						state = "containment_unknown"
					}
					return encodedFixture(t, receiptFixture(assignment.Claim, state)), nil
				}
				if path != "leases/observe" {
					t.Fatal(path)
				}
				observation := decodedLease(t, body)
				observations++
				if observation.Operation != "unknown" || observation.RecoveryLocal || observation.Supervisor == nil || *observation.Supervisor != assignment.Supervisor.wire() || observation.OwnedGroupId != int64(assignment.Group.PID) || observation.OwnedGroupStartIdentity != assignment.Group.StartIdentity || observation.LocalLockId != assignment.LockID {
					t.Fatal("native failure renewed or replaced ownership", observation)
				}
				return []byte(`{"state":"containment_unknown"}`), nil
			}}
			service := leaseFixtureService(func() time.Time { return now }, connection)
			if err := service.maintainLease(ctx, store, inspector, assignment.IntentID); err != nil || observations != 1 {
				t.Fatal(err, observations)
			}
		})
	}
}

func TestLeaseRejectsUnboundReconciliationBeforeNativeOrLeaseEffects(t *testing.T) {
	for _, fault := range []string{"workspace", "runner", "launch", "execution", "generation", "physical", "fence", "never_acquired", "partial", "extra", "duplicate"} {
		t.Run(fault, func(t *testing.T) {
			store, _, assignment, now := observationFixture(t)
			_, inspector := inspectionFixture(t, assignment)
			inspector.processes = func() (ProcessTable, error) { t.Fatal("unbound receipt reached native lease work"); return nil, nil }
			receipt := receiptFixture(assignment.Claim, "live")
			switch fault {
			case "workspace":
				receipt.WorkspaceId = daemon.NewRequestID()
			case "runner":
				receipt.RunnerId = daemon.NewRequestID()
			case "launch":
				receipt.LaunchId = daemon.NewRequestID()
			case "execution":
				receipt.RunExecutionId = daemon.NewRequestID()
			case "generation":
				receipt.AssignmentGeneration++
			case "physical":
				receipt.PhysicalWorktreeHash = "sha256:" + strings.Repeat("f", 64)
			case "fence":
				fence := *receipt.FencingGeneration + 1
				receipt.FencingGeneration = &fence
			case "never_acquired":
				receipt = receiptFixture(assignment.Claim, "never_acquired")
			}
			data := encodedFixture(t, receipt)
			switch fault {
			case "partial":
				data = []byte(`{"reservation_state":"released"}`)
			case "extra":
				data = append(data[:len(data)-1], []byte(`,"argv":[]}`)...)
			case "duplicate":
				data = append(data[:len(data)-1], []byte(`,"schema_version":1}`)...)
			}
			connection := &finalConnection{request: func(_ context.Context, _, path string, _ []byte) ([]byte, error) {
				if path != "launch/reconcile" {
					t.Fatal("unbound receipt mutated a lease")
				}
				return data, nil
			}}
			if err := leaseFixtureService(func() time.Time { return now }, connection).maintainLease(context.Background(), store, inspector, assignment.IntentID); err == nil {
				t.Fatal("unbound receipt was accepted", fault)
			}
		})
	}
}

func TestLeaseLostReleaseReplySettlesAcrossRestartWithoutTouchingSuccessorLock(t *testing.T) {
	ctx := context.Background()
	store, local, assignment, now := observationFixture(t)
	f, inspector := inspectionFixture(t, assignment)
	f.table, f.locked.Held, f.locked.Record.State = ProcessTable{}, false, "released"
	released, observations := false, 0
	connection := &finalConnection{request: func(_ context.Context, _, path string, body []byte) ([]byte, error) {
		if path == "launch/reconcile" {
			state := "live"
			if released {
				state = "superseded"
			}
			return encodedFixture(t, receiptFixture(assignment.Claim, state)), nil
		}
		if path != "leases/observe" || released {
			t.Fatal("settlement resent lease evidence or changed another owner", path)
		}
		observation := decodedLease(t, body)
		history, err := readNativeHistory(ctx, store.db, assignment)
		if err != nil || history.LocalReleasedAt == "" || history.Group == nil || observation.Operation != "release" || observation.SupervisorState != "gone" || observation.GroupState != "gone" || observation.LockState != "gone" || observation.DescendantsState != "gone" || observation.RecoveryLocal {
			t.Fatal("release preceded durable native absence", history, observation, err)
		}
		released, observations = true, observations+1
		return nil, errors.New("synthetic release committed but reply lost")
	}}
	service := leaseFixtureService(func() time.Time { return now }, connection)
	if err := service.maintainLease(ctx, store, inspector, assignment.IntentID); err == nil {
		t.Fatal("lost release reply completed delivery")
	}
	if err := local.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := daemon.OpenStore(ctx, local.Paths)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	store = NewIntentStore(reopened.DB)
	// The predecessor's process evidence is synthetic. This successor owns a
	// real native flock, acquired by this test process, and must remain held.
	locks, err := OpenLockStore(worktreeLocksPath(local.Paths))
	if err != nil {
		t.Fatal(err)
	}
	defer locks.Close()
	binding := assignment.lockBinding()
	binding.ExecutionID, binding.FencingGeneration = daemon.NewRequestID(), binding.FencingGeneration+1
	successor, err := locks.Acquire(binding)
	if err != nil {
		t.Fatal(err)
	}
	defer successor.Close()
	before := successor.record
	inspector.lock = func(LocalAssignment) (nativeLock, error) {
		t.Fatal("old execution inspected its successor's marker")
		return nativeLock{}, nil
	}
	service = leaseFixtureService(func() time.Time { return now }, connection)
	if err := service.maintainLease(ctx, store, inspector, assignment.IntentID); err != nil {
		t.Fatal("confirmed release did not settle across restart", err)
	}
	command, _ := store.Command(ctx, assignment.Claim.Assignment.RunnerId, assignment.Claim.Specification.LaunchId)
	after, err := locks.read(binding.PhysicalWorktreeHash)
	if err != nil || string(encodedFixture(t, after)) != string(encodedFixture(t, before)) || observations != 1 || command.State != "complete" {
		t.Fatal("old execution changed successor ownership or did not settle", err)
	}
	if _, err := locks.Acquire(assignment.lockBinding()); err == nil {
		t.Fatal("settling old delivery released the successor's real flock")
	}
	table, err := InspectProcesses()
	if err != nil || !before.Owner.Same(table[os.Getpid()]) {
		t.Fatal("settlement affected the successor process")
	}
	events, err := store.PendingObservations(ctx, 256)
	if err != nil || len(events) != 1 || events[0].Kind != "execution_ended" || events[0].ProviderStart != "unobserved" {
		t.Fatal("settlement lost process end or invented startup", events, err)
	}
}

func TestLeaseReleaseRequiresCanonicalReceiptAndFreshRetainedAbsence(t *testing.T) {
	for _, fault := range []string{"partial_receipt", "cloud_unknown", "owner_reuse", "descendant_reuse", "live_descendant", "inspection_failed", "no_local_checkpoint"} {
		t.Run(fault, func(t *testing.T) {
			ctx := context.Background()
			store, _, assignment, now := observationFixture(t)
			f, inspector := inspectionFixture(t, assignment)
			f.table, f.locked.Held, f.locked.Record.State = ProcessTable{}, false, "released"
			if fault != "no_local_checkpoint" {
				service := NewService(ServiceOptions{Now: func() time.Time { return now }})
				if _, _, err := service.inspectNative(ctx, store, inspector, assignment); err != nil {
					t.Fatal(err)
				}
			}
			data := encodedFixture(t, receiptFixture(assignment.Claim, "released"))
			switch fault {
			case "partial_receipt":
				data = []byte(`{"reservation_state":"released"}`)
			case "cloud_unknown":
				data = encodedFixture(t, receiptFixture(assignment.Claim, "containment_unknown"))
			case "owner_reuse":
				owner := assignment.Supervisor.Process
				owner.StartIdentity = "9:9"
				f.table[owner.PID] = owner
			case "descendant_reuse":
				leader := *assignment.Group
				leader.StartIdentity = "9:9"
				f.table[leader.PID] = leader
			case "live_descendant":
				f.table[1203] = fixtureProcess(1203, 1, assignment.Group.GroupID)
			case "inspection_failed":
				f.processErr = errors.New("synthetic kernel inspection failed")
			case "no_local_checkpoint":
				f.lockErr = errors.New("synthetic replaced old marker")
			}
			observations := 0
			connection := &finalConnection{request: func(_ context.Context, _, path string, body []byte) ([]byte, error) {
				if path == "leases/observe" {
					observations++
					if fault != "cloud_unknown" || decodedLease(t, body).Operation != "unknown" {
						t.Fatal("unsafe settlement emitted a release")
					}
					return []byte(`{}`), nil
				}
				if path != "launch/reconcile" {
					t.Fatal(path)
				}
				return data, nil
			}}
			_ = leaseFixtureService(func() time.Time { return now }, connection).maintainLease(ctx, store, inspector, assignment.IntentID)
			command, _ := store.Command(ctx, assignment.Claim.Assignment.RunnerId, assignment.Claim.Specification.LaunchId)
			if command.State == "complete" || (fault != "cloud_unknown" && observations != 0) {
				t.Fatal("unsafe or unconfirmed absence completed delivery")
			}
		})
	}
}

func TestLeaseRecoveryRequiresMarkerToCoverEveryDaemonDescendant(t *testing.T) {
	for _, covered := range []bool{false, true} {
		t.Run(map[bool]string{false: "forgotten_descendant", true: "complete_local_recovery"}[covered], func(t *testing.T) {
			ctx := context.Background()
			store, _, assignment, now := observationFixture(t)
			f, inspector := inspectionFixture(t, assignment)
			group := mergeGroups(nil, f.locked.Record.Group)
			group.Observed[1203] = fixtureProcess(1203, assignment.Group.PID, 1203)
			group.Unknown, group.HadEscape = true, true
			if _, err := store.rememberNative(ctx, assignment, nativeHistory{Group: group, Uncertain: true}); err != nil {
				t.Fatal(err)
			}
			f.table, f.locked.Held, f.locked.Record.State, f.locked.Record.RecoveryLocal = ProcessTable{}, false, "released", true
			if covered {
				f.locked.Record.Group = group
			}
			released, calls := false, 0
			connection := &finalConnection{request: func(_ context.Context, _, path string, body []byte) ([]byte, error) {
				if path == "launch/reconcile" {
					state := "containment_unknown"
					if released {
						state = "released"
					}
					return encodedFixture(t, receiptFixture(assignment.Claim, state)), nil
				}
				if path != "leases/observe" {
					t.Fatal(path)
				}
				observation := decodedLease(t, body)
				calls++
				if covered {
					if observation.Operation != "recover" || !observation.RecoveryLocal {
						t.Fatal("complete local recovery was not explicit", observation)
					}
					released = true
				} else if observation.Operation != "unknown" || observation.RecoveryLocal {
					t.Fatal("old marker forgot a daemon descendant", observation)
				}
				return []byte(`{}`), nil
			}}
			service := leaseFixtureService(func() time.Time { return now }, connection)
			if err := service.maintainLease(ctx, store, inspector, assignment.IntentID); err != nil || calls != 1 {
				t.Fatal(err, calls)
			}
			command, _ := store.Command(ctx, assignment.Claim.Assignment.RunnerId, assignment.Claim.Specification.LaunchId)
			history, err := readNativeHistory(ctx, store.db, assignment)
			if err != nil || (command.State == "complete") != covered || !history.Uncertain || !history.Group.HadEscape || len(history.Group.Observed) != 2 {
				t.Fatal("recovery cleared local uncertainty or lost history", err)
			}
		})
	}
}

func TestLeaseSequencesAreConcurrentMonotonicAndBounded(t *testing.T) {
	ctx := context.Background()
	store, _, assignment, _ := observationFixture(t)
	sequences := make(chan int64, 24)
	var workers sync.WaitGroup
	for range 24 {
		workers.Go(func() {
			sequence, err := store.nextLeaseSequence(ctx, assignment, 19)
			if err != nil {
				t.Error(err)
				return
			}
			sequences <- sequence
		})
	}
	workers.Wait()
	close(sequences)
	seen := map[int64]bool{}
	for sequence := range sequences {
		if sequence < 20 || sequence > 43 || seen[sequence] {
			t.Fatal("sequence was reused or regressed", sequence)
		}
		seen[sequence] = true
	}
	if len(seen) != 24 {
		t.Fatal("sequence reservation lost a contender")
	}
	for _, cloud := range []int64{-1, maxObservationSequence} {
		if _, err := store.nextLeaseSequence(ctx, assignment, cloud); err == nil {
			t.Fatal("out-of-range cloud sequence accepted")
		}
	}
	if _, err := store.db.Exec("UPDATE local_execution_assignments SET lease_sequence = ? WHERE intent_id = ?", maxObservationSequence, assignment.IntentID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.nextLeaseSequence(ctx, assignment, 0); err == nil {
		t.Fatal("exhausted local sequence wrapped")
	}
}

func TestLeaseRejectsSlowInspectionAndStalePostStorageFacts(t *testing.T) {
	for _, slowAt := range []int{2, 3} {
		t.Run(map[int]string{2: "inspection", 3: "storage"}[slowAt], func(t *testing.T) {
			store, _, assignment, now := observationFixture(t)
			f, inspector := inspectionFixture(t, assignment)
			f.image = true
			calls := 0
			connection := &finalConnection{request: func(_ context.Context, _, path string, _ []byte) ([]byte, error) {
				if path != "launch/reconcile" {
					t.Fatal("stale native evidence reached the cloud")
				}
				return encodedFixture(t, receiptFixture(assignment.Claim, "reserved")), nil
			}}
			service := leaseFixtureService(func() time.Time {
				calls++
				if calls == slowAt {
					now = now.Add(6 * time.Second)
				}
				return now
			}, connection)
			if err := service.maintainLease(context.Background(), store, inspector, assignment.IntentID); err == nil {
				t.Fatal("slow native observation was accepted")
			}
		})
	}
}

func TestLeaseReleaseDoesNotTrustHTTPAcknowledgementOrDependOnEventCapacity(t *testing.T) {
	ctx := context.Background()
	store, _, assignment, now := observationFixture(t)
	f, inspector := inspectionFixture(t, assignment)
	f.table, f.locked.Held, f.locked.Record.State = ProcessTable{}, false, "released"
	if _, err := store.db.Exec(`CREATE TRIGGER synthetic_event_full BEFORE INSERT ON execution_observations BEGIN SELECT RAISE(ABORT, 'synthetic event capacity'); END`); err != nil {
		t.Fatal(err)
	}
	released, observations := false, 0
	connection := &finalConnection{request: func(_ context.Context, _, path string, body []byte) ([]byte, error) {
		if path == "launch/reconcile" {
			state := "live"
			if released {
				state = "released"
			}
			return encodedFixture(t, receiptFixture(assignment.Claim, state)), nil
		}
		if path != "leases/observe" || decodedLease(t, body).Operation != "release" {
			t.Fatal("event failure blocked fresh cloud release")
		}
		observations++
		return []byte(`{"state":"released"}`), nil // Not a canonical receipt.
	}}
	service := leaseFixtureService(func() time.Time { return now }, connection)
	if err := service.maintainLease(ctx, store, inspector, assignment.IntentID); err == nil || observations != 1 {
		t.Fatal("HTTP reply substituted for canonical release", err, observations)
	}
	released = true
	if err := service.maintainLease(ctx, store, inspector, assignment.IntentID); err == nil || observations != 1 {
		t.Fatal("event capture failure completed or resent canonical release", err, observations)
	}
	command, _ := store.Command(ctx, assignment.Claim.Assignment.RunnerId, assignment.Claim.Specification.LaunchId)
	if command.State == "complete" {
		t.Fatal("delivery completed without retaining its end event")
	}
	if _, err := store.db.Exec("DROP TRIGGER synthetic_event_full"); err != nil {
		t.Fatal(err)
	}
	if err := service.maintainLease(ctx, store, inspector, assignment.IntentID); err != nil || observations != 1 {
		t.Fatal("event recovery did not settle the original release", err)
	}
	command, _ = store.Command(ctx, assignment.Claim.Assignment.RunnerId, assignment.Claim.Specification.LaunchId)
	if command.State != "complete" {
		t.Fatal("captured canonical release remained pending")
	}
}

func TestLeaseRegisteredHelperCleanupRetainsUnobservedStartup(t *testing.T) {
	for _, phase := range []string{"before_spawn", "child_before_rpc", "spawn_pending", "abandoned_reservation", "recovered_reservation"} {
		t.Run(phase, func(t *testing.T) {
			ctx := context.Background()
			store, _, claim, now := fixtureIntents(t)
			assignment := issueFixture(t, store, claim, now)
			if won, err := store.Offer(ctx, assignment.IntentID); err != nil || !won {
				t.Fatal(err)
			}
			owner := SupervisorIdentity{Process: fixtureProcess(1201, 1, 1201), ExecutableHash: "sha256:" + strings.Repeat("a", 64)}
			assignment, err := store.Register(ctx, assignment.IntentID, owner, now)
			if err != nil {
				t.Fatal(err)
			}
			assignment, err = store.PinOwnership(ctx, assignment.IntentID, owner, daemon.NewRequestID(), nil, now)
			if err != nil {
				t.Fatal(err)
			}
			child := fixtureProcess(1202, owner.Process.PID, 1202)
			withChild := assignment
			withChild.Group = &child
			f, inspector := inspectionFixture(t, withChild)
			f.assignment, f.table = assignment, ProcessTable{}
			f.locked.Held, f.locked.Record.State = false, "released"
			if phase != "child_before_rpc" {
				f.locked.Record.Group = nil
			}
			if phase == "spawn_pending" || phase == "abandoned_reservation" {
				f.locked.Record.State = "reserved"
				f.locked.Record.SpawnPending = phase == "spawn_pending"
			}
			if phase == "recovered_reservation" {
				f.locked.Record.RecoveryLocal = true
				if _, err := store.rememberNative(ctx, assignment, nativeHistory{Uncertain: true}); err != nil {
					t.Fatal(err)
				}
			}
			released, observations := false, 0
			connection := &finalConnection{request: func(_ context.Context, _, path string, body []byte) ([]byte, error) {
				if path == "launch/reconcile" {
					state := "reserved"
					if released {
						state = "released"
					}
					return encodedFixture(t, receiptFixture(claim, state)), nil
				}
				if path != "leases/observe" || phase == "spawn_pending" || phase == "abandoned_reservation" {
					t.Fatal("incomplete group identity reached a lease mutation", phase, path)
				}
				observation := decodedLease(t, body)
				operation, group, descendants := "release", "never_started", "none"
				if phase == "child_before_rpc" {
					group, descendants = "gone", "gone"
				}
				if phase == "recovered_reservation" {
					operation = "recover"
				}
				if observation.Operation != operation || observation.GroupState != group || observation.DescendantsState != descendants || (observation.OwnedGroupId > 0) != (phase == "child_before_rpc") {
					t.Fatal("registered cleanup lost its phase", observation)
				}
				released, observations = true, observations+1
				return []byte(`{}`), nil
			}}
			service := leaseFixtureService(func() time.Time { return now }, connection)
			if err := service.maintainLease(ctx, store, inspector, assignment.IntentID); err != nil {
				t.Fatal(err)
			}
			command, _ := store.Command(ctx, claim.Assignment.RunnerId, claim.Specification.LaunchId)
			expected := phase != "spawn_pending" && phase != "abandoned_reservation"
			if (command.State == "complete") != expected || (observations == 1) != expected {
				t.Fatal("registered phase settled unsafely", phase, command.State, observations)
			}
			if expected {
				events, err := store.PendingObservations(ctx, 256)
				if err != nil || len(events) == 0 {
					t.Fatal(err)
				}
				last := events[len(events)-1]
				kind := "launch_blocked"
				if phase == "child_before_rpc" {
					kind = "execution_ended"
				}
				if last.Kind != kind || last.ProviderStart != "unobserved" {
					t.Fatal("failed registration phase invented provider startup", events)
				}
			}
		})
	}
}

func TestLeaseWorkersAreBoundedIndependentOfLaunchAndJoinedOnShutdown(t *testing.T) {
	store, local, original, now := fixtureIntents(t)
	for range 6 {
		claim := original
		claim.Specification.LaunchId = daemon.NewRequestID()
		claim.Assignment.RunExecutionId = daemon.NewRequestID()
		claim.Specification.RunExecutionId = claim.Assignment.RunExecutionId
		assignment := issueFixture(t, store, claim, now)
		if won, err := store.Offer(context.Background(), assignment.IntentID); err != nil || !won {
			t.Fatal(err)
		}
		owner := SupervisorIdentity{Process: fixtureProcess(1201, 1, 1201), ExecutableHash: "sha256:" + strings.Repeat("a", 64)}
		if _, err := store.Register(context.Background(), assignment.IntentID, owner, now); err != nil {
			t.Fatal(err)
		}
		if _, err := store.PinOwnership(context.Background(), assignment.IntentID, owner, daemon.NewRequestID(), nil, now); err != nil {
			t.Fatal(err)
		}
	}
	for range 4 {
		claim := original
		claim.Specification.LaunchId = daemon.NewRequestID()
		acceptFixture(t, store, claim, now)
	}
	launchStarted, leaseStarted := make(chan struct{}, 8), make(chan string, 8)
	releaseLease := make(chan struct{})
	var launches, leases atomic.Int32
	connection := &finalConnection{request: func(ctx context.Context, _, path string, body []byte) ([]byte, error) {
		switch path {
		case "launch/claim":
			if launches.Add(1) > 4 {
				t.Error("launch worker bound exceeded")
			}
			defer launches.Add(-1)
			launchStarted <- struct{}{}
			<-ctx.Done()
		case "launch/reconcile":
			if leases.Add(1) > 4 {
				t.Error("lease worker bound exceeded")
			}
			defer leases.Add(-1)
			var request generated.LaunchClaim
			if strictPrivateJSON(body, &request) != nil {
				t.Error("invalid reconciliation request")
			}
			leaseStarted <- request.LaunchId
			select {
			case <-releaseLease:
			case <-ctx.Done():
			}
		default:
			t.Error("unexpected scheduler request", path)
		}
		return nil, errors.New("synthetic blocked transport")
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	service := leaseFixtureService(func() time.Time { return now }, connection)
	stop, err := service.Start(ctx, local)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	for range 4 {
		select {
		case <-launchStarted:
		case <-ctx.Done():
			t.Fatal("lease requests blocked independent launch workers")
		}
	}
	seen := map[string]bool{}
	for range 4 {
		select {
		case id := <-leaseStarted:
			if seen[id] {
				t.Fatal("concurrent duplicate lease attempt")
			}
			seen[id] = true
		case <-ctx.Done():
			t.Fatal("launch requests blocked lease maintenance")
		}
	}
	releaseLease <- struct{}{}
	select {
	case id := <-leaseStarted:
		if seen[id] {
			t.Fatal("lease retry starved a pending execution")
		}
	case <-ctx.Done():
		t.Fatal("free lease worker did not take a pending execution")
	}
	stop()
	if launches.Load() != 0 || leases.Load() != 0 {
		t.Fatal("service shutdown left lease or launch workers using closed state")
	}
}

func TestLeaseFirstRenewalRequiresStartupCaptureButLaterRenewalDoesNotNeedEventSpace(t *testing.T) {
	ctx := context.Background()
	store, _, assignment, now := observationFixture(t)
	f, inspector := inspectionFixture(t, assignment)
	f.image = true
	const full = `CREATE TRIGGER synthetic_event_full BEFORE INSERT ON execution_observations BEGIN SELECT RAISE(ABORT, 'synthetic event capacity'); END`
	if _, err := store.db.Exec(full); err != nil {
		t.Fatal(err)
	}
	observations := 0
	connection := &finalConnection{request: func(_ context.Context, _, path string, body []byte) ([]byte, error) {
		if path == "launch/reconcile" {
			return encodedFixture(t, receiptFixture(assignment.Claim, "reserved")), nil
		}
		if path != "leases/observe" || decodedLease(t, body).Operation != "renew" {
			t.Fatal("unexpected maintenance operation")
		}
		checkpoint, err := store.observationCheckpoint(ctx, assignment.IntentID)
		if err != nil || checkpoint.ProviderObserved == "" {
			t.Fatal("cloud attach preceded durable startup capture", err)
		}
		observations++
		return []byte(`{}`), nil
	}}
	service := leaseFixtureService(func() time.Time { return now }, connection)
	if err := service.maintainLease(ctx, store, inspector, assignment.IntentID); err == nil || observations != 0 {
		t.Fatal("failed startup capture reached the first cloud renewal", err)
	}
	if _, err := store.db.Exec("DROP TRIGGER synthetic_event_full"); err != nil {
		t.Fatal(err)
	}
	if err := service.maintainLease(ctx, store, inspector, assignment.IntentID); err != nil || observations != 1 {
		t.Fatal("restored event capacity did not allow first renewal", err)
	}
	if _, err := store.db.Exec(full); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute)
	if err := service.maintainLease(ctx, store, inspector, assignment.IntentID); err != nil || observations != 2 {
		t.Fatal("later fresh renewal depended on event capacity", err)
	}
	if events, err := store.PendingObservations(ctx, 256); err != nil || len(events) != 1 || events[0].Kind != "execution_attached" {
		t.Fatal("lease retry fabricated or duplicated an event", events, err)
	}
}
