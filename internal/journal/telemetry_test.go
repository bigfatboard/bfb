// ABOUTME: Proves real acknowledgement compatibility and persistent native telemetry identity.
// ABOUTME: Keeps every capture synthetic while exercising production adapters and SQLite transactions.

package journal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers/codex"
)

func TestTelemetryActualWorkerAcknowledgement(t *testing.T) {
	response := []byte(`{"schema_version":1,"workspace_id":"01JBFB0W0RKSPACE0000000000","high_water_cursor":2,"dispositions":[{"schema_version":1,"event_id":"01JBFB0EVENTXXX00000000000","source_stream_id":"01JBFB0STREAMXX00000000000","source_sequence":1,"disposition":"accepted"}]}`)
	if dispositions, ok := parseDispositions(response); !ok || len(dispositions) != 1 {
		t.Fatalf("genuine Worker acknowledgement rejected: %v %+v", ok, dispositions)
	}
}

func TestTelemetryToolPhasesAndAcknowledgedRedelivery(t *testing.T) {
	state, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	assignment := testAssignment(testExecution, testRunner, token, 1)
	assignment.Provider = "codex"
	assignments.seed(assignment)
	registry, err := provider.NewRegistry([]provider.Descriptor{codex.Descriptor()})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	capture := func(phase string, second int) Receipt {
		raw := []byte(fmt.Sprintf(`{"hook_event_name":%q,"session_id":"synthetic-session","tool_name":"shell","tool_use_id":"synthetic-tool"}`, phase))
		now := testBase.Add(time.Duration(second) * time.Second)
		receipt, err := store.Ingest(ctx, assignments, registry, HookInput{ExecutionID: testExecution, Generation: 1, Token: token, Provider: "codex", Raw: raw, CapturedAt: now}, now)
		if err != nil {
			t.Fatal(err)
		}
		return receipt
	}
	first := capture("PreToolUse", 1)
	finish := capture("PostToolUse", 2)
	if first.Status != "accepted" || finish.Status != "accepted" || first.EventID == finish.EventID {
		t.Fatalf("start suppressed finish: start=%+v finish=%+v", first, finish)
	}
	connection := &telemetryConnection{fake: &fakeConnection{}}
	uploader := &Uploader{Store: store, Lookup: func(string) (Connection, error) { return connection, nil }, Now: func() time.Time { return testBase.Add(time.Hour) }}
	if done, pending, err := uploader.UploadOnce(ctx); err != nil || done != 2 || pending != 0 {
		t.Fatalf("real ACK: %d %d %v", done, pending, err)
	}
	paths := state.Paths
	if err := state.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := daemon.OpenStore(ctx, paths)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	store = NewStore(reopened.DB)
	duplicate := capture("PreToolUse", 3)
	if duplicate.Status != "duplicate" || duplicate.EventID != first.EventID {
		t.Fatalf("acknowledgement forgot original phase identity: %+v", duplicate)
	}
}

type telemetryConnection struct {
	fake            *fakeConnection
	capability      string
	unavailable     bool
	capabilityCalls int
	batches         [][]int
	alter           func(map[string]any)
}

func (connection *telemetryConnection) Request(ctx context.Context, method, action string, body []byte) ([]byte, error) {
	if method == "GET" && action == "events/capabilities" {
		connection.capabilityCalls++
		if len(body) != 0 {
			return nil, errors.New("capability body must be empty")
		}
		if connection.unavailable {
			return nil, errors.New("synthetic capability outage")
		}
		if connection.capability != "" {
			return []byte(connection.capability), nil
		}
		return []byte(`{"schema_version":1,"accepted_event_versions":[1,2]}`), nil
	}
	var batch struct {
		Events []struct {
			SchemaVersion int `json:"schema_version"`
		} `json:"events"`
	}
	if err := json.Unmarshal(body, &batch); err != nil {
		return nil, err
	}
	versions := []int{}
	for _, item := range batch.Events {
		versions = append(versions, item.SchemaVersion)
	}
	connection.batches = append(connection.batches, versions)
	response, err := connection.fake.Request(ctx, method, action, body)
	if err != nil {
		return nil, err
	}
	if connection.alter != nil {
		var value map[string]any
		if err := json.Unmarshal(response, &value); err != nil {
			return nil, err
		}
		connection.alter(value)
		return json.Marshal(value)
	}
	return response, nil
}

func telemetryUsage(id string) map[string]any {
	return map[string]any{"kind": "usage", "session_id": "synthetic-session", "usage_id": id, "basis": "turn_delta", "quality": "provider_reported", "model": "synthetic", "input_tokens": 120, "output_tokens": 34, "cache_read_tokens": 100, "cache_write_tokens": nil, "reasoning_tokens": 5}
}

func captureTelemetry(t *testing.T, store *Store, assignments *fakeAssignments, token string, input map[string]any, second int) Receipt {
	t.Helper()
	raw, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	return ingest(t, store, assignments, testRegistry(t), testExecution, testRunner, token, "fake", raw, testBase.Add(time.Duration(second)*time.Second))
}

func TestTelemetryUsageSurvivesAckAndRestart(t *testing.T) {
	state, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	seedOne(t, assignments, testExecution, testRunner, token)
	first := captureTelemetry(t, store, assignments, token, telemetryUsage("usage-one"), 1)
	if first.Status != "accepted" {
		t.Fatal(first)
	}
	var original string
	if err := store.db.QueryRow("SELECT submission_json FROM hook_journal WHERE event_id=?", first.EventID).Scan(&original); err != nil {
		t.Fatal(err)
	}
	decoded := protocol.DecodeWireDocument("runner-telemetry-submission", []byte(original))
	if !decoded.OK {
		t.Fatal(decoded.Error)
	}
	if strings.Contains(original, token) || !strings.Contains(original, `"cache_write":null`) || !strings.Contains(original, `"reasoning":5`) {
		t.Fatal("private proof leaked or missing counters invented")
	}
	connection := &telemetryConnection{fake: &fakeConnection{}}
	uploader := &Uploader{Store: store, Lookup: func(string) (Connection, error) { return connection, nil }, Now: func() time.Time { return testBase.Add(time.Hour) }}
	if done, pending, err := uploader.UploadOnce(context.Background()); err != nil || done != 1 || pending != 0 {
		t.Fatalf("ACK:%d %d %v", done, pending, err)
	}
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
	alias := telemetryUsage("usage-one")
	alias["source_event_id"] = "different-delivery"
	duplicate := captureTelemetry(t, store, assignments, token, alias, 20)
	if duplicate.Status != "duplicate" || duplicate.EventID != first.EventID || journalCount(t, store) != 0 {
		t.Fatalf("ACK/restart forgot semantic identity:%+v", duplicate)
	}
	for _, mutation := range []struct {
		field string
		value any
	}{{"input_tokens", 121}, {"quality", "estimated"}, {"model", "other"}, {"cache_read_tokens", nil}, {"reasoning_tokens", nil}} {
		changed := telemetryUsage("usage-one")
		changed[mutation.field] = mutation.value
		receipt := captureTelemetry(t, store, assignments, token, changed, 21)
		if receipt.Status != "rejected" || receipt.Code != "telemetry_identity_conflict" {
			t.Fatalf("changed %s lost conflict:%+v", mutation.field, receipt)
		}
	}
	distinct := captureTelemetry(t, store, assignments, token, telemetryUsage("usage-two"), 22)
	if distinct.Status != "accepted" || distinct.Sequence != 2 {
		t.Fatalf("new usage or duplicate sequence advanced:%+v", distinct)
	}
}

func TestTelemetryUnsupportedPeerKeepsTypedRowsAndDrainsV1(t *testing.T) {
	for _, mode := range []string{"old", "outage"} {
		t.Run(mode, func(t *testing.T) {
			_, store := openJournalDB(t)
			assignments := newFakeAssignments()
			token := testToken(t)
			seedOne(t, assignments, testExecution, testRunner, token)
			first := captureTelemetry(t, store, assignments, token, telemetryUsage("pending-usage"), 1)
			old := captureTelemetry(t, store, assignments, token, map[string]any{"kind": "turn_started", "session_id": "synthetic-session", "source_event_id": "legacy-turn"}, 2)
			var original string
			store.db.QueryRow("SELECT submission_json FROM hook_journal WHERE event_id=?", first.EventID).Scan(&original)
			connection := &telemetryConnection{fake: &fakeConnection{}, capability: `{"schema_version":1,"accepted_event_versions":[1]}`, unavailable: mode == "outage"}
			uploader := &Uploader{Store: store, Lookup: func(string) (Connection, error) { return connection, nil }, Now: func() time.Time { return testBase.Add(time.Hour) }}
			done, pending, err := uploader.UploadOnce(context.Background())
			if err != nil || done != 1 || pending != 1 {
				t.Fatalf("mixed old peer:%d %d %v", done, pending, err)
			}
			if connection.fake.effects[first.EventID] || !connection.fake.effects[old.EventID] {
				t.Fatal("typed row downgraded or v1 starved")
			}
			degraded, reason, err := store.Degraded(context.Background())
			if err != nil || !degraded || !strings.HasPrefix(reason, "telemetry_") {
				t.Fatalf("compatibility invisible:%v %s %v", degraded, reason, err)
			}
			var retained string
			store.db.QueryRow("SELECT submission_json FROM hook_journal WHERE event_id=?", first.EventID).Scan(&retained)
			if retained != original {
				t.Fatal("unsupported row bytes changed")
			}
			connection.capability = ""
			connection.unavailable = false
			if _, _, err := uploader.UploadOnce(context.Background()); err != nil || connection.capabilityCalls != 1 {
				t.Fatal("compatibility retry ignored backoff", err)
			}
			uploader.Now = func() time.Time { return testBase.Add(2 * time.Hour) }
			done, pending, err = uploader.UploadOnce(context.Background())
			if err != nil || done != 1 || pending != 0 || connection.capabilityCalls != 2 {
				t.Fatalf("reconnected capability:%d %d %v", done, pending, err)
			}
			degraded, _, err = store.Degraded(context.Background())
			if err != nil || degraded {
				t.Fatal("recovered upload state remained degraded")
			}
		})
	}
}

func TestTelemetryMalformedAckRetainsEntireBatch(t *testing.T) {
	cases := map[string]func(map[string]any){
		"workspace": func(ack map[string]any) { ack["workspace_id"] = "01JBFB0PR0JECTX00000000000" },
		"sequence":  func(ack map[string]any) { ack["dispositions"].([]any)[1].(map[string]any)["source_sequence"] = 99 },
		"unknown-id": func(ack map[string]any) {
			ack["dispositions"].([]any)[1].(map[string]any)["event_id"] = "01JBFB0PR0JECTX00000000000"
		},
		"missing": func(ack map[string]any) { ack["dispositions"] = ack["dispositions"].([]any)[:1] },
		"duplicate-conflicting": func(ack map[string]any) {
			items := ack["dispositions"].([]any)
			copy := map[string]any{}
			for key, value := range items[0].(map[string]any) {
				copy[key] = value
			}
			copy["disposition"] = "already_committed"
			items[1] = copy
		},
	}
	for name, alter := range cases {
		t.Run(name, func(t *testing.T) {
			_, store := openJournalDB(t)
			assignments := newFakeAssignments()
			token := testToken(t)
			seedOne(t, assignments, testExecution, testRunner, token)
			uploadTestEvents(t, store, assignments, token, 2)
			connection := &telemetryConnection{fake: &fakeConnection{}, alter: alter}
			uploader := &Uploader{Store: store, Lookup: func(string) (Connection, error) { return connection, nil }, Now: func() time.Time { return testBase.Add(time.Hour) }}
			done, pending, err := uploader.UploadOnce(context.Background())
			if err != nil || done != 0 || pending != 2 || journalCount(t, store) != 2 || quarantineCount(t, store) != 0 {
				t.Fatalf("malformed ACK mutated batch:%d %d %v", done, pending, err)
			}
		})
	}
}

func TestTelemetryIdentityCapacityIsStickyAndAtomic(t *testing.T) {
	state, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	seedOne(t, assignments, testExecution, testRunner, token)
	first := captureTelemetry(t, store, assignments, token, telemetryUsage("known-usage"), 1)
	if first.Status != "accepted" {
		t.Fatal(first)
	}
	_, err := store.db.Exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 16383)
INSERT INTO hook_telemetry_identities SELECT 'synthetic-execution',1,'synthetic-session','tokens','retained-'||x,'turn_delta',?, 'synthetic-event-'||x,'2026-10-06T00:00:00Z' FROM n`, strings.Repeat("0", 64))
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(telemetryUsage("new-usage"))
	now := testBase.Add(2 * time.Second)
	_, err = store.Ingest(context.Background(), assignments, testRegistry(t), HookInput{Provider: "fake", Raw: raw, ExecutionID: testExecution, Generation: 1, Token: token, CapturedAt: now}, now)
	if asCode(err) != "telemetry_degraded" || journalCount(t, store) != 1 {
		t.Fatalf("capacity lost atomicity:%v", err)
	}
	for _, query := range []string{"UPDATE hook_telemetry_identities SET fingerprint='changed'", "DELETE FROM hook_telemetry_identities"} {
		if _, err := store.db.Exec(query); err == nil {
			t.Fatal("retained identity mutated")
		}
	}
	duplicate := captureTelemetry(t, store, assignments, token, telemetryUsage("known-usage"), 3)
	if duplicate.Status != "duplicate" || duplicate.EventID != first.EventID {
		t.Fatal("capacity forgot existing identity")
	}
	connection := &telemetryConnection{fake: &fakeConnection{}}
	uploader := &Uploader{Store: store, Lookup: func(string) (Connection, error) { return connection, nil }, Now: func() time.Time { return testBase.Add(time.Hour) }}
	connection.alter = func(ack map[string]any) {
		item := ack["dispositions"].([]any)[0].(map[string]any)
		item["disposition"] = "permanently_rejected"
		item["diagnostic"] = map[string]any{"schema_version": 1, "category": "unknown_version", "code": "unsupported_schema_version", "message": "synthetic older peer"}
	}
	if done, pending, err := uploader.UploadOnce(context.Background()); err != nil || done != 0 || pending != 1 {
		t.Fatalf("unexpected version erased saturated identity history:%d %d %v", done, pending, err)
	}
	degraded, reason, err := store.Degraded(context.Background())
	if err != nil || !degraded || reason != "telemetry_identity_capacity" {
		t.Fatalf("version rejection replaced stronger fault:%v %s %v", degraded, reason, err)
	}
	connection.alter = nil
	uploader.Now = func() time.Time { return testBase.Add(2 * time.Hour) }
	if _, _, err := uploader.UploadOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ImportInbox(context.Background(), assignments, testRegistry(t), state.Paths.Root, 256, now); err != nil {
		t.Fatal(err)
	}
	degraded, reason, err = store.Degraded(context.Background())
	if err != nil || !degraded || reason != "telemetry_identity_capacity" {
		t.Fatalf("successful unrelated drain cleared retention fault:%v %s %v", degraded, reason, err)
	}
}

func TestTelemetryCapabilityBackoffWithoutV1(t *testing.T) {
	_, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	seedOne(t, assignments, testExecution, testRunner, token)
	first := captureTelemetry(t, store, assignments, token, telemetryUsage("unsupported-only"), 1)
	connection := &telemetryConnection{fake: &fakeConnection{}, capability: `{"schema_version":1,"accepted_event_versions":[1]}`}
	clock := &testClock{now: testBase.Add(time.Hour)}
	uploader := &Uploader{Store: store, Lookup: func(string) (Connection, error) { return connection, nil }, Now: clock.Now}
	for attempt := 1; attempt <= 4; attempt++ {
		if done, pending, err := uploader.UploadOnce(context.Background()); err != nil || done != 0 || pending != 1 {
			t.Fatalf("unsupported-only upload:%d %d %v", done, pending, err)
		}
		if connection.capabilityCalls != attempt || connection.fake.calls != 0 {
			t.Fatal("discovery unexpectedly sent a typed row")
		}
		var next string
		var failures int
		if err := store.db.QueryRow("SELECT next_attempt_at,failures FROM hook_source_streams WHERE runner_id=?", testRunner).Scan(&next, &failures); err != nil {
			t.Fatal(err)
		}
		due, err := time.Parse(time.RFC3339Nano, next)
		if err != nil || failures != attempt || due.Sub(clock.now) != uploadBackoff(attempt) {
			t.Fatal("compatibility retry lost bounded exponential backoff", next, failures, err)
		}
		if _, _, err := uploader.UploadOnce(context.Background()); err != nil || connection.capabilityCalls != attempt {
			t.Fatal("hot compatibility discovery", err)
		}
		clock.now = due
	}
	connection.capability = ""
	if done, pending, err := uploader.UploadOnce(context.Background()); err != nil || done != 1 || pending != 0 || !connection.fake.effects[first.EventID] {
		t.Fatalf("supported peer failed recovery:%d %d %v", done, pending, err)
	}
}

func TestTelemetryLegacyWorkspaceResolvedWithoutRewriting(t *testing.T) {
	_, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	seedOne(t, assignments, testExecution, testRunner, token)
	first := uploadTestEvents(t, store, assignments, token, 1)[0]
	if _, err := store.db.Exec("UPDATE hook_journal SET workspace_id='' WHERE event_id=?", first); err != nil {
		t.Fatal(err)
	}
	var original string
	if err := store.db.QueryRow("SELECT submission_json FROM hook_journal WHERE event_id=?", first).Scan(&original); err != nil {
		t.Fatal(err)
	}
	connection := &telemetryConnection{fake: &fakeConnection{}, alter: func(ack map[string]any) { ack["workspace_id"] = "01JBFB0PR0JECTX00000000000" }}
	uploader := &Uploader{Store: store, Assignments: assignments, Lookup: func(string) (Connection, error) { return connection, nil }, Now: func() time.Time { return testBase.Add(time.Hour) }}
	if done, pending, err := uploader.UploadOnce(context.Background()); err != nil || done != 0 || pending != 1 {
		t.Fatalf("foreign ACK acknowledged legacy row:%d %d %v", done, pending, err)
	}
	var actual, workspace string
	if err := store.db.QueryRow("SELECT submission_json,workspace_id FROM hook_journal WHERE event_id=?", first).Scan(&actual, &workspace); err != nil || actual != original || workspace != "" {
		t.Fatal("legacy immutablebytes/metadata rewritten", err)
	}
	connection.alter = nil
	uploader.Now = func() time.Time { return testBase.Add(2 * time.Hour) }
	if done, pending, err := uploader.UploadOnce(context.Background()); err != nil || done != 1 || pending != 0 {
		t.Fatalf("historical assignment workspace failed:%d %d %v", done, pending, err)
	}
	if connection.capabilityCalls != 0 {
		t.Fatal("v1 delivery unexpectedly requires new peer capability")
	}
}

func TestTelemetryOneHealthyEnrollmentCannotHideUnsupportedRows(t *testing.T) {
	_, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	seedOne(t, assignments, testExecution, testRunner, token)
	captureTelemetry(t, store, assignments, token, telemetryUsage("unsupported-enrollment"), 1)
	runnerB := "01JBFB0RVNNER2D00000000000"
	executionB := "01JBFB0EXECRN9000000000000"
	assignments.seed(testAssignment(executionB, runnerB, token, 1))
	raw, _ := json.Marshal(telemetryUsage("supported-enrollment"))
	receipt := ingest(t, store, assignments, testRegistry(t), executionB, runnerB, token, "fake", raw, testBase.Add(2*time.Second))
	if receipt.Status != "accepted" {
		t.Fatal(receipt)
	}
	old := &telemetryConnection{fake: &fakeConnection{}, capability: `{"schema_version":1,"accepted_event_versions":[1]}`}
	healthy := &telemetryConnection{fake: &fakeConnection{}}
	uploader := &Uploader{Store: store, Lookup: func(runner string) (Connection, error) {
		if runner == runnerB {
			return healthy, nil
		}
		return old, nil
	}, Now: func() time.Time { return testBase.Add(time.Hour) }}
	if done, pending, err := uploader.UploadOnce(context.Background()); err != nil || done != 1 || pending != 1 {
		t.Fatalf("multi-enrollment upload:%d %d %v", done, pending, err)
	}
	degraded, reason, err := store.Degraded(context.Background())
	if err != nil || !degraded || reason != "telemetry_upgrade_required" {
		t.Fatalf("healthy peer concealed unsupported backlog:%v %s %v", degraded, reason, err)
	}
}
