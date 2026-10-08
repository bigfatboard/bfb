// ABOUTME: Tests atomic native-observation capture, durable heartbeat cadence and bounded final-hook windows.
// ABOUTME: Injects synthetic process facts at the store boundary without simulating native lifecycle acceptance.

package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
)

func observationFixture(t *testing.T) (*IntentStore, *daemon.Store, LocalAssignment, time.Time) {
	t.Helper()
	store, local, claim, now := fixtureIntents(t)
	assignment := issueFixture(t, store, claim, now)
	if ok, err := store.Offer(context.Background(), assignment.IntentID); !ok || err != nil {
		t.Fatal(err)
	}
	owner := SupervisorIdentity{Process: fixtureProcess(1201, 1, 1201), ExecutableHash: provider.Hash(nil)}
	assignment, err := store.Register(context.Background(), assignment.IntentID, owner, now)
	if err != nil {
		t.Fatal(err)
	}
	lockID := daemon.NewRequestID()
	if _, err = store.PinOwnership(context.Background(), assignment.IntentID, owner, lockID, nil, now); err != nil {
		t.Fatal(err)
	}
	child := fixtureProcess(1202, 1201, 1202)
	assignment, err = store.PinOwnership(context.Background(), assignment.IntentID, owner, lockID, &child, now)
	if err != nil {
		t.Fatal(err)
	}
	return store, local, assignment, now
}

func captureFixture(t *testing.T, store *IntentStore, assignment LocalAssignment, capture processCapture, now time.Time, kind string) *generated.LocalExecutionObservation {
	t.Helper()
	event, err := store.captureProcess(context.Background(), assignment, capture, now)
	if err != nil || (kind == "") != (event == nil) || (event != nil && event.Kind != kind) {
		t.Fatalf("capture wanted %q: %+v, %v", kind, event, err)
	}
	return event
}

func TestProcessObservationsDoNotInferStartupOrBackfillHeartbeats(t *testing.T) {
	ctx := context.Background()
	store, local, assignment, now := observationFixture(t)
	captureFixture(t, store, assignment, processCapture{State: "live"}, now, "")
	first := captureFixture(t, store, assignment, processCapture{State: "live", ProviderImage: true}, now.Add(time.Second), "execution_attached")
	if first.Sequence != 1 || first.ProviderStart != "observed" || first.CaptureOrigin != "runner_observed" || first.ProcessState != "live" {
		t.Fatal("startup fact lost its provenance")
	}
	for _, offset := range []time.Duration{time.Second, 15 * time.Second, 16*time.Second - time.Microsecond} {
		captureFixture(t, store, assignment, processCapture{State: "live", ProviderImage: true}, now.Add(offset), "")
	}
	second := captureFixture(t, store, assignment, processCapture{State: "live"}, now.Add(16*time.Second), "heartbeat")
	if second.Sequence != 2 || second.OccurredAt != localTimestamp(now.Add(16*time.Second)) {
		t.Fatal("heartbeat lost its native observation time")
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
	third := captureFixture(t, store, assignment, processCapture{State: "live"}, now.Add(time.Hour), "heartbeat")
	events, err := store.PendingObservations(ctx, 256)
	if err != nil || len(events) != 3 || events[0] != *first || events[1] != *second || events[2] != *third || third.Sequence != 3 || third.ProviderStart != "observed" {
		t.Fatal("restart duplicated observations or fabricated missed heartbeats", err)
	}
	checkpoint, err := store.observationCheckpoint(ctx, assignment.IntentID)
	if err != nil || checkpoint.ProviderObserved != first.OccurredAt || checkpoint.LastObserved != third.OccurredAt {
		t.Fatal("startup identity or cadence changed across restart", err)
	}
	// Historical capture after expiry must not create fresh launch authority.
	_, err = store.PinOwnership(ctx, assignment.IntentID, *assignment.Supervisor, assignment.LockID, nil, now.Add(time.Hour))
	if err == nil {
		t.Fatal("process history reopened launch authorization")
	}
}

func TestConcurrentProcessCaptureHasOneEffectiveSequence(t *testing.T) {
	store, _, assignment, now := observationFixture(t)
	for _, phase := range []struct {
		offset time.Duration
		kind   string
	}{{0, "execution_attached"}, {15 * time.Second, "heartbeat"}, {16 * time.Second, "execution_ended"}} {
		results := make(chan *generated.LocalExecutionObservation, 20)
		var workers sync.WaitGroup
		for range 20 {
			workers.Go(func() {
				capture := processCapture{State: "live", ProviderImage: true}
				if phase.kind == "execution_ended" {
					capture = processCapture{State: "gone"}
				}
				event, err := store.captureProcess(context.Background(), assignment, capture, now.Add(phase.offset))
				if err != nil {
					t.Error(err)
				}
				if event != nil {
					results <- event
				}
			})
		}
		workers.Wait()
		close(results)
		if len(results) != 1 || (<-results).Kind != phase.kind {
			t.Fatal("concurrent capture duplicated a local effect", phase.kind)
		}
	}
	events, err := store.PendingObservations(context.Background(), 256)
	if err != nil || len(events) != 3 {
		t.Fatal(err)
	}
	for index, event := range events {
		if event.Sequence != int64(index+1) {
			t.Fatal("sequence has a gap")
		}
	}
}

func TestImportedObservationRemovalCannotEraseStartupOrCadence(t *testing.T) {
	store, _, assignment, now := observationFixture(t)
	first := captureFixture(t, store, assignment, processCapture{State: "live", ProviderImage: true}, now, "execution_attached")
	if _, err := store.db.Exec("UPDATE execution_observations SET imported_at = ? WHERE event_id = ?", localTimestamp(now), first.EventId); err != nil {
		t.Fatal(err)
	}
	if events, err := store.PendingObservations(context.Background(), 256); err != nil || len(events) != 0 {
		t.Fatal("reader returned an already imported observation", err)
	}
	// Simulate the future journal's acknowledged retention cleanup, not a
	// production deletion API or deletion merely because a read succeeded.
	if _, err := store.db.Exec("DELETE FROM execution_observations WHERE imported_at IS NOT NULL"); err != nil {
		t.Fatal(err)
	}
	captureFixture(t, store, assignment, processCapture{State: "live", ProviderImage: true}, now.Add(time.Second), "")
	event := captureFixture(t, store, assignment, processCapture{State: "live"}, now.Add(processHeartbeatInterval), "heartbeat")
	if event.Sequence != 2 || event.ProviderStart != "observed" {
		t.Fatal("journal cleanup erased durable process history")
	}
	for _, limit := range []int{-1, 0, 257} {
		_, err := store.PendingObservations(context.Background(), limit)
		assertFailure(t, err, "invalid_request")
	}
	for _, sql := range []string{
		"UPDATE local_execution_assignments SET provider_observed_at = NULL",
		"UPDATE local_execution_assignments SET provider_observed_at = '2026-09-12T12:01:00Z'",
		"UPDATE local_execution_assignments SET last_process_observed_at = NULL",
		"UPDATE local_execution_assignments SET last_process_observed_at = '2026-09-12T12:01:00Z'",
		"UPDATE local_execution_assignments SET event_sequence = 1",
	} {
		if _, err := store.db.Exec(sql); err == nil {
			t.Fatal("durable observation checkpoint could be cleared or rewound")
		}
	}
}

func TestProcessAbsenceClosesCreationWithoutDiscardingReplay(t *testing.T) {
	ctx := context.Background()
	for _, started := range []bool{false, true} {
		t.Run(fmt.Sprint(started), func(t *testing.T) {
			store, _, assignment, now := observationFixture(t)
			if started {
				captureFixture(t, store, assignment, processCapture{State: "live", ProviderImage: true}, now, "execution_attached")
			}
			endedAt := now.Add(time.Second)
			event := captureFixture(t, store, assignment, processCapture{State: "gone"}, endedAt, "execution_ended")
			if (event.ProviderStart == "observed") != started || event.ProcessState != "gone" {
				t.Fatal("absence invented provider startup or a never-started fact")
			}
			for _, offset := range []time.Duration{time.Second, time.Hour} {
				captureFixture(t, store, assignment, processCapture{State: "gone"}, endedAt.Add(offset), "")
			}
			for _, item := range []struct {
				stamp time.Time
				open  bool
			}{{now.Add(-time.Microsecond), false}, {now, true}, {endedAt.Add(finalHookGrace - time.Microsecond), true}, {endedAt.Add(finalHookGrace), false}, {endedAt.Add(time.Hour), false}} {
				open, err := store.eventWindowOpen(ctx, assignment.IntentID, item.stamp)
				if err != nil || open != item.open {
					t.Fatal("wrong final-hook boundary", item, err)
				}
			}
			if err := store.closeEventWindows(ctx, endedAt.Add(finalHookGrace-time.Microsecond)); err != nil {
				t.Fatal(err)
			}
			current, _ := store.ByIntent(ctx, assignment.IntentID)
			if current.State != "ending" {
				t.Fatal("grace ended early")
			}
			if err := store.closeEventWindows(ctx, endedAt.Add(finalHookGrace)); err != nil {
				t.Fatal(err)
			}
			current, _ = store.ByIntent(ctx, assignment.IntentID)
			if current.State != "ended" {
				t.Fatal("grace did not close")
			}
			events, err := store.PendingObservations(ctx, 256)
			if err != nil || len(events) != int(event.Sequence) || events[len(events)-1].EventId != event.EventId {
				t.Fatal("event creation close discarded accepted replay", err)
			}
			_, err = store.captureProcess(ctx, assignment, processCapture{State: "live", ProviderImage: true}, endedAt.Add(time.Hour))
			assertFailure(t, err, "execution_assignment_invalid")
			for _, column := range []string{"process_absent_at", "event_window_ends_at"} {
				if _, err := store.db.Exec("UPDATE local_execution_assignments SET " + column + " = NULL"); err == nil {
					t.Fatal("terminal observation was cleared", column)
				}
			}
		})
	}
}

func TestUnknownCaptureIsStickyAndDoesNotBecomeAResult(t *testing.T) {
	store, _, assignment, now := observationFixture(t)
	captureFixture(t, store, assignment, processCapture{State: "live", ProviderImage: true}, now, "execution_attached")
	event := captureFixture(t, store, assignment, processCapture{State: "unknown"}, now.Add(time.Second), "execution_detached")
	if event.Diagnostic == nil || *event.Diagnostic != "containment_unknown" || event.ProviderStart != "observed" {
		t.Fatal("unknown lost its diagnostic or historical image")
	}
	captureFixture(t, store, assignment, processCapture{State: "unknown"}, now.Add(time.Hour), "")
	captureFixture(t, store, assignment, processCapture{State: "live", ProviderImage: true}, now.Add(time.Hour), "")
	captureFixture(t, store, assignment, processCapture{State: "gone"}, now.Add(2*time.Hour), "execution_ended")
	if err := store.closeEventWindows(context.Background(), now.Add(3*time.Hour)); err != nil {
		t.Fatal(err)
	}
	current, err := store.ByIntent(context.Background(), assignment.IntentID)
	if err != nil || current.State != "containment_unknown" || current.LockID != assignment.LockID || *current.Group != *assignment.Group {
		t.Fatal("absence or grace silently cleared containment ownership", err)
	}
}

func TestUnstartedCaptureRequiresDurableBarrierAndRedactsReasons(t *testing.T) {
	for _, reason := range []error{failure("expired_intent"), errors.New("synthetic-private-content"), failure("synthetic_private_content")} {
		store, _, claim, now := fixtureIntents(t)
		assignment := issueFixture(t, store, claim, now)
		command, err := store.Command(context.Background(), claim.Assignment.RunnerId, claim.Specification.LaunchId)
		if err != nil {
			t.Fatal(err)
		}
		_, err = store.captureProcess(context.Background(), assignment, processCapture{State: "never_started", Diagnostic: reason}, now)
		assertFailure(t, err, "execution_assignment_invalid")
		if _, err = store.BeginUnstartedCleanup(context.Background(), command); err != nil {
			t.Fatal(err)
		}
		event := captureFixture(t, store, assignment, processCapture{State: "never_started", Diagnostic: reason}, now, "launch_blocked")
		if event.ProviderStart != "unobserved" || event.Diagnostic == nil || strings.Contains(*event.Diagnostic, "synthetic") {
			t.Fatal("unstarted observation leaked an unbounded reason")
		}
		if open, err := store.eventWindowOpen(context.Background(), assignment.IntentID, now); err != nil || open {
			t.Fatal("unstarted assignment acquired a hook window", err)
		}
	}
}

func TestObservationFailuresRollbackBothEventAndCheckpoint(t *testing.T) {
	for _, fault := range []string{"insert", "update", "sequence_exhausted", "capacity"} {
		t.Run(fault, func(t *testing.T) {
			store, _, assignment, now := observationFixture(t)
			captureFixture(t, store, assignment, processCapture{State: "live", ProviderImage: true}, now, "execution_attached")
			switch fault {
			case "insert":
				_, err := store.db.Exec("CREATE TRIGGER fail_observation BEFORE INSERT ON execution_observations BEGIN SELECT RAISE(ABORT,'synthetic-private-content'); END")
				if err != nil {
					t.Fatal(err)
				}
			case "update":
				_, err := store.db.Exec("CREATE TRIGGER fail_checkpoint BEFORE UPDATE OF event_sequence ON local_execution_assignments BEGIN SELECT RAISE(ABORT,'synthetic-private-content'); END")
				if err != nil {
					t.Fatal(err)
				}
			case "sequence_exhausted":
				if _, err := store.db.Exec("UPDATE local_execution_assignments SET event_sequence = ?", maxObservationSequence); err != nil {
					t.Fatal(err)
				}
			case "capacity":
				if _, err := store.db.Exec(`WITH RECURSIVE counts(n) AS (SELECT 2 UNION ALL SELECT n+1 FROM counts WHERE n < ?)
INSERT INTO execution_observations(event_id,execution_id,assignment_generation,sequence,observation_json,captured_at)
SELECT printf('synthetic-%d',n),?,?,n,'{}',? FROM counts`, observationCapacity, assignment.Claim.Assignment.RunExecutionId, assignment.Claim.Assignment.AssignmentGeneration, localTimestamp(now)); err != nil {
					t.Fatal(err)
				}
			}
			before, err := store.observationCheckpoint(context.Background(), assignment.IntentID)
			if err != nil {
				t.Fatal(err)
			}
			var countBefore, countAfter int
			if err = store.db.QueryRow("SELECT count(*) FROM execution_observations").Scan(&countBefore); err != nil {
				t.Fatal(err)
			}
			_, err = store.captureProcess(context.Background(), assignment, processCapture{State: "gone"}, now.Add(time.Minute))
			code := "storage_failed"
			if fault == "capacity" || fault == "sequence_exhausted" {
				code = "execution_capacity"
			}
			assertFailure(t, err, code)
			after, err := store.observationCheckpoint(context.Background(), assignment.IntentID)
			if err != nil || before != after {
				t.Fatal("checkpoint survived failed capture", err)
			}
			current, _ := store.ByIntent(context.Background(), assignment.IntentID)
			if current.State != "running" {
				t.Fatal("state survived failed capture")
			}
			if err = store.db.QueryRow("SELECT count(*) FROM execution_observations").Scan(&countAfter); err != nil || countBefore != countAfter {
				t.Fatal("event survived failed transaction", err)
			}
		})
	}
}

func TestProcessCaptureRejectsBindingConfusionAndClockRewind(t *testing.T) {
	for _, fault := range []string{"intent", "execution", "generation", "lock", "supervisor", "group", "clock", "never_started", "unsupported", "unknown_image"} {
		t.Run(fault, func(t *testing.T) {
			store, _, assignment, now := observationFixture(t)
			captureFixture(t, store, assignment, processCapture{State: "live", ProviderImage: true}, now, "execution_attached")
			capture := processCapture{State: "live"}
			switch fault {
			case "intent":
				assignment.IntentID = "e0da52a9-d0cb-47d8-867b-e08f684b9001"
			case "execution":
				assignment.Claim.Assignment.RunExecutionId = daemon.NewRequestID()
			case "generation":
				assignment.Claim.Assignment.AssignmentGeneration++
			case "lock":
				assignment.LockID = daemon.NewRequestID()
			case "supervisor":
				assignment.Supervisor.Process.StartIdentity = "9999:9999"
			case "group":
				assignment.Group.StartIdentity = "9999:9999"
			case "clock":
				now = now.Add(-time.Microsecond)
			case "never_started":
				capture = processCapture{State: "never_started", Diagnostic: failure("expired_intent")}
			case "unsupported":
				capture.State = "working"
			case "unknown_image":
				capture = processCapture{State: "unknown", ProviderImage: true}
			}
			if _, err := store.captureProcess(context.Background(), assignment, capture, now); err == nil {
				t.Fatal("confused capture accepted")
			}
			events, err := store.PendingObservations(context.Background(), 256)
			if err != nil || len(events) != 1 {
				t.Fatal("failed capture changed events", err)
			}
		})
	}
}

func TestPendingObservationValidationRejectsPrivateOrReboundData(t *testing.T) {
	for _, fault := range []string{"event", "execution", "generation", "sequence", "time", "origin", "result", "oversize"} {
		t.Run(fault, func(t *testing.T) {
			store, _, assignment, now := observationFixture(t)
			event := captureFixture(t, store, assignment, processCapture{State: "live", ProviderImage: true}, now, "execution_attached")
			data, _ := json.Marshal(event)
			var value map[string]any
			_ = json.Unmarshal(data, &value)
			switch fault {
			case "event":
				value["event_id"] = daemon.NewRequestID()
			case "execution":
				value["run_execution_id"] = daemon.NewRequestID()
			case "generation":
				value["assignment_generation"] = event.AssignmentGeneration + 1
			case "sequence":
				value["sequence"] = event.Sequence + 1
			case "time":
				value["occurred_at"] = localTimestamp(now.Add(time.Second))
			case "origin":
				value["capture_origin"] = "agent_reported"
			case "result":
				value["result"] = "accepted"
			case "oversize":
				value["kind"] = strings.Repeat("X", 8100)
			}
			data, _ = json.Marshal(value)
			_, err := store.db.Exec("UPDATE execution_observations SET observation_json = ?", string(data))
			if fault == "oversize" {
				if err == nil {
					t.Fatal("oversized observation passed storage bound")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			_, err = store.PendingObservations(context.Background(), 256)
			assertFailure(t, err, "execution_assignment_invalid")
		})
	}
}
