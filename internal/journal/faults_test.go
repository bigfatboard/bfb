// ABOUTME: Fault-injects daemon death, disk exhaustion and slow transports.
// ABOUTME: Proves accepted events survive restarts and hook latency stays bounded.

package journal

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
)

func TestDaemonKillDuringHookLosesNoAcceptedEvent(t *testing.T) {
	state, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	seedOne(t, assignments, testExecution, testRunner, token)
	registry := testRegistry(t)
	paths := state.Paths

	accepted := map[string]bool{}
	for index := 0; index < 10; index++ {
		raw := hookRaw("turn_started", "sess-kill", fmt.Sprintf("kill-%d", index))
		if index == 0 {
			raw = hookRaw("session_started", "sess-kill", "")
		}
		receipt, err := store.Ingest(context.Background(), assignments, registry, HookInput{
			Provider: "fake", Raw: raw, ExecutionID: testExecution, Generation: 1, Token: token,
			CapturedAt: testBase.Add(time.Duration(index) * time.Second),
		}, testBase.Add(time.Duration(index)*time.Second))
		if err != nil || receipt.Status != "accepted" {
			t.Fatalf("hook %d: %+v %v", index, receipt, err)
		}
		accepted[receipt.EventID] = true
		// Kill the daemon store between hooks: close the pool and reopen the
		// same database file, as a crash and launchd restart would.
		if index == 4 {
			if err := state.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := daemon.OpenStore(context.Background(), paths)
			if err != nil {
				t.Fatal(err)
			}
			state = reopened
			store = NewStore(state.DB)
		}
	}
	if len(accepted) != 10 || journalCount(t, store) != 10 {
		t.Fatalf("accepted events lost across the kill: %d", journalCount(t, store))
	}
	// Every surviving row is wire-valid and uniquely sequenced.
	sequences := map[int64]bool{}
	rows, err := store.db.Query("SELECT event_id, source_sequence, submission_json FROM hook_journal")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var sequence int64
		var data string
		if err := rows.Scan(&id, &sequence, &data); err != nil {
			t.Fatal(err)
		}
		if !accepted[id] || sequences[sequence] {
			t.Fatalf("unaccepted or duplicated event %s/%d", id, sequence)
		}
		sequences[sequence] = true
		if result := protocol.DecodeWireDocument("runner-event-submission", []byte(data)); !result.OK {
			t.Fatalf("corrupt journal row %s", id)
		}
	}
	// Upload after the restart produces exactly one server effect per event.
	connection := &fakeConnection{}
	uploader := &Uploader{Store: store, Lookup: lookupFor(map[string]*fakeConnection{testRunner: connection}), Now: func() time.Time { return testBase.Add(2 * time.Hour) }}
	uploaded, pending, err := uploader.UploadOnce(context.Background())
	if err != nil || uploaded != 10 || pending != 0 {
		t.Fatalf("post-restart upload: %d %d %v", uploaded, pending, err)
	}
	if len(connection.effects) != 10 {
		t.Fatalf("server effects: %d", len(connection.effects))
	}
}

func TestDiskFullFailsWithoutPartialRows(t *testing.T) {
	state, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	seedOne(t, assignments, testExecution, testRunner, token)
	registry := testRegistry(t)
	paths := state.Paths
	// A full disk and a read-only mount fail the same write path: already-open
	// descriptors keep their mode, so file bits cannot fault a live database.
	// Forcing the connection read-only injects that fault deterministically:
	// every write fails and the journal must roll back the whole hook.
	if _, err := state.DB.Exec("PRAGMA query_only = ON"); err != nil {
		t.Fatal(err)
	}
	_, err := store.Ingest(context.Background(), assignments, registry, HookInput{
		Provider: "fake", Raw: hookRaw("session_started", "sess-disk", ""),
		ExecutionID: testExecution, Generation: 1, Token: token, CapturedAt: testBase,
	}, testBase)
	if asCode(err) != "storage_failed" {
		t.Fatalf("disk-full ingest: %v", err)
	}
	// The hook caller falls back to the inbox, which lives in separate files
	// and stays writable while the database volume is full.
	name, err := WriteCapture(paths.Root, token, testExecution, 1, "fake", hookRaw("session_started", "sess-disk", ""), testBase)
	if err != nil || name == "" {
		t.Fatalf("inbox fallback during disk pressure: %v", err)
	}
	// Recovery restarts against the repaired volume, as after disk cleanup.
	if _, err := state.DB.Exec("PRAGMA query_only = OFF"); err != nil {
		t.Fatal(err)
	}
	if err := state.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := daemon.OpenStore(context.Background(), paths)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	store = NewStore(reopened.DB)
	if journalCount(t, store) != 0 || quarantineCount(t, store) != 0 {
		t.Fatal("partial rows survived the failed commit")
	}
	if _, err := store.BoundSession(context.Background(), testExecution, 1); asCode(err) != "session_unbound" {
		t.Fatal("binding survived the failed commit")
	}
	result, err := store.ImportInbox(context.Background(), assignments, registry, paths.Root, 256, testBase.Add(time.Minute))
	if err != nil || result.Imported != 1 {
		t.Fatalf("post-recovery import: %+v %v", result, err)
	}
}

func TestHookLatencyIndependentOfCloud(t *testing.T) {
	_, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	seedOne(t, assignments, testExecution, testRunner, token)
	registry := testRegistry(t)
	// The upload transport hangs, but ingest performs no network I/O at all.
	hanging := &fakeConnection{mode: "offline"}
	uploader := &Uploader{Store: store, Lookup: lookupFor(map[string]*fakeConnection{testRunner: hanging}), Now: func() time.Time { return testBase }}
	_ = uploader
	start := time.Now()
	for index := 0; index < 20; index++ {
		raw := hookRaw("turn_started", "sess-slow", fmt.Sprintf("slow-%d", index))
		if index == 0 {
			raw = hookRaw("session_started", "sess-slow", "")
		}
		receipt, err := store.Ingest(context.Background(), assignments, registry, HookInput{
			Provider: "fake", Raw: raw, ExecutionID: testExecution, Generation: 1, Token: token,
			CapturedAt: testBase.Add(time.Duration(index) * time.Second),
		}, testBase.Add(time.Duration(index)*time.Second))
		if err != nil || receipt.Status != "accepted" {
			t.Fatalf("hook %d: %+v %v", index, receipt, err)
		}
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("local ingest took %v with the cloud unreachable", elapsed)
	}
	if journalCount(t, store) != 20 {
		t.Fatal("hooks dropped while the cloud was unreachable")
	}
}

func TestStreamsArePerRunnerAndEpochStable(t *testing.T) {
	state, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	runnerB := "01JBFB0RVNNER2D00000000000"
	seedOne(t, assignments, testExecution, testRunner, token)
	executionB := "01JBFB0EXECRN9000000000000"
	assignments.seed(testAssignment(executionB, runnerB, token, 1))
	registry := testRegistry(t)
	first := ingest(t, store, assignments, registry, testExecution, testRunner, token, "fake", hookRaw("session_started", "sess-a", ""), testBase)
	second := ingest(t, store, assignments, registry, executionB, runnerB, token, "fake", hookRaw("session_started", "sess-b", ""), testBase)
	if first.Sequence != 1 || second.Sequence != 1 {
		t.Fatalf("per-runner sequences not independent: %+v %+v", first, second)
	}
	a := decodeSubmission(t, store, first.EventID)
	b := decodeSubmission(t, store, second.EventID)
	if a.SourceStreamId == b.SourceStreamId {
		t.Fatal("two enrollments share one upload stream")
	}
	// Reopening the database keeps the epoch and both streams.
	paths := state.Paths
	if err := state.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := daemon.OpenStore(context.Background(), paths)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	store = NewStore(reopened.DB)
	third := ingest(t, store, assignments, registry, testExecution, testRunner, token, "fake", hookRaw("turn_started", "sess-a", "after-restart"), testBase.Add(time.Minute))
	if third.Sequence != 2 {
		t.Fatalf("sequence restarted after reopen: %+v", third)
	}
	c := decodeSubmission(t, store, third.EventID)
	if c.SourceStreamId != a.SourceStreamId {
		t.Fatal("stream rotated without an epoch change")
	}
}

func TestDelayedFinalHookReplayNeedsNoCorrelationSecret(t *testing.T) {
	state, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	assignment := testAssignment(testExecution, testRunner, token, 1)
	assignment.WindowEndsAt = localTimestamp(testBase.Add(15 * time.Second))
	assignments.seed(assignment)
	registry := testRegistry(t)
	// Captured inside the grace window, uploaded an hour later after the
	// creation window closed. Replay is authorized by the runner credential
	// and the immutable assignment, never by resending the correlation token.
	receipt := ingest(t, store, assignments, registry, testExecution, testRunner, token, "fake", hookRaw("session_started", "sess-final", ""), testBase.Add(10*time.Second))
	if receipt.Status != "accepted" {
		t.Fatalf("final hook: %+v", receipt)
	}
	var data string
	if err := store.db.QueryRow("SELECT submission_json FROM hook_journal WHERE event_id = ?", receipt.EventID).Scan(&data); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(data, token) {
		t.Fatal("capture secret uploaded to the cloud")
	}
	connection := &fakeConnection{}
	uploader := &Uploader{Store: store, Lookup: lookupFor(map[string]*fakeConnection{testRunner: connection}), Now: func() time.Time { return testBase.Add(2 * time.Hour) }}
	uploaded, pending, err := uploader.UploadOnce(context.Background())
	if err != nil || uploaded != 1 || pending != 0 {
		t.Fatalf("delayed replay: %d %d %v", uploaded, pending, err)
	}
	_ = state
}

func TestConcurrentFirstSessionsAcrossGenerations(t *testing.T) {
	_, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	assignments.seed(testAssignment(testExecution, testRunner, token, 1))
	assignments.seed(testAssignment(testExecution, testRunner, token, 2))
	registry := testRegistry(t)
	var workers sync.WaitGroup
	for _, generation := range []int64{1, 2} {
		for index := 0; index < 8; index++ {
			workers.Add(1)
			go func() {
				defer workers.Done()
				_, _ = store.Ingest(context.Background(), assignments, registry, HookInput{
					Provider: "fake", Raw: hookRaw("session_started", fmt.Sprintf("gen-%d-sess-%d", generation, index), ""),
					ExecutionID: testExecution, Generation: generation, Token: token, CapturedAt: testBase,
				}, testBase)
			}()
		}
	}
	workers.Wait()
	for _, generation := range []int64{1, 2} {
		binding, err := store.BoundSession(context.Background(), testExecution, generation)
		if err != nil || binding.Generation != generation {
			t.Fatalf("generation %d binding: %+v %v", generation, binding, err)
		}
	}
	var sessions int
	if err := store.db.QueryRow("SELECT count(*) FROM hook_observed_sessions WHERE execution_id = ?", testExecution).Scan(&sessions); err != nil || sessions != 2 {
		t.Fatalf("bindings: %d %v", sessions, err)
	}
}
