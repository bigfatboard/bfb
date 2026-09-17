// ABOUTME: Proves result submission validation, activation, offline journaling, and replay.
// ABOUTME: Uses synthetic identities only; no test reaches the network or the daemon database.

package localmcp

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func openRawSQLite(path string) (*sql.DB, error) {
	return sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)")
}

func submitParams(requestID string) map[string]any {
	return map[string]any{
		"summary":     "Synthetic result summary",
		"limitations": "Synthetic limitation",
		"evidence_refs": []any{
			map[string]any{"kind": "comment", "ref": "synthetic-comment", "version": "1"},
			map[string]any{"kind": "artifact_version", "ref": "synthetic-artifact", "hash": "sha256:" + strings.Repeat("a", 64)},
		},
		"git_branch": "main",
		"git_commit": strings.Repeat("b", 40),
		"git_dirty":  false,
		"request_id": requestID,
	}
}

func boundRef() AssignmentRef {
	return AssignmentRef{ExecutionID: syntheticBoundary.ExecutionID, AssignmentGeneration: syntheticBoundary.Generation, RunID: syntheticBoundary.RunID}
}

func TestSubmitResultValidationMatrix(t *testing.T) {
	oversized := "x" + strings.Repeat("y", 2048)
	many := make([]any, 0, 21)
	for i := 0; i < 21; i++ {
		many = append(many, map[string]any{"kind": "comment", "ref": "ref"})
	}
	cases := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"missing summary", func(params map[string]any) { delete(params, "summary") }},
		{"empty summary", func(params map[string]any) { params["summary"] = "   " }},
		{"oversized summary", func(params map[string]any) { params["summary"] = oversized }},
		{"control summary", func(params map[string]any) { params["summary"] = "bad\x01summary" }},
		{"oversized limitations", func(params map[string]any) { params["limitations"] = oversized }},
		{"evidence not array", func(params map[string]any) { params["evidence_refs"] = "nope" }},
		{"evidence overflow", func(params map[string]any) { params["evidence_refs"] = many }},
		{"evidence smuggled field", func(params map[string]any) {
			params["evidence_refs"] = []any{map[string]any{"kind": "comment", "ref": "x", "workspace_id": "smuggled"}}
		}},
		{"evidence bad kind", func(params map[string]any) {
			params["evidence_refs"] = []any{map[string]any{"kind": "Bad Kind!", "ref": "x"}}
		}},
		{"evidence empty ref", func(params map[string]any) {
			params["evidence_refs"] = []any{map[string]any{"kind": "comment", "ref": "  "}}
		}},
		{"evidence bad version", func(params map[string]any) {
			params["evidence_refs"] = []any{map[string]any{"kind": "comment", "ref": "x", "version": ""}}
		}},
		{"evidence bad hash", func(params map[string]any) {
			params["evidence_refs"] = []any{map[string]any{"kind": "comment", "ref": "x", "hash": "md5:nope"}}
		}},
		{"evidence duplicate", func(params map[string]any) {
			dup := map[string]any{"kind": "comment", "ref": "same", "version": "1"}
			params["evidence_refs"] = []any{dup, map[string]any{"kind": "comment", "ref": "same", "version": "1"}}
		}},
		{"bad branch", func(params map[string]any) { params["git_branch"] = "" }},
		{"bad commit", func(params map[string]any) { params["git_commit"] = "short" }},
		{"uppercase commit", func(params map[string]any) { params["git_commit"] = strings.Repeat("B", 40) }},
		{"non-boolean dirty", func(params map[string]any) { params["git_dirty"] = "yes" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			params := submitParams("submit-matrix-001")
			tc.mutate(params)
			if _, _, err := ValidateSubmitInput(params); CodeOf(err) != "invalid_params" {
				t.Fatalf("expected invalid_params, got %v", err)
			}
		})
	}
}

func TestSubmitResultAcceptsMinimalAndFull(t *testing.T) {
	minimal, canonical, err := ValidateSubmitInput(map[string]any{"summary": " Minimal "})
	if err != nil {
		t.Fatalf("minimal submit rejected: %v", err)
	}
	if minimal.Summary != "Minimal" || minimal.Limitations != "" || len(minimal.Evidence) != 0 {
		t.Fatalf("unexpected minimal input: %+v", minimal)
	}
	if len(canonical) != 1 {
		t.Fatalf("minimal canonical carries extras: %+v", canonical)
	}
	full, canonical, err := ValidateSubmitInput(submitParams("submit-full-001"))
	if err != nil {
		t.Fatalf("full submit rejected: %v", err)
	}
	if full.Summary != "Synthetic result summary" || full.Limitations != "Synthetic limitation" {
		t.Fatalf("unexpected full input: %+v", full)
	}
	if len(full.Evidence) != 2 || full.GitBranch == nil || *full.GitBranch != "main" {
		t.Fatalf("unexpected full evidence/git: %+v", full)
	}
	if full.GitCommit == nil || *full.GitCommit != strings.Repeat("b", 40) {
		t.Fatalf("unexpected full commit: %+v", full)
	}
	if full.GitDirty == nil || *full.GitDirty {
		t.Fatalf("unexpected full dirty: %+v", full)
	}
	if canonical["summary"] != "Synthetic result summary" {
		t.Fatalf("canonical drops summary: %+v", canonical)
	}
}

func TestSubmitResultProvisionalRejects(t *testing.T) {
	record := syntheticAssignment()
	_, host := testHost(record, &fakeBindings{}, &fakeAuthority{}, syntheticTransport(), nil)
	if _, err := host.CallTool(context.Background(), "bfb_submit_result", submitParams("submit-prov-001")); CodeOf(err) != "session_not_bound" {
		t.Fatalf("provisional submit must fail closed, got %v", err)
	}
	if _, err := host.CallTool(context.Background(), "bfb_get_task", map[string]any{"request_id": "submit-prov-002"}); err != nil {
		t.Fatalf("provisional read must stay available: %v", err)
	}
}

func TestSubmitResultActivatedSuccessAndIdempotent(t *testing.T) {
	record := syntheticAssignment()
	bindings := &fakeBindings{}
	transport := syntheticTransport()
	_, host := testHost(record, bindings, &fakeAuthority{}, transport, nil)
	bindings.setBound(syntheticSession, boundRef())
	result, err := host.CallTool(context.Background(), "bfb_submit_result", submitParams("submit-active-001"))
	if err != nil {
		t.Fatalf("activated submit failed: %v", err)
	}
	submission, ok := result.(SubmitResultResult)
	if !ok || submission.SubmissionID == "" || submission.Version != 1 || submission.ResultState != "submitted" {
		t.Fatalf("unexpected submission outcome: %+v", result)
	}
	repeat, err := host.CallTool(context.Background(), "bfb_submit_result", submitParams("submit-active-001"))
	if err != nil {
		t.Fatalf("idempotent repeat failed: %v", err)
	}
	if repeat.(SubmitResultResult).SubmissionID != submission.SubmissionID {
		t.Fatalf("repeat created a second submission: %+v vs %+v", repeat, result)
	}
	if len(transport.submitted) != 1 {
		t.Fatalf("idempotent repeat re-executed: %d effects", len(transport.submitted))
	}
	stored := transport.submitted[0]
	if stored.Summary != "Synthetic result summary" || len(stored.Evidence) != 2 || stored.GitCommit == nil {
		t.Fatalf("transport lost submission fields: %+v", stored)
	}
}

func TestSubmitResultOfflineJournals(t *testing.T) {
	record := syntheticAssignment()
	bindings := &fakeBindings{}
	transport := syntheticTransport()
	transport.online = false
	journalPath := t.TempDir() + "/submit-offline.sqlite"
	journal, err := OpenJournal(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	_, host := testHost(record, bindings, &fakeAuthority{}, transport, journal)
	bindings.setBound(syntheticSession, boundRef())
	result, err := host.CallTool(context.Background(), "bfb_submit_result", submitParams("submit-off-001"))
	if err != nil {
		t.Fatalf("offline submit must journal: %v", err)
	}
	outcome := result.(map[string]any)
	if outcome["status"] != "pending_sync" || outcome["request_id"] != "submit-off-001" || outcome["tool"] != "bfb_submit_result" {
		t.Fatalf("unexpected offline outcome: %+v", outcome)
	}
	repeat, err := host.CallTool(context.Background(), "bfb_submit_result", submitParams("submit-off-001"))
	if err != nil {
		t.Fatalf("offline repeat failed: %v", err)
	}
	if repeat.(map[string]any)["expires_at"] != outcome["expires_at"] {
		t.Fatalf("offline repeat created a second record: %+v", repeat)
	}
	stored, ok, err := journal.Pending("submit-off-001")
	if err != nil || !ok {
		t.Fatalf("journaled submission missing: %v", err)
	}
	for _, field := range []string{stored.Principal, stored.Grant, stored.SessionID, stored.PayloadHash, stored.CaptureProof, stored.CapturedAt, stored.ExpiresAt, stored.PolicyDecision} {
		if field == "" {
			t.Fatalf("journaled submission misses evidence: %+v", stored)
		}
	}
	if stored.Tool != "bfb_submit_result" || stored.ExpectedVersion != 0 {
		t.Fatalf("unexpected journaled submission: %+v", stored)
	}
	if count, _ := journal.CountForRun(record.Boundary.RunID); count != 1 {
		t.Fatalf("expected 1 journaled operation, got %d", count)
	}
}

func TestSubmitResultOfflinePolicyRefusal(t *testing.T) {
	record := syntheticAssignment()
	bindings := &fakeBindings{}
	transport := syntheticTransport()
	transport.online = false
	capability := NewCapability(record.Boundary, bindings, &fakeAuthority{})
	host := NewHost(HostDeps{
		Capability: capability,
		Transport:  transport,
		Policy:     DefaultOfflinePolicy{AllowPending: false},
		Principal:  "agent_run:" + record.Boundary.RunID,
		Now:        func() time.Time { return syntheticTime },
	})
	bindings.setBound(syntheticSession, boundRef())
	if _, err := host.CallTool(context.Background(), "bfb_submit_result", submitParams("submit-pol-001")); CodeOf(err) != "offline_rejected" {
		t.Fatalf("prohibited pending-sync must fail visibly, got %v", err)
	}
}

func TestSubmitResultReplayMatrix(t *testing.T) {
	stage := func(t *testing.T, requestID string) Journal {
		t.Helper()
		record := syntheticAssignment()
		bindings := &fakeBindings{}
		transport := syntheticTransport()
		transport.online = false
		journal, err := OpenJournal(t.TempDir() + "/submit-replay.sqlite")
		if err != nil {
			t.Fatal(err)
		}
		_, host := testHost(record, bindings, &fakeAuthority{}, transport, journal)
		bindings.setBound(syntheticSession, boundRef())
		if _, err := host.CallTool(context.Background(), "bfb_submit_result", submitParams(requestID)); err != nil {
			t.Fatalf("staging submit failed: %v", err)
		}
		return journal
	}
	t.Run("applied once with transport idempotency", func(t *testing.T) {
		journal := stage(t, "submit-replay-ok")
		defer journal.Close()
		online := syntheticTransport()
		results, err := Replay(context.Background(), journal, online, &fakeAuthority{}, fakeReplayPolicy{allow: true}, syntheticTime.Add(time.Hour), 16)
		if err != nil {
			t.Fatal(err)
		}
		if len(results) != 1 || results[0].Disposition != "applied" {
			t.Fatalf("unexpected replay results: %+v", results)
		}
		if len(online.submitted) != 1 {
			t.Fatalf("expected 1 replayed effect, got %d", len(online.submitted))
		}
		again, err := Replay(context.Background(), journal, online, &fakeAuthority{}, fakeReplayPolicy{allow: true}, syntheticTime.Add(time.Hour), 16)
		if err != nil {
			t.Fatal(err)
		}
		if len(again) != 0 || len(online.submitted) != 1 {
			t.Fatalf("replay re-executed an applied submission: %+v", again)
		}
		outcome, code, ok, err := journal.Outcome("submit-replay-ok")
		if err != nil || !ok || code != "" || outcome == nil {
			t.Fatalf("applied outcome missing: %+v %q %v %v", outcome, code, ok, err)
		}
	})
	terminal := []struct {
		name   string
		state  AuthorityState
		policy bool
		clock  time.Duration
		reason string
	}{
		{"revoked", AuthorityState{Revoked: true}, true, time.Hour, "revoked"},
		{"execution ended", AuthorityState{ExecutionEnded: true}, true, time.Hour, "execution_ended"},
		{"terminal result", AuthorityState{ResultTerminal: true}, true, time.Hour, "result_terminal"},
		{"expired", AuthorityState{}, true, 25 * time.Hour, "expired"},
		{"policy changed", AuthorityState{}, false, time.Hour, "policy_changed"},
	}
	for _, tc := range terminal {
		t.Run(tc.name, func(t *testing.T) {
			journal := stage(t, "submit-replay-"+strings.ReplaceAll(tc.name, " ", "-"))
			defer journal.Close()
			online := syntheticTransport()
			results, err := Replay(context.Background(), journal, online, &fakeAuthority{state: tc.state}, fakeReplayPolicy{allow: tc.policy}, syntheticTime.Add(tc.clock), 16)
			if err != nil {
				t.Fatal(err)
			}
			if len(results) != 1 || results[0].Disposition != "rejected" || results[0].Reason != tc.reason {
				t.Fatalf("unexpected replay result: %+v", results)
			}
			if len(online.submitted) != 0 {
				t.Fatalf("stale submission was applied: %d effects", len(online.submitted))
			}
		})
	}
}

func TestSubmitJournalWidensVersion11(t *testing.T) {
	path := t.TempDir() + "/submit-v11.sqlite"
	raw, err := openRawSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = raw.Exec(`CREATE TABLE pending_operations (
    request_id TEXT PRIMARY KEY,
    tool TEXT NOT NULL CHECK (tool IN ('bfb_update_task', 'bfb_add_comment', 'bfb_report_progress', 'bfb_propose_task')),
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    runner_id TEXT NOT NULL,
    checkout_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    assignment_generation INTEGER NOT NULL CHECK (assignment_generation >= 1),
    observed_session_id TEXT NOT NULL,
    principal TEXT NOT NULL,
    grant_name TEXT NOT NULL,
    expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
    payload_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    capture_proof TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    policy_decision TEXT NOT NULL CHECK (policy_decision = 'pending_sync'),
    state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'rejected')),
    outcome_json TEXT
) STRICT`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = raw.Exec(`INSERT INTO pending_operations
(request_id, tool, workspace_id, project_id, task_id, run_id, runner_id, checkout_id,
 execution_id, assignment_generation, observed_session_id, principal, grant_name,
 expected_version, payload_hash, payload_json, capture_proof, captured_at, expires_at,
 policy_decision, state, outcome_json)
VALUES ('legacy-01', 'bfb_add_comment', 'w', 'p', 't', 'r', 'n', 'c', 'e', 7,
 's', 'agent_run:r', 'g', 0, 'h', '{}', 'proof', '2026-09-17T12:00:00Z',
 '2026-09-18T12:00:00Z', 'pending_sync', 'pending', NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err = raw.Exec(`PRAGMA user_version=11`); err != nil {
		t.Fatal(err)
	}
	if err = raw.Close(); err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	journal, err := OpenJournal(path)
	if err != nil {
		t.Fatalf("version-11 journal must widen: %v", err)
	}
	defer journal.Close()
	var version int
	if err := journal.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 12 {
		t.Fatalf("journal migration head is %d: %v", version, err)
	}
	legacy, ok, err := journal.Pending("legacy-01")
	if err != nil || !ok || legacy.Tool != "bfb_add_comment" {
		t.Fatalf("widening lost the legacy row: %+v %v %v", legacy, ok, err)
	}
	record := syntheticAssignment()
	stored, err := journal.Store(PendingOperation{
		RequestID: "widened-submit-01", Tool: "bfb_submit_result", Boundary: record.Boundary,
		SessionID: syntheticSession, Principal: "agent_run:" + record.Boundary.RunID, Grant: "g",
		PayloadHash: hashHex([]byte(`{}`)), PayloadJSON: `{}`, CaptureProof: "proof",
		CapturedAt: syntheticTime.Format(time.RFC3339Nano),
		ExpiresAt:  syntheticTime.Add(time.Hour).Format(time.RFC3339Nano), PolicyDecision: "pending_sync",
	})
	if err != nil || !stored {
		t.Fatalf("widened journal rejects submissions: %v %v", stored, err)
	}
}

func TestSubmitResultTerminalCloses(t *testing.T) {
	record := syntheticAssignment()
	authority := &fakeAuthority{state: AuthorityState{ResultTerminal: true}}
	_, host := testHost(record, &fakeBindings{}, authority, syntheticTransport(), nil)
	if _, err := host.CallTool(context.Background(), "bfb_submit_result", submitParams("submit-term-001")); CodeOf(err) != "capability_closed" {
		t.Fatalf("terminal result must close the capability, got %v", err)
	}
	if _, err := host.CallTool(context.Background(), "bfb_get_task", map[string]any{"request_id": "submit-term-002"}); CodeOf(err) != "capability_closed" {
		t.Fatalf("terminal close must stick, got %v", err)
	}
}

func TestSubmitResultStdioPurity(t *testing.T) {
	harness, bindings := happyHarness(nil)
	bindings.setBound(syntheticSession, boundRef())
	harness.server.serveLine(context.Background(), bufio.NewWriter(harness.stdout),
		[]byte(`{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"bfb_submit_result","arguments":{"summary":"Synthetic purity summary","request_id":"submit-pure-001"}}}`+"\n"))
	raw := harness.stdout.String()
	lines := strings.Split(strings.TrimSpace(raw), "\n")
	if len(lines) != 1 {
		t.Fatalf("expected 1 stdout line, got:\n%s", raw)
	}
	var envelope struct {
		Result struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(lines[0]), &envelope); err != nil {
		t.Fatalf("stdout is not JSON: %v", err)
	}
	if len(envelope.Result.Content) != 1 {
		t.Fatalf("unexpected content: %s", lines[0])
	}
	var outcome SubmitResultResult
	if err := json.Unmarshal([]byte(envelope.Result.Content[0].Text), &outcome); err != nil {
		t.Fatalf("content is not a submission outcome: %v", err)
	}
	if outcome.SubmissionID == "" || outcome.ResultState != "submitted" {
		t.Fatalf("unexpected outcome: %+v", outcome)
	}
	for _, leak := range []string{"Synthetic purity summary", syntheticCorrelation} {
		if strings.Contains(harness.stdout.String(), leak) || strings.Contains(harness.stderr.String(), leak) {
			t.Fatalf("response or diagnostic leaks private material: %q", leak)
		}
	}
}
