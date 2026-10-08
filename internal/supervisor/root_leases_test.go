// ABOUTME: Tests root-mode lease renewal and denial without claiming whole-family containment.
// ABOUTME: Preserves durable mode selection across failed inspection and restart with no v1 fallback.

package supervisor

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
)

func rootInspectionFixture(t *testing.T, assignment LocalAssignment) (*nativeFixture, nativeInspector) {
	t.Helper()
	f, inspector := inspectionFixture(t, assignment)
	f.locked.Record.SupervisionMode = provider.RootSupervision
	f.locked.Record.Group.SupervisionMode = provider.RootSupervision
	f.table[1203] = fixtureProcess(1203, assignment.Group.PID, 1203)
	return f, inspector
}

func decodedRootLease(t *testing.T, body []byte) generated.CheckoutRootLeaseObservation {
	t.Helper()
	var observation generated.CheckoutRootLeaseObservation
	if !protocol.DecodeWireDocument("checkout-root-lease-observation", body).OK || strictPrivateJSON(body, &observation) != nil ||
		protocol.DecodeWireDocument("checkout-lease-observation", body).OK {
		t.Fatal("root lease was not closed named v2", string(body))
	}
	return observation
}

func TestRootLeaseRenewsUnprovenFamilyAndRetainsStartupAcrossRestart(t *testing.T) {
	ctx := context.Background()
	store, local, assignment, now := observationFixture(t)
	f, inspector := rootInspectionFixture(t, assignment)
	f.image = true
	sequence, observations := int64(0), 0
	connection := &finalConnection{request: func(_ context.Context, method, path string, body []byte) ([]byte, error) {
		if method != "POST" {
			t.Fatal(method)
		}
		if path == "launch/reconcile" {
			now = now.Add(time.Second)
			receipt := receiptFixture(assignment.Claim, "live")
			receipt.ObservationSequence = &sequence
			return encodedFixture(t, receipt), nil
		}
		if path != "leases/observe-root" {
			t.Fatal("root lease fell back to strict transport", path)
		}
		observation := decodedRootLease(t, body)
		if observation.Operation != "renew" || observation.DescendantsState != "unproven" || observation.FamilyCoverage != "unproven" ||
			observation.SupervisionMode != "root" || observation.RecoveryLocal || observation.OwnedGroupId != int64(assignment.Group.GroupID) ||
			observation.OwnedGroupStartIdentity != assignment.Group.StartIdentity || observation.LocalLockId != assignment.LockID ||
			observation.Supervisor == nil || *observation.Supervisor != assignment.Supervisor.wire() || observation.Sequence != sequence+1 || observation.ObservedAt != localTimestamp(now) {
			t.Fatal("root observation replaced ownership or claimed family closure", observation)
		}
		var durable int64
		if err := store.db.QueryRow("SELECT lease_sequence FROM local_execution_assignments WHERE intent_id=?", assignment.IntentID).Scan(&durable); err != nil || durable != observation.Sequence {
			t.Fatal("root request preceded durable sequence", err, durable)
		}
		sequence, observations = observation.Sequence, observations+1
		return nil, errors.New("synthetic committed lease response loss")
	}}
	service := leaseFixtureService(func() time.Time { return now }, connection)
	if err := service.maintainLease(ctx, store, inspector, assignment.IntentID); err == nil {
		t.Fatal("lost response was treated as acknowledged")
	}
	f.image = false // The exact original image observation remains durable.
	if err := local.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := daemon.OpenStore(ctx, local.Paths)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	store = NewIntentStore(reopened.DB)
	service = leaseFixtureService(func() time.Time { return now }, connection)
	if err := service.maintainLease(ctx, store, inspector, assignment.IntentID); err == nil || observations != 2 || f.imageCalls != 1 {
		t.Fatal("restart lost root mode or required the provider image again", observations, f.imageCalls, err)
	}
	events, err := store.PendingObservations(ctx, 256)
	if err != nil || len(events) != 1 || events[0].Kind != "execution_attached" {
		t.Fatal("lease fabricated activity or lost startup", events, err)
	}
}

func TestRootLeaseFailuresNeverDowngradeOrRelease(t *testing.T) {
	for _, fault := range []string{"first_process_read", "second_process_read", "second_lock_read", "signature", "free_lock", "root_ended", "lost_image", "retained_unknown", "cloud_unknown"} {
		t.Run(fault, func(t *testing.T) {
			ctx := context.Background()
			store, _, assignment, now := observationFixture(t)
			f, inspector := rootInspectionFixture(t, assignment)
			f.image = true
			if fault != "lost_image" {
				captureFixture(t, store, assignment, processCapture{State: "live", ProviderImage: true}, now, "execution_attached")
			}
			if fault != "first_process_read" {
				if _, err := store.rememberNative(ctx, assignment, nativeHistory{Group: f.locked.Record.Group, Uncertain: fault == "retained_unknown"}); err != nil {
					t.Fatal(err)
				}
			}
			switch fault {
			case "first_process_read":
				f.processErr = errors.New("synthetic first process read failure")
			case "second_process_read":
				reads := 0
				inspector.processes = func() (ProcessTable, error) {
					reads++
					if reads == 2 {
						return nil, errors.New("synthetic second process read failure")
					}
					return f.table, nil
				}
			case "second_lock_read":
				reads := 0
				inspector.lock = func(LocalAssignment) (nativeLock, error) {
					reads++
					if reads == 2 {
						return nativeLock{}, errors.New("synthetic second marker read failure")
					}
					return f.locked, nil
				}
			case "signature":
				f.helperErr = failure("peer_denied")
			case "free_lock":
				f.locked.Held = false
			case "root_ended":
				delete(f.table, assignment.Group.PID)
				child := f.table[1203]
				child.ParentPID = 1
				f.table[1203] = child
			case "lost_image":
				f.image = false
			}
			observations := 0
			connection := &finalConnection{request: func(_ context.Context, _, path string, body []byte) ([]byte, error) {
				if path == "launch/reconcile" {
					state := "live"
					if fault == "cloud_unknown" {
						state = "containment_unknown"
					}
					return encodedFixture(t, receiptFixture(assignment.Claim, state)), nil
				}
				if path != "leases/observe-root" {
					t.Fatal("failed root inspection emitted strict/release request", path)
				}
				observation := decodedRootLease(t, body)
				if observation.Operation != "unknown" || observation.RecoveryLocal || observation.OwnedGroupId != int64(assignment.Group.GroupID) {
					t.Fatal("failure renewed or released root authority", observation)
				}
				observations++
				return []byte(`{"state":"containment_unknown"}`), nil
			}}
			if err := leaseFixtureService(func() time.Time { return now }, connection).maintainLease(ctx, store, inspector, assignment.IntentID); err != nil {
				t.Fatal(err)
			}
			want := 1
			if fault == "lost_image" {
				want = 0
			}
			if observations != want {
				t.Fatal("wrong root inspection disposition", observations, want)
			}
		})
	}
}

func TestRootLeaseDoesNotPinMidSpawnOrInventModeAfterMissingMarker(t *testing.T) {
	store, _, assignment, now := observationFixture(t)
	f, inspector := rootInspectionFixture(t, assignment)
	f.lockErr = failure("containment_unknown")
	connection := &finalConnection{request: func(_ context.Context, _, path string, _ []byte) ([]byte, error) {
		if path != "launch/reconcile" {
			t.Fatal("unknown local mode invented a lease contract", path)
		}
		return encodedFixture(t, receiptFixture(assignment.Claim, "reserved")), nil
	}}
	if err := leaseFixtureService(func() time.Time { return now }, connection).maintainLease(context.Background(), store, inspector, assignment.IntentID); daemon.AsFailure(err).Code != "containment_unknown" {
		t.Fatal(err)
	}
	assignment.Group = nil
	facts := nativeFacts{History: nativeHistory{Group: f.locked.Record.Group}, ObservedAt: now, SupervisorState: "verified", GroupState: "never_started", LockState: "held"}
	if rootLeaseObservation(assignment, facts, false, "reserved") != nil || leaseObservation(assignment, facts, false, "reserved") != nil {
		t.Fatal("mid-spawn root identity was pinned")
	}
}

func TestRootLeaseUnsupportedServerNeverFallsBack(t *testing.T) {
	store, _, assignment, now := observationFixture(t)
	f, inspector := rootInspectionFixture(t, assignment)
	f.image = true
	attempts := 0
	connection := &finalConnection{request: func(_ context.Context, _, path string, body []byte) ([]byte, error) {
		if path == "launch/reconcile" {
			return encodedFixture(t, receiptFixture(assignment.Claim, "reserved")), nil
		}
		if path != "leases/observe-root" {
			t.Fatal("unsupported server triggered strict downgrade", path)
		}
		_ = decodedRootLease(t, body)
		attempts++
		return nil, errors.New("synthetic unsupported root observation route")
	}}
	if err := leaseFixtureService(func() time.Time { return now }, connection).maintainLease(context.Background(), store, inspector, assignment.IntentID); daemon.AsFailure(err).Code != "execution_authorization_failed" || attempts != 1 {
		t.Fatal("unsupported route acknowledged or retried", attempts, err)
	}
}
