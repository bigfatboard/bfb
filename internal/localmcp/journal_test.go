// ABOUTME: Proves journal durability across restart and the full offline replay matrix.
// ABOUTME: Covers revocation, end, expiry, terminal results, policy change, and version conflict.

package localmcp

import (
	"context"
	"testing"
	"time"
)

func journaledHost(t *testing.T, transport *fakeTransport) (*SQLiteJournal, *Host, *fakeBindings, *fakeAuthority) {
	t.Helper()
	record := syntheticAssignment()
	journal, err := OpenJournal(t.TempDir() + "/journal.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = journal.Close() })
	bindings := &fakeBindings{}
	authority := &fakeAuthority{}
	_, host := testHost(record, bindings, authority, transport, journal)
	bindings.setBound(syntheticSession, AssignmentRef{ExecutionID: record.Boundary.ExecutionID, AssignmentGeneration: record.Boundary.Generation, RunID: record.Boundary.RunID})
	return journal, host, bindings, authority
}

func queueOffline(t *testing.T, host *Host, tool string, params map[string]any) {
	t.Helper()
	if _, err := host.CallTool(context.Background(), tool, params); err != nil {
		t.Fatalf("queueing %s failed: %v", tool, err)
	}
}

func TestJournalSurvivesRestartAndReplays(t *testing.T) {
	record := syntheticAssignment()
	path := t.TempDir() + "/restart.sqlite"
	transport := syntheticTransport()
	transport.online = false
	journal, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	bindings := &fakeBindings{}
	_, host := testHost(record, bindings, &fakeAuthority{}, transport, journal)
	bindings.setBound(syntheticSession, AssignmentRef{ExecutionID: record.Boundary.ExecutionID, AssignmentGeneration: record.Boundary.Generation, RunID: record.Boundary.RunID})
	queueOffline(t, host, "bfb_add_comment", map[string]any{"body": "Restart me", "request_id": "restart-01"})
	queueOffline(t, host, "bfb_report_progress", map[string]any{"summary": "Halfway", "percent": float64(50), "request_id": "restart-02"})
	if err := journal.Close(); err != nil {
		t.Fatal(err)
	}
	// Restart: reopen the same file and replay through a fresh online transport.
	reopened, err := OpenJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if _, ok, _ := reopened.Pending("restart-01"); !ok {
		t.Fatalf("pending operation lost across restart")
	}
	online := syntheticTransport()
	results, err := Replay(context.Background(), reopened, online, &fakeAuthority{}, fakeReplayPolicy{allow: true}, syntheticTime.Add(time.Hour), 16)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 2 {
		t.Fatalf("expected 2 replay results, got %+v", results)
	}
	for _, result := range results {
		if result.Disposition != "applied" {
			t.Fatalf("expected applied, got %+v", result)
		}
	}
	if len(online.commented) != 1 || len(online.progress) != 1 {
		t.Fatalf("replay did not execute effects: %+v", online)
	}
	// Replay is idempotent: a second pass finds nothing pending.
	results, err = Replay(context.Background(), reopened, online, &fakeAuthority{}, fakeReplayPolicy{allow: true}, syntheticTime.Add(time.Hour), 16)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 0 {
		t.Fatalf("replay re-executed terminal records: %+v", results)
	}
	if result, code, ok, _ := reopened.Outcome("restart-01"); !ok || code != "" || result == nil {
		t.Fatalf("applied outcome not retained: %+v %s %v", result, code, ok)
	}
}

func TestReplayFailureMatrix(t *testing.T) {
	record := syntheticAssignment()
	cases := []struct {
		name       string
		tool       string
		params     map[string]any
		requestID  string
		authority  AuthorityState
		policy     bool
		failCode   string
		clockShift time.Duration
		tamper     bool
		want       string
		reason     string
	}{
		{"revocation rejects", "bfb_add_comment", map[string]any{"body": "x", "request_id": "rfail-01"}, "rfail-01", AuthorityState{Revoked: true}, true, "", 0, false, "rejected", "revoked"},
		{"execution end rejects", "bfb_add_comment", map[string]any{"body": "x", "request_id": "rfail-02"}, "rfail-02", AuthorityState{ExecutionEnded: true}, true, "", 0, false, "rejected", "execution_ended"},
		{"accepted result rejects", "bfb_add_comment", map[string]any{"body": "x", "request_id": "rfail-03"}, "rfail-03", AuthorityState{ResultTerminal: true}, true, "", 0, false, "rejected", "result_terminal"},
		{"expiry rejects", "bfb_add_comment", map[string]any{"body": "x", "request_id": "rfail-04"}, "rfail-04", AuthorityState{}, true, "", 25 * time.Hour, false, "rejected", "expired"},
		{"policy change rejects", "bfb_add_comment", map[string]any{"body": "x", "request_id": "rfail-05"}, "rfail-05", AuthorityState{}, false, "", 0, false, "rejected", "policy_changed"},
		{"version conflict rejects", "bfb_update_task", map[string]any{"expected_version": float64(3), "title": "Late", "request_id": "rfail-06"}, "rfail-06", AuthorityState{}, true, "stale_version", 0, false, "rejected", "stale_version"},
		{"tampered capture rejects", "bfb_add_comment", map[string]any{"body": "x", "request_id": "rfail-07"}, "rfail-07", AuthorityState{}, true, "", 0, true, "rejected", "capture_invalid"},
		{"transient failure stays retryable", "bfb_add_comment", map[string]any{"body": "x", "request_id": "rfail-08"}, "rfail-08", AuthorityState{}, true, "internal_error", 0, false, "retryable", "internal_error"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			transport := syntheticTransport()
			transport.online = false
			journal, host, _, _ := journaledHost(t, transport)
			queueOffline(t, host, tc.tool, tc.params)
			if tc.tamper {
				// Simulate at-rest tampering: rewrite the payload so the
				// capture proof and payload hash no longer match the record.
				if _, err := journal.db.Exec(`UPDATE pending_operations SET payload_json = '{"tool":"bfb_add_comment","input":{"body":"forged"}}' WHERE request_id = ?`, tc.requestID); err != nil {
					t.Fatal(err)
				}
			}
			online := syntheticTransport()
			online.failCode = tc.failCode
			authority := &fakeAuthority{state: tc.authority}
			results, err := Replay(context.Background(), journal, online, authority, fakeReplayPolicy{allow: tc.policy}, syntheticTime.Add(tc.clockShift), 16)
			if err != nil {
				t.Fatal(err)
			}
			if len(results) != 1 || results[0].Disposition != tc.want || results[0].Reason != tc.reason {
				t.Fatalf("expected %s/%s, got %+v", tc.want, tc.reason, results)
			}
			if tc.want == "retryable" {
				if _, ok, _ := journal.Pending(tc.requestID); !ok {
					t.Fatalf("retryable record left pending state")
				}
			} else {
				if _, ok, _ := journal.Pending(tc.requestID); ok {
					t.Fatalf("rejected record still pending")
				}
				// A repeat of the same request reports the terminal rejection, never a new effect.
				offline := syntheticTransport()
				offline.online = false
				_, repeatHost := testHost(record, &fakeBindings{}, &fakeAuthority{}, offline, journal)
				if _, err := repeatHost.CallTool(context.Background(), tc.tool, tc.params); err == nil {
					t.Fatalf("rejected request returned success on repeat")
				}
				if len(online.commented)+len(online.progress)+len(online.updated) > 1 {
					t.Fatalf("rejected replay had effects")
				}
			}
		})
	}
}

func TestJournalMigrationAndBounds(t *testing.T) {
	journal, err := OpenJournal(t.TempDir() + "/meta.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	var version int
	if err := journal.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 11 {
		t.Fatalf("journal migration head is %d: %v", version, err)
	}
	record := syntheticAssignment()
	operation := PendingOperation{
		RequestID: "meta-01", Tool: "bfb_add_comment", Boundary: record.Boundary,
		SessionID: syntheticSession, Principal: "agent_run:" + record.Boundary.RunID, Grant: "g",
		PayloadHash: hashHex([]byte(`{}`)), PayloadJSON: `{}`, CapturedAt: syntheticTime.Format(time.RFC3339Nano),
		ExpiresAt: syntheticTime.Add(time.Hour).Format(time.RFC3339Nano), PolicyDecision: "pending_sync",
	}
	operation.CaptureProof = captureProof(operation)
	stored, err := journal.Store(operation)
	if err != nil || !stored {
		t.Fatalf("store failed: %v %v", stored, err)
	}
	stored, err = journal.Store(operation)
	if err != nil || stored {
		t.Fatalf("repeat store duplicated: %v %v", stored, err)
	}
	if count, _ := journal.CountForRun(record.Boundary.RunID); count != 1 {
		t.Fatalf("count is %d", count)
	}
}
