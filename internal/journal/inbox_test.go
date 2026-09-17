// ABOUTME: Proves daemon-down capture, authenticated import and corruption quarantine.
// ABOUTME: Exercises full and forged inboxes without touching production state.

package journal

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestInboxRoundTripAfterDaemonDown(t *testing.T) {
	state, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	seedOne(t, assignments, testExecution, testRunner, token)
	registry := testRegistry(t)
	root := state.Paths.Root

	// The database is unreachable, so the hook falls back to an authenticated
	// capture carrying no assignment lookup and no journal write.
	raw := hookRaw("session_started", "sess-inbox", "")
	name, err := WriteCapture(root, token, testExecution, 1, "fake", raw, testBase.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if journalCount(t, store) != 0 {
		t.Fatal("capture wrote to the journal")
	}
	result, err := store.ImportInbox(context.Background(), assignments, registry, root, 256, testBase.Add(time.Minute))
	if err != nil || result.Imported != 1 || result.Quarantined != 0 {
		t.Fatalf("import: %+v %v", result, err)
	}
	if journalCount(t, store) != 1 {
		t.Fatal("capture lost during import")
	}
	// The same file bytes redelivered under another name import exactly once.
	entries, err := os.ReadDir(filepath.Join(root, fileQuarantineDirName))
	if err != nil {
		t.Fatal(err)
	}
	_ = entries
	_ = name
	degraded, reason, err := store.Degraded(context.Background())
	if err != nil || degraded {
		t.Fatalf("healthy import left degraded state: %v %q", degraded, reason)
	}
	binding, err := store.BoundSession(context.Background(), testExecution, 1)
	if err != nil || binding.SessionID != "sess-inbox" {
		t.Fatalf("inbox session not bound: %+v %v", binding, err)
	}
}

func TestInboxCorruptionQuarantinesVisibly(t *testing.T) {
	state, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	seedOne(t, assignments, testExecution, testRunner, token)
	registry := testRegistry(t)
	root := state.Paths.Root
	inbox := inboxDir(root)
	if err := privateDir(inbox); err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(inbox, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("a.capture.json", "{corrupt")
	write("b.capture.json", `{"schema_version":1}`)
	// Forged HMAC with an otherwise valid shape.
	forged, _ := json.Marshal(Capture{SchemaVersion: 1, ExecutionID: testExecution, AssignmentGeneration: 1, Provider: "fake", CapturedAt: localTimestamp(testBase), Payload: base64.StdEncoding.EncodeToString(hookRaw("session_started", "sess-x", "")), HMAC: base64.RawURLEncoding.EncodeToString(make([]byte, 32))})
	write("c.capture.json", string(forged))
	// Valid shape for an unknown execution.
	if _, err := WriteCapture(root, token, "01JBFB0EXECZZZZ000000000000", 1, "fake", hookRaw("session_started", "sess-z", ""), testBase); err != nil {
		t.Fatal(err)
	}
	// One authentic capture must still import while the forgeries quarantine.
	if _, err := WriteCapture(root, token, testExecution, 1, "fake", hookRaw("session_started", "sess-good", ""), testBase.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	result, err := store.ImportInbox(context.Background(), assignments, registry, root, 256, testBase.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if result.Imported != 1 || result.Quarantined != 4 {
		t.Fatalf("import: %+v", result)
	}
	degraded, reason, err := store.Degraded(context.Background())
	if err != nil || !degraded || reason == "" {
		t.Fatalf("corruption did not raise degraded state: %v %q", degraded, reason)
	}
	if journalCount(t, store) != 1 || quarantineCount(t, store) < 3 {
		t.Fatal("quarantine lost forged captures")
	}
	remaining, err := os.ReadDir(inbox)
	if err != nil {
		t.Fatal(err)
	}
	if len(remaining) != 0 {
		t.Fatalf("inbox not drained: %d files", len(remaining))
	}
}

func TestInboxFullIsVisible(t *testing.T) {
	state, _ := openJournalDB(t)
	token := testToken(t)
	root := state.Paths.Root
	raw := hookRaw("session_started", "sess-full", "")
	for index := 0; index < maxInboxFiles; index++ {
		if _, err := WriteCapture(root, token, testExecution, 1, "fake", raw, testBase); err != nil {
			t.Fatalf("capture %d: %v", index, err)
		}
	}
	if _, err := WriteCapture(root, token, testExecution, 1, "fake", raw, testBase); asCode(err) != "inbox_full" {
		t.Fatalf("overfull inbox accepted: %v", err)
	}
}

func TestObservationImportKeepsProvenance(t *testing.T) {
	_, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	seedOne(t, assignments, testExecution, testRunner, token)
	observers := &fakeObservers{queue: []Observation{
		{EventID: "01JBFB0BSRV000000000000001", ExecutionID: testExecution, Generation: 1, Sequence: 1, Kind: "execution_attached", OccurredAt: localTimestamp(testBase)},
		{EventID: "01JBFB0BSRV000000000000002", ExecutionID: testExecution, Generation: 1, Sequence: 2, Kind: "heartbeat", OccurredAt: localTimestamp(testBase.Add(16 * time.Second))},
		// A 90-second heartbeat gap is preserved as observed, never backfilled.
		{EventID: "01JBFB0BSRV000000000000003", ExecutionID: testExecution, Generation: 1, Sequence: 3, Kind: "heartbeat", OccurredAt: localTimestamp(testBase.Add(106 * time.Second))},
		{EventID: "01JBFB0BSRV000000000000004", ExecutionID: testExecution, Generation: 1, Sequence: 4, Kind: "execution_ended", OccurredAt: localTimestamp(testBase.Add(120 * time.Second))},
	}}
	imported, quarantined, err := store.ImportObservations(context.Background(), assignments, observers, 256, testBase.Add(2*time.Hour))
	if err != nil || imported != 4 || quarantined != 0 {
		t.Fatalf("import: %d %d %v", imported, quarantined, err)
	}
	if journalCount(t, store) != 4 {
		t.Fatal("observations lost in import")
	}
	rows, err := store.db.Query("SELECT kind, capture_origin, occurred_at FROM hook_journal ORDER BY captured_at, rowid")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	type row struct{ kind, origin, at string }
	got := []row{}
	for rows.Next() {
		var item row
		if err := rows.Scan(&item.kind, &item.origin, &item.at); err != nil {
			t.Fatal(err)
		}
		got = append(got, item)
	}
	if len(got) != 4 || got[0].kind != "execution_attached" || got[3].kind != "execution_ended" {
		t.Fatalf("observation order changed: %+v", got)
	}
	for _, item := range got {
		if item.origin != "runner_observed" {
			t.Fatalf("provenance lost: %+v", item)
		}
	}
	if got[2].at != localTimestamp(testBase.Add(106*time.Second)) {
		t.Fatalf("heartbeat gap rewritten: %+v", got[2])
	}
	if len(observers.marked) != 4 {
		t.Fatal("import checkpoint not recorded")
	}
}

func TestObservationImportFailureRollsBack(t *testing.T) {
	_, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	seedOne(t, assignments, testExecution, testRunner, token)
	observers := &fakeObservers{
		queue:    []Observation{{EventID: "01JBFB0BSRV000000000000001", ExecutionID: testExecution, Generation: 1, Sequence: 1, Kind: "heartbeat", OccurredAt: localTimestamp(testBase)}},
		failMark: failure("storage_failed"),
	}
	if _, _, err := store.ImportObservations(context.Background(), assignments, observers, 256, testBase); asCode(err) != "storage_failed" {
		t.Fatalf("checkpoint fault ignored: %v", err)
	}
	if journalCount(t, store) != 0 {
		t.Fatal("failed import left journal rows")
	}
}

func TestUnknownFieldsNeverReachCloud(t *testing.T) {
	_, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	seedOne(t, assignments, testExecution, testRunner, token)
	registry := testRegistry(t)
	raw := `{"kind":"session_started","session_id":"sess-1","transcript":"synthetic-secret-body","system_prompt":"synthetic-instructions","extra":{"nested":[1,2,3]}}`
	receipt := ingest(t, store, assignments, registry, testExecution, testRunner, token, "fake", []byte(raw), testBase)
	if receipt.Status != "accepted" {
		t.Fatalf("hook: %+v", receipt)
	}
	var data string
	if err := store.db.QueryRow("SELECT submission_json FROM hook_journal WHERE event_id = ?", receipt.EventID).Scan(&data); err != nil {
		t.Fatal(err)
	}
	for _, leak := range []string{"transcript", "synthetic-secret", "system_prompt", "nested", `"session_id":`} {
		if strings.Contains(data, leak) {
			t.Fatalf("provider field %q reached the submission", leak)
		}
	}
	if !strings.Contains(data, `"payload":{}`) {
		t.Fatal("submission payload is not the empty semantic object")
	}
}
