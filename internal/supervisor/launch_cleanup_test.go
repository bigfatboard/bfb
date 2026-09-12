// ABOUTME: Exercises strict C09 response parsing and restart-safe cleanup over an injected authenticated transport.
// ABOUTME: Proves lost replies and conflicting cloud or local ownership cannot become unstarted release authority.

package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
)

func encodedFixture(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestClaimOutcomeRejectsAmbiguousWrapperAndClaim(t *testing.T) {
	store, _, claim, now := fixtureIntents(t)
	command := acceptFixture(t, store, claim, now)
	raw := string(encodedFixture(t, claim))
	valid := `{"state":"claimed","claim":` + raw + `}`
	for _, data := range []string{valid, `{"claim":` + raw + `,"state":"claimed"}`} {
		if parsed, err := claimOutcome([]byte(data), command); err != nil || parsed == nil || claimIdentity(*parsed) != claimIdentity(claim) {
			t.Fatal("valid claim not accepted", err)
		}
	}
	for _, data := range []string{`{"state":"expired","reason":"launch_expired"}`, `{"reason":"launch_blocked","state":"rejected"}`} {
		if parsed, err := claimOutcome([]byte(data), command); err != nil || parsed != nil {
			t.Fatal("valid terminal outcome not accepted", err)
		}
	}
	for _, data := range []string{
		"", "null", "[]", "{}", "[" + valid + "]", valid + "{}", valid + "false", valid[:len(valid)-1],
		`{"state":"claimed","state":"claimed","claim":` + raw + `}`,
		`{"State":"claimed","claim":` + raw + `}`, `{"state":"claimed","claim":null}`,
		`{"state":"claimed","claim":` + raw + `,"reason":"launch_blocked"}`,
		`{"state":"expired","reason":"launch_blocked"}`, `{"state":"started","reason":"launch_blocked"}`,
		`{"state":"expired","reason":null}`, `{"state":"expired","reason":"launch_expired","shell":"forbidden"}`,
		strings.Replace(valid, `"schema_version":1`, `"schema_version":1,"schema_version":1`, 1),
		strings.Replace(valid, `"assignment_generation":1`, `"assignment_generation":2`, 1),
		strings.Replace(valid, `"schema_version":1`, `"schema_version":1,"argv":[]`, 1),
		strings.Repeat(" ", 40001) + valid,
	} {
		if _, err := claimOutcome([]byte(data), command); err == nil {
			t.Fatal("ambiguous or inconsistent claim accepted")
		}
	}
}

func receiptFixture(claim generated.LaunchClaimResult, state string) generated.LaunchReconciliation {
	sequence := int64(0)
	receipt := generated.LaunchReconciliation{
		SchemaVersion: 1, WorkspaceId: claim.Assignment.WorkspaceId, RunnerId: claim.Assignment.RunnerId,
		LaunchId: claim.Specification.LaunchId, RunExecutionId: claim.Assignment.RunExecutionId,
		AssignmentGeneration: claim.Assignment.AssignmentGeneration, PhysicalWorktreeHash: claim.Snapshot.PhysicalWorktreeHash,
		LaunchState: "rejected", ReservationState: state,
	}
	if state != "never_acquired" && state != "superseded" {
		receipt.FencingGeneration, receipt.ObservationSequence, receipt.LeaseExpiresAt = &claim.FencingGeneration, &sequence, &claim.LeaseExpiresAt
	}
	return receipt
}

func TestCleanupNeverAcquiredReceiptMakesNoLeaseMutation(t *testing.T) {
	store, _, claim, now := fixtureIntents(t)
	command := acceptFixture(t, store, claim, now)
	service := NewService(ServiceOptions{Now: func() time.Time { return now }})
	requests := 0
	connection := &finalConnection{request: func(ctx context.Context, method, path string, body []byte) ([]byte, error) {
		requests++
		expected, _ := claimRequest(command)
		current, err := store.Command(ctx, command.RunnerID, command.ID)
		if err != nil || current.CleanupLockID == "" || method != "POST" || path != "launch/reconcile" || string(body) != string(expected) {
			t.Fatal("cleanup request preceded local barrier or changed original claim", err)
		}
		return encodedFixture(t, receiptFixture(claim, "never_acquired")), nil
	}}
	if err := service.cleanupUnstarted(context.Background(), store, command, connection); err != nil {
		t.Fatal(err)
	}
	completed, _ := store.Command(context.Background(), command.RunnerID, command.ID)
	if requests != 1 || completed.State != "complete" || completed.ClaimKey != command.ClaimKey {
		t.Fatal("unclaimed cleanup mutated lease or lost its original identity")
	}
}

func TestCleanupLostReleaseReplySettlesAfterRestartWithoutResending(t *testing.T) {
	ctx := context.Background()
	store, local, claim, now := fixtureIntents(t)
	assignment := issueFixture(t, store, claim, now)
	if _, err := store.Offer(ctx, assignment.IntentID); err != nil {
		t.Fatal(err)
	}
	command, _ := store.Command(ctx, claim.Assignment.RunnerId, claim.Specification.LaunchId)
	service := NewService(ServiceOptions{Now: func() time.Time { return now }})
	released, releaseRequests := false, 0
	var cleanupID string
	connection := &finalConnection{request: func(ctx context.Context, _, path string, body []byte) ([]byte, error) {
		current, err := store.Command(ctx, command.RunnerID, command.ID)
		blocked, readErr := store.ByIntent(ctx, assignment.IntentID)
		if err != nil || readErr != nil || current.CleanupLockID == "" || blocked.State != "blocked" || blocked.Supervisor != nil {
			t.Fatal("network effect preceded unstarted barrier")
		}
		if cleanupID != "" && cleanupID != current.CleanupLockID {
			t.Fatal("restart changed cleanup identity")
		}
		cleanupID = current.CleanupLockID
		switch path {
		case "launch/reconcile":
			expected, _ := claimRequest(command)
			if string(body) != string(expected) {
				t.Fatal("cleanup changed claim identity")
			}
			state := "reserved"
			if released {
				state = "released"
			}
			return encodedFixture(t, receiptFixture(claim, state)), nil
		case "launch/reject":
			if !protocol.DecodeWireDocument("launch-reject-request", body).OK {
				t.Fatal("invalid rejection request")
			}
			return []byte(`{"state":"rejected"}`), nil
		case "leases/observe":
			releaseRequests++
			var observation generated.CheckoutLeaseObservation
			if !protocol.DecodeWireDocument("checkout-lease-observation", body).OK || json.Unmarshal(body, &observation) != nil || observation.LocalLockId != cleanupID || observation.Supervisor != nil || observation.SupervisorState != "never_started" || observation.LockState != "never_acquired" || observation.OwnedGroupId != 0 || observation.RecoveryLocal || observation.Operation != "release" || observation.Sequence != 1 || observation.RunExecutionId != claim.Assignment.RunExecutionId {
				t.Fatal("incorrect unstarted release proof")
			}
			released = true
			return nil, errors.New("synthetic lost release acknowledgement")
		default:
			t.Fatal("unexpected cloud effect", path)
			return nil, errors.New("unexpected request")
		}
	}}
	if err := service.cleanupUnstarted(ctx, store, command, connection); err == nil {
		t.Fatal("lost acknowledgement treated as confirmed release")
	}
	pending, _ := store.Command(ctx, command.RunnerID, command.ID)
	if pending.State != "waiting" {
		t.Fatal("lost acknowledgement completed local command")
	}
	if err := local.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := daemon.OpenStore(ctx, local.Paths)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	store = NewIntentStore(reopened.DB)
	if err = service.cleanupUnstarted(ctx, store, pending, connection); err != nil {
		t.Fatal(err)
	}
	completed, _ := store.Command(ctx, command.RunnerID, command.ID)
	if completed.State != "complete" || releaseRequests != 1 || completed.CleanupLockID != cleanupID {
		t.Fatal("restart did not reconcile the original release")
	}
}

func TestCleanupRejectsConfusedReceiptAndRetainsReservation(t *testing.T) {
	for _, fault := range []string{"offline", "malformed", "duplicate", "extra", "workspace", "runner", "launch", "execution", "generation", "physical", "fence", "live", "unknown", "contradictory_absence", "started", "sequence_overflow"} {
		t.Run(fault, func(t *testing.T) {
			ctx := context.Background()
			store, _, claim, now := fixtureIntents(t)
			_ = issueFixture(t, store, claim, now)
			command, _ := store.Command(ctx, claim.Assignment.RunnerId, claim.Specification.LaunchId)
			service := NewService(ServiceOptions{Now: func() time.Time { return now }})
			leaseRequests := 0
			connection := &finalConnection{request: func(_ context.Context, _, path string, _ []byte) ([]byte, error) {
				if path == "leases/observe" {
					leaseRequests++
				}
				if path == "launch/reject" {
					return []byte(`{"state":"rejected"}`), nil
				}
				receipt := receiptFixture(claim, "reserved")
				switch fault {
				case "offline":
					return nil, errors.New("synthetic denied or offline")
				case "malformed":
					return []byte(`{"state":"released"}`), nil
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
					receipt.PhysicalWorktreeHash = provider.Hash(nil)
				case "fence":
					*receipt.FencingGeneration++
				case "live":
					receipt.ReservationState = "live"
				case "unknown":
					receipt.ReservationState = "containment_unknown"
				case "contradictory_absence":
					receipt = receiptFixture(claim, "never_acquired")
				case "started":
					receipt.LaunchState = "started"
				case "sequence_overflow":
					*receipt.ObservationSequence = 9007199254740991
				}
				data := encodedFixture(t, receipt)
				if fault == "duplicate" {
					data = []byte(strings.Replace(string(data), `"schema_version":1`, `"schema_version":1,"schema_version":1`, 1))
				}
				if fault == "extra" {
					data = []byte(strings.Replace(string(data), `"schema_version":1`, `"schema_version":1,"argv":[]`, 1))
				}
				return data, nil
			}}
			if err := service.cleanupUnstarted(ctx, store, command, connection); err == nil {
				t.Fatal("untrusted receipt released or completed command")
			}
			current, _ := store.Command(ctx, command.RunnerID, command.ID)
			if current.State != "waiting" || current.CleanupLockID == "" || leaseRequests != 0 {
				t.Fatal("failed reconciliation lost barrier or mutated lease")
			}
		})
	}
}

func TestCleanupRegisteredOwnerMakesNoCloudRequest(t *testing.T) {
	ctx := context.Background()
	store, _, claim, now := fixtureIntents(t)
	assignment := issueFixture(t, store, claim, now)
	if _, err := store.Offer(ctx, assignment.IntentID); err != nil {
		t.Fatal(err)
	}
	owner := SupervisorIdentity{Process: fixtureProcess(1201, 1, 1201), ExecutableHash: provider.Hash(nil)}
	if _, err := store.Register(ctx, assignment.IntentID, owner, now); err != nil {
		t.Fatal(err)
	}
	command, _ := store.Command(ctx, claim.Assignment.RunnerId, claim.Specification.LaunchId)
	service := NewService(ServiceOptions{Now: func() time.Time { return now }})
	connection := &finalConnection{request: func(context.Context, string, string, []byte) ([]byte, error) {
		t.Fatal("registered owner used unstarted cloud cleanup")
		return nil, errors.New("unexpected request")
	}}
	assertFailure(t, service.cleanupUnstarted(ctx, store, command, connection), "containment_unknown")
	current, _ := store.Command(ctx, command.RunnerID, command.ID)
	if current.CleanupLockID != "" {
		t.Fatal("registered owner received invented never-acquired lock identity")
	}
}

func TestCleanupExpiredPendingClaimTerminalizesWithoutIssuing(t *testing.T) {
	ctx := context.Background()
	store, _, claim, now := fixtureIntents(t)
	command := acceptFixture(t, store, claim, now)
	command, err := store.BeginUnstartedCleanup(ctx, command)
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(ServiceOptions{Now: func() time.Time { return now.Add(3 * time.Minute) }})
	terminalized, requests := false, 0
	connection := &finalConnection{request: func(_ context.Context, _, path string, body []byte) ([]byte, error) {
		requests++
		expected, _ := claimRequest(command)
		if string(body) != string(expected) {
			t.Fatal("terminalization changed the original claim")
		}
		if path == "launch/claim" {
			terminalized = true
			return []byte(`{"state":"expired","reason":"launch_expired"}`), nil
		}
		if path != "launch/reconcile" {
			t.Fatal("terminalization performed another effect", path)
		}
		if !terminalized {
			return nil, errors.New("synthetic pending unclaimed command")
		}
		return encodedFixture(t, receiptFixture(claim, "never_acquired")), nil
	}}
	if err := service.cleanupUnstarted(ctx, store, command, connection); err != nil || requests != 3 {
		t.Fatal("expired pending claim did not settle", err)
	}
	if assignment, err := store.ByCommand(ctx, command); err != nil || assignment != nil {
		t.Fatal("cleanup-only claim produced an execution assignment", err)
	}
}

func TestCleanupDoesNotTrustReleaseStatusWithoutBoundReceipt(t *testing.T) {
	ctx := context.Background()
	store, _, claim, now := fixtureIntents(t)
	command := acceptFixture(t, store, claim, now)
	service := NewService(ServiceOptions{Now: func() time.Time { return now }})
	released := false
	connection := &finalConnection{request: func(_ context.Context, _, path string, _ []byte) ([]byte, error) {
		switch path {
		case "launch/reconcile":
			receipt := receiptFixture(claim, "reserved")
			if released {
				receipt.ReservationState = "released"
				receipt.RunExecutionId = daemon.NewRequestID()
			}
			return encodedFixture(t, receipt), nil
		case "leases/observe":
			released = true
			return []byte(`{"state":"released"}`), nil
		case "launch/reject":
			return []byte(`{"state":"rejected"}`), nil
		}
		return nil, errors.New("unexpected request")
	}}
	if err := service.cleanupUnstarted(ctx, store, command, connection); err == nil {
		t.Fatal("conflicting release receipt completed command")
	}
	current, _ := store.Command(ctx, command.RunnerID, command.ID)
	if current.State != "waiting" || current.CleanupLockID == "" {
		t.Fatal("conflicting release receipt discarded cleanup binding")
	}
}
