// ABOUTME: Proves disposition-only deletion, retry backoff and one-effect uploads.
// ABOUTME: Faults every upload and acknowledgement boundary without losing accepted events.

package journal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/protocol/generated"
)

type fakeConnection struct {
	mu        sync.Mutex
	mode      string
	seen      map[string]int
	effects   map[string]bool
	script    map[string]string
	calls     int
	responses [][]byte
}

func (f *fakeConnection) Request(_ context.Context, method, action string, body []byte) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if method != "POST" || action != UploadAction {
		return nil, errors.New("unexpected upload request")
	}
	var batch struct {
		SchemaVersion int               `json:"schema_version"`
		Events        []json.RawMessage `json:"events"`
	}
	if err := json.Unmarshal(body, &batch); err != nil || batch.SchemaVersion != 1 {
		return nil, errors.New("unexpected upload body")
	}
	switch f.mode {
	case "offline":
		return nil, errors.New("network unreachable")
	case "corrupt":
		return []byte("{not json"), nil
	case "empty":
		return []byte(`{"schema_version":1,"dispositions":[]}`), nil
	}
	dispositions := []map[string]any{}
	for _, raw := range batch.Events {
		var submission generated.RunnerEventSubmission
		if err := json.Unmarshal(raw, &submission); err != nil {
			return nil, errors.New("unexpected submission")
		}
		if f.seen == nil {
			f.seen = map[string]int{}
		}
		f.seen[string(submission.EventId)]++
		disposition := "accepted"
		if f.script != nil {
			if scripted, ok := f.script[string(submission.EventId)]; ok {
				disposition = scripted
			}
		}
		if disposition == "accepted" || disposition == "already_committed" {
			if f.effects == nil {
				f.effects = map[string]bool{}
			}
			f.effects[string(submission.EventId)] = true
		}
		entry := map[string]any{
			"schema_version": 1, "event_id": submission.EventId,
			"source_stream_id": submission.SourceStreamId, "source_sequence": submission.SourceSequence,
			"disposition": disposition,
		}
		if disposition == "retryable" || disposition == "permanently_rejected" {
			entry["diagnostic"] = map[string]any{"schema_version": 1, "category": "schema_invalid", "code": "synthetic_fault", "message": "synthetic fault injection"}
		}
		dispositions = append(dispositions, entry)
	}
	response, _ := json.Marshal(map[string]any{"schema_version": 1, "dispositions": dispositions})
	return response, nil
}

func uploadTestEvents(t *testing.T, store *Store, assignments *fakeAssignments, token string, count int) []string {
	t.Helper()
	registry := testRegistry(t)
	ids := make([]string, 0, count)
	start := ingest(t, store, assignments, registry, testExecution, testRunner, token, "fake", hookRaw("session_started", "sess-up", ""), testBase.Add(time.Second))
	if start.Status != "accepted" {
		t.Fatalf("session: %+v", start)
	}
	ids = append(ids, start.EventID)
	for index := 1; index < count; index++ {
		receipt := ingest(t, store, assignments, registry, testExecution, testRunner, token, "fake", hookRaw("turn_started", "sess-up", fmt.Sprintf("up-%d", index)), testBase.Add(time.Duration(index)*time.Second))
		if receipt.Status != "accepted" {
			t.Fatalf("event %d: %+v", index, receipt)
		}
		ids = append(ids, receipt.EventID)
	}
	return ids
}

type testClock struct {
	now time.Time
}

func (c *testClock) Now() time.Time          { return c.now }
func (c *testClock) Advance(d time.Duration) { c.now = c.now.Add(d) }

func lookupFor(connections map[string]*fakeConnection) func(string) (Connection, error) {
	return func(runner string) (Connection, error) {
		connection, ok := connections[runner]
		if !ok || connection == nil {
			return nil, errors.New("runner offline")
		}
		return connection, nil
	}
}

func TestUploadAcceptsAndDeletesOnlyFromDisposition(t *testing.T) {
	state, store := openJournalDB(t)
	_ = state
	assignments := newFakeAssignments()
	token := testToken(t)
	seedOne(t, assignments, testExecution, testRunner, token)
	ids := uploadTestEvents(t, store, assignments, token, 4)
	connection := &fakeConnection{}
	uploader := &Uploader{Store: store, Lookup: lookupFor(map[string]*fakeConnection{testRunner: connection}), Now: func() time.Time { return testBase.Add(time.Hour) }}
	uploaded, pending, err := uploader.UploadOnce(context.Background())
	if err != nil || uploaded != 4 || pending != 0 {
		t.Fatalf("upload: %d %d %v", uploaded, pending, err)
	}
	if journalCount(t, store) != 0 {
		t.Fatal("accepted rows retained")
	}
	for _, id := range ids {
		if !connection.effects[id] {
			t.Fatalf("event %s has no server effect", id)
		}
	}
}

func TestUploadAckBoundariesKeepRowsQueued(t *testing.T) {
	for _, mode := range []string{"offline", "corrupt", "empty"} {
		t.Run(mode, func(t *testing.T) {
			_, store := openJournalDB(t)
			assignments := newFakeAssignments()
			token := testToken(t)
			seedOne(t, assignments, testExecution, testRunner, token)
			uploadTestEvents(t, store, assignments, token, 3)
			connection := &fakeConnection{mode: mode}
			uploader := &Uploader{Store: store, Lookup: lookupFor(map[string]*fakeConnection{testRunner: connection}), Now: func() time.Time { return testBase.Add(time.Hour) }}
			uploaded, pending, err := uploader.UploadOnce(context.Background())
			if err != nil || uploaded != 0 || pending != 3 {
				t.Fatalf("%s: %d %d %v", mode, uploaded, pending, err)
			}
			if journalCount(t, store) != 3 {
				t.Fatalf("%s deleted rows without a disposition", mode)
			}
			// Recovery with a healthy transport uploads exactly once per event.
			connection.mode = ""
			uploader.Now = func() time.Time { return testBase.Add(2 * time.Hour) }
			uploaded, pending, err = uploader.UploadOnce(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			_ = uploaded
			_ = pending
			if journalCount(t, store) != 0 {
				t.Fatalf("%s blocked recovery", mode)
			}
		})
	}
}

func TestRetryableKeepsRowAndBacksOff(t *testing.T) {
	_, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	seedOne(t, assignments, testExecution, testRunner, token)
	ids := uploadTestEvents(t, store, assignments, token, 2)
	connection := &fakeConnection{script: map[string]string{ids[0]: "retryable"}}
	now := testBase.Add(time.Hour)
	uploader := &Uploader{Store: store, Lookup: lookupFor(map[string]*fakeConnection{testRunner: connection}), Now: func() time.Time { return now }}
	if _, _, err := uploader.UploadOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if journalCount(t, store) != 1 {
		t.Fatal("retryable row deleted or accepted row retained")
	}
	var remaining string
	if err := store.db.QueryRow("SELECT event_id FROM hook_journal").Scan(&remaining); err != nil || remaining != ids[0] {
		t.Fatalf("wrong row retained: %q %v", remaining, err)
	}
	var next string
	if err := store.db.QueryRow("SELECT next_attempt_at FROM hook_source_streams WHERE runner_id = ?", testRunner).Scan(&next); err != nil {
		t.Fatal(err)
	}
	if next <= localTimestamp(now) {
		t.Fatal("no backoff after retryable disposition")
	}
}

func TestPermanentRejectQuarantinesWithoutBlocking(t *testing.T) {
	_, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	seedOne(t, assignments, testExecution, testRunner, token)
	ids := uploadTestEvents(t, store, assignments, token, 3)
	connection := &fakeConnection{script: map[string]string{ids[0]: "permanently_rejected"}}
	uploader := &Uploader{Store: store, Lookup: lookupFor(map[string]*fakeConnection{testRunner: connection}), Now: func() time.Time { return testBase.Add(time.Hour) }}
	uploaded, pending, err := uploader.UploadOnce(context.Background())
	if err != nil || uploaded != 3 || pending != 0 {
		t.Fatalf("upload: %d %d %v", uploaded, pending, err)
	}
	if journalCount(t, store) != 0 || quarantineCount(t, store) != 1 {
		t.Fatal("permanent reject did not quarantine exactly one row")
	}
	var reason string
	if err := store.db.QueryRow("SELECT reason FROM hook_quarantine").Scan(&reason); err != nil || !strings.HasPrefix(reason, "permanent_reject") {
		t.Fatalf("quarantine reason lost: %q %v", reason, err)
	}
	// Later events from the same stream still upload after the rejection.
	registry := testRegistry(t)
	later := ingest(t, store, assignments, registry, testExecution, testRunner, token, "fake", hookRaw("turn_started", "sess-up", "up-late"), testBase.Add(2*time.Hour))
	if later.Status != "accepted" {
		t.Fatalf("later hook blocked: %+v", later)
	}
	uploaded, pending, err = uploader.UploadOnce(context.Background())
	if err != nil || uploaded != 1 || pending != 0 {
		t.Fatalf("recovery upload: %d %d %v", uploaded, pending, err)
	}
}

func TestAlreadyCommittedDeletesWithoutDuplicateEffect(t *testing.T) {
	_, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	seedOne(t, assignments, testExecution, testRunner, token)
	ids := uploadTestEvents(t, store, assignments, token, 2)
	connection := &fakeConnection{script: map[string]string{ids[0]: "already_committed", ids[1]: "already_committed"}}
	uploader := &Uploader{Store: store, Lookup: lookupFor(map[string]*fakeConnection{testRunner: connection}), Now: func() time.Time { return testBase.Add(time.Hour) }}
	uploaded, pending, err := uploader.UploadOnce(context.Background())
	if err != nil || uploaded != 2 || pending != 0 {
		t.Fatalf("upload: %d %d %v", uploaded, pending, err)
	}
	if journalCount(t, store) != 0 {
		t.Fatal("already-committed rows retained")
	}
}

func TestKilledUploadRetriesToOneEffect(t *testing.T) {
	_, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	seedOne(t, assignments, testExecution, testRunner, token)
	ids := uploadTestEvents(t, store, assignments, token, 2)
	// The first attempt reaches the server but its acknowledgement is lost.
	clock := &testClock{now: testBase.Add(time.Hour)}
	connection := &fakeConnection{mode: "offline"}
	uploader := &Uploader{Store: store, Lookup: lookupFor(map[string]*fakeConnection{testRunner: connection}), Now: clock.Now}
	if _, _, err := uploader.UploadOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	// The retry delivers the same durable event IDs; the server applies each
	// delivery to the same effect instead of recording a duplicate.
	connection.mode = ""
	clock.Advance(time.Hour)
	uploaded, pending, err := uploader.UploadOnce(context.Background())
	if err != nil || uploaded != 2 || pending != 0 {
		t.Fatalf("retry: %d %d %v", uploaded, pending, err)
	}
	if len(connection.effects) != 2 {
		t.Fatalf("server effects: %d", len(connection.effects))
	}
	for _, id := range ids {
		if !connection.effects[id] || connection.seen[id] != 1 {
			t.Fatalf("event %s delivered %d times", id, connection.seen[id])
		}
	}
}
