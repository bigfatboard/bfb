// ABOUTME: Proves peer, boundary, activation, revocation, and idempotency acceptance cases.
// ABOUTME: Attacks wrong UID, group, run, task, workspace, assignment, session, and caller IDs.

package localmcp

import (
	"context"
	"strings"
	"sync"
	"testing"
)

func TestVerifyPeerMaliciousMatrix(t *testing.T) {
	record := syntheticAssignment()
	cases := []struct {
		name      string
		facts     PeerFacts
		uid       int
		record    AssignmentRecord
		correlate string
		want      string
	}{
		{"happy path", syntheticFacts(), 501, record, syntheticCorrelation, ""},
		{"wrong UID", syntheticFacts(), 502, record, syntheticCorrelation, "peer_denied"},
		{"wrong PID and group", PeerFacts{UID: 501, PID: 9999, StartIdentity: "other", GroupID: 9999}, 501, record, syntheticCorrelation, "peer_denied"},
		{"group member without PID match", PeerFacts{UID: 501, PID: 4300, StartIdentity: "synthetic-start-4300", GroupID: 4242}, 501, record, syntheticCorrelation, ""},
		{"unknown assignment", syntheticFacts(), 501, AssignmentRecord{}, syntheticCorrelation, "assignment_unknown"},
		{"ended assignment", syntheticFacts(), 501, func() AssignmentRecord { ended := record; ended.Active = false; return ended }(), syntheticCorrelation, "assignment_ended"},
		{"wrong correlation", syntheticFacts(), 501, record, "attacker-correlation", "correlation_rejected"},
		{"empty correlation", syntheticFacts(), 501, record, "", "correlation_rejected"},
		{"wrong run boundary", syntheticFacts(), 501, func() AssignmentRecord {
			other := record
			other.Boundary.RunID = "01SYNTHETICRU00000000000002"
			other.Boundary.TaskID = "01SYNTHETICTA00000000000002"
			return other
		}(), syntheticCorrelation, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := VerifyPeer(tc.facts, tc.uid, tc.record, tc.correlate)
			if tc.want == "" && err != nil {
				t.Fatalf("expected success: %v", err)
			}
			if tc.want != "" && CodeOf(err) != tc.want {
				t.Fatalf("expected %s, got %v", tc.want, err)
			}
		})
	}
}

func TestCallerSuppliedIDsCannotEscape(t *testing.T) {
	record := syntheticAssignment()
	transport := syntheticTransport()
	bindings := &fakeBindings{}
	_, host := testHost(record, bindings, &fakeAuthority{}, transport, nil)
	ctx := context.Background()
	// The boundary holds in every capability state; binding up front lets
	// this one table cover both provisional reads and activated writes.
	bindings.setBound(syntheticSession, AssignmentRef{ExecutionID: record.Boundary.ExecutionID, AssignmentGeneration: record.Boundary.Generation, RunID: record.Boundary.RunID})
	foreign := "01FOREIGN00000000000000000001"
	escapes := []struct {
		name   string
		tool   string
		params map[string]any
	}{
		{"foreign task on read", "bfb_get_task", map[string]any{"task_id": foreign, "request_id": "escape-0001"}},
		{"foreign task on context", "bfb_get_context", map[string]any{"task_id": foreign, "request_id": "escape-0002"}},
		{"foreign project on propose", "bfb_propose_task", map[string]any{"project_id": foreign, "title": "Smuggled", "request_id": "escape-0003"}},
		{"foreign parent on propose", "bfb_propose_task", map[string]any{"parent_task_id": foreign, "title": "Smuggled", "request_id": "escape-0004"}},
		{"foreign task on comment", "bfb_add_comment", map[string]any{"task_id": foreign, "body": "Smuggled", "request_id": "escape-0005"}},
	}
	for _, tc := range escapes {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := host.CallTool(ctx, tc.tool, tc.params); CodeOf(err) != "boundary_escape" {
				t.Fatalf("expected boundary_escape, got %v", err)
			}
		})
	}
	if len(transport.commented) != 0 || len(transport.proposed) != 0 {
		t.Fatalf("escaped calls had effects: %+v", transport)
	}
}

func TestProvisionalReadOnlyThenActivation(t *testing.T) {
	record := syntheticAssignment()
	transport := syntheticTransport()
	bindings := &fakeBindings{}
	capability, host := testHost(record, bindings, &fakeAuthority{}, transport, nil)
	ctx := context.Background()
	if _, err := host.CallTool(ctx, "bfb_get_task", map[string]any{"request_id": "bootstrap-01"}); err != nil {
		t.Fatalf("provisional read failed: %v", err)
	}
	if _, err := host.CallTool(ctx, "bfb_get_context", map[string]any{"request_id": "bootstrap-02"}); err != nil {
		t.Fatalf("provisional context failed: %v", err)
	}
	if _, err := host.CallTool(ctx, "bfb_add_comment", map[string]any{"body": "Too early", "request_id": "bootstrap-03"}); CodeOf(err) != "session_not_bound" {
		t.Fatalf("expected session_not_bound, got %v", err)
	}
	if capability.State() != StateProvisional {
		t.Fatalf("mutation attempt changed state to %s", capability.State())
	}
	bindings.setBound(syntheticSession, AssignmentRef{ExecutionID: record.Boundary.ExecutionID, AssignmentGeneration: record.Boundary.Generation, RunID: record.Boundary.RunID})
	result, err := host.CallTool(ctx, "bfb_add_comment", map[string]any{"body": "Bound now", "request_id": "bootstrap-04"})
	if err != nil {
		t.Fatalf("activated write failed: %v", err)
	}
	if capability.State() != StateActivated || capability.SessionID() != syntheticSession {
		t.Fatalf("capability did not activate: %s", capability.State())
	}
	if result.(CommentResult).ID == "" || len(transport.commented) != 1 {
		t.Fatalf("activated write had no effect: %+v", result)
	}
}

func TestCompetingSessionNeverActivates(t *testing.T) {
	record := syntheticAssignment()
	bindings := &fakeBindings{}
	capability, _ := testHost(record, bindings, &fakeAuthority{}, syntheticTransport(), nil)
	ctx := context.Background()
	ref := AssignmentRef{ExecutionID: record.Boundary.ExecutionID, AssignmentGeneration: record.Boundary.Generation, RunID: record.Boundary.RunID}
	bindings.setBound("session-winner", ref)
	if err := capability.activate(ctx); err != nil {
		t.Fatalf("first activation failed: %v", err)
	}
	bindings.setBound("session-competitor", ref)
	if err := capability.activate(ctx); CodeOf(err) != "session_conflict" {
		t.Fatalf("expected session_conflict, got %v", err)
	}
	if capability.SessionID() != "session-winner" {
		t.Fatalf("competitor replaced the session: %s", capability.SessionID())
	}
}

func TestConcurrentActivationHasOneWinner(t *testing.T) {
	record := syntheticAssignment()
	transport := syntheticTransport()
	bindings := &fakeBindings{}
	capability, host := testHost(record, bindings, &fakeAuthority{}, transport, nil)
	ctx := context.Background()
	bindings.setBound(syntheticSession, AssignmentRef{ExecutionID: record.Boundary.ExecutionID, AssignmentGeneration: record.Boundary.Generation, RunID: record.Boundary.RunID})
	var wg sync.WaitGroup
	failures := make([]error, 16)
	for index := range failures {
		wg.Add(1)
		go func(slot int) {
			defer wg.Done()
			_, failures[slot] = host.CallTool(ctx, "bfb_report_progress", map[string]any{
				"summary":    "Concurrent heartbeat",
				"request_id": "race-00" + string(rune('a'+slot)),
			})
		}(index)
	}
	wg.Wait()
	for index, err := range failures {
		if err != nil {
			t.Fatalf("concurrent write %d failed: %v", index, err)
		}
	}
	if capability.State() != StateActivated || capability.SessionID() != syntheticSession {
		t.Fatalf("activation did not stick: %s", capability.State())
	}
	if len(transport.progress) != 16 {
		t.Fatalf("expected 16 progress effects, got %d", len(transport.progress))
	}
}

func TestRevocationExecutionEndAndTerminalResultClose(t *testing.T) {
	record := syntheticAssignment()
	closes := []struct {
		name  string
		state AuthorityState
		code  string
	}{
		{"revocation", AuthorityState{Revoked: true}, "revoked"},
		{"execution end", AuthorityState{ExecutionEnded: true}, "assignment_ended"},
		{"accepted result", AuthorityState{ResultTerminal: true}, "capability_closed"},
	}
	for _, tc := range closes {
		t.Run(tc.name, func(t *testing.T) {
			transport := syntheticTransport()
			authority := &fakeAuthority{state: tc.state}
			capability, host := testHost(record, &fakeBindings{}, authority, transport, nil)
			ctx := context.Background()
			if _, err := host.CallTool(ctx, "bfb_get_task", map[string]any{"request_id": "close-0001"}); CodeOf(err) != tc.code {
				t.Fatalf("expected %s, got %v", tc.code, err)
			}
			if capability.State() != StateClosed {
				t.Fatalf("capability did not close")
			}
			if _, err := host.CallTool(ctx, "bfb_get_task", map[string]any{"request_id": "close-0002"}); CodeOf(err) != "capability_closed" {
				t.Fatalf("closed capability served a read: %v", err)
			}
		})
	}
}

func TestVersionConflictAndIdempotency(t *testing.T) {
	record := syntheticAssignment()
	transport := syntheticTransport()
	bindings := &fakeBindings{}
	_, host := testHost(record, bindings, &fakeAuthority{}, transport, nil)
	ctx := context.Background()
	bindings.setBound(syntheticSession, AssignmentRef{ExecutionID: record.Boundary.ExecutionID, AssignmentGeneration: record.Boundary.Generation, RunID: record.Boundary.RunID})
	transport.failCode = "stale_version"
	if _, err := host.CallTool(ctx, "bfb_update_task", map[string]any{"expected_version": float64(3), "title": "Stale", "request_id": "version-01"}); CodeOf(err) != "stale_version" {
		t.Fatalf("expected stale_version, got %v", err)
	}
	transport.failCode = ""
	first, err := host.CallTool(ctx, "bfb_update_task", map[string]any{"expected_version": float64(3), "title": "Fresh", "request_id": "version-02"})
	if err != nil {
		t.Fatalf("update failed: %v", err)
	}
	second, err := host.CallTool(ctx, "bfb_update_task", map[string]any{"expected_version": float64(3), "title": "Fresh", "request_id": "version-02"})
	if err != nil {
		t.Fatalf("idempotent repeat failed: %v", err)
	}
	if first.(TaskView).Title != "Fresh" || second.(TaskView).Title != "Fresh" {
		t.Fatalf("unexpected titles: %+v %+v", first, second)
	}
	if len(transport.updated) != 1 {
		t.Fatalf("idempotent repeat re-executed: %d effects", len(transport.updated))
	}
}

func TestWriteValidationRejects(t *testing.T) {
	record := syntheticAssignment()
	bindings := &fakeBindings{}
	_, host := testHost(record, bindings, &fakeAuthority{}, syntheticTransport(), nil)
	ctx := context.Background()
	bindings.setBound(syntheticSession, AssignmentRef{ExecutionID: record.Boundary.ExecutionID, AssignmentGeneration: record.Boundary.Generation, RunID: record.Boundary.RunID})
	rejects := []struct {
		name   string
		tool   string
		params map[string]any
		code   string
	}{
		{"workflow state smuggled", "bfb_update_task", map[string]any{"expected_version": float64(3), "state": "done", "request_id": "reject-001"}, "invalid_params"},
		{"promotion smuggled", "bfb_update_task", map[string]any{"expected_version": float64(3), "promote": true, "request_id": "reject-002"}, "invalid_params"},
		{"priority smuggled", "bfb_update_task", map[string]any{"expected_version": float64(3), "priority": "P0", "request_id": "reject-003"}, "invalid_params"},
		{"short request id", "bfb_get_task", map[string]any{"request_id": "short"}, "invalid_request"},
		{"percent overflow", "bfb_report_progress", map[string]any{"summary": "x", "percent": float64(101), "request_id": "reject-004"}, "invalid_params"},
		{"empty title", "bfb_propose_task", map[string]any{"title": "   ", "request_id": "reject-005"}, "invalid_params"},
		{"bad priority", "bfb_propose_task", map[string]any{"title": "x", "priority": "P9", "request_id": "reject-006"}, "invalid_params"},
		{"root proposal rejected by policy", "bfb_propose_task", map[string]any{"title": "Root backlog", "request_id": "reject-007"}, "policy_rejected"},
		{"attention request validated", "bfb_request_human", map[string]any{"request_id": "reject-008"}, "invalid_params"},
		{"result tool requires summary", "bfb_submit_result", map[string]any{"request_id": "reject-009"}, "invalid_params"},
		{"unknown tool", "bfb_launch_rocket", map[string]any{"request_id": "reject-010"}, "method_not_found"},
	}
	for _, tc := range rejects {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := host.CallTool(ctx, tc.tool, tc.params); CodeOf(err) != tc.code {
				t.Fatalf("expected %s, got %v", tc.code, err)
			}
		})
	}
}

func TestOfflineJournalingAndPolicy(t *testing.T) {
	record := syntheticAssignment()
	transport := syntheticTransport()
	transport.online = false
	bindings := &fakeBindings{}
	journalPath := t.TempDir() + "/offline.sqlite"
	journal, err := OpenJournal(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	_, host := testHost(record, bindings, &fakeAuthority{}, transport, journal)
	ctx := context.Background()
	if _, err := host.CallTool(ctx, "bfb_get_task", map[string]any{"request_id": "offline-01"}); CodeOf(err) != "offline_rejected" {
		t.Fatalf("offline read must fail visibly: %v", err)
	}
	bindings.setBound(syntheticSession, AssignmentRef{ExecutionID: record.Boundary.ExecutionID, AssignmentGeneration: record.Boundary.Generation, RunID: record.Boundary.RunID})
	result, err := host.CallTool(ctx, "bfb_add_comment", map[string]any{"body": "Queued offline", "request_id": "offline-02"})
	if err != nil {
		t.Fatalf("offline write must journal: %v", err)
	}
	outcome := result.(map[string]any)
	if outcome["status"] != "pending_sync" || outcome["request_id"] != "offline-02" {
		t.Fatalf("unexpected offline outcome: %+v", outcome)
	}
	repeat, err := host.CallTool(ctx, "bfb_add_comment", map[string]any{"body": "Queued offline", "request_id": "offline-02"})
	if err != nil {
		t.Fatalf("offline repeat failed: %v", err)
	}
	if repeat.(map[string]any)["expires_at"] != outcome["expires_at"] {
		t.Fatalf("offline repeat created a second record: %+v", repeat)
	}
	if count, _ := journal.CountForRun(record.Boundary.RunID); count != 1 {
		t.Fatalf("expected 1 journaled operation, got %d", count)
	}
	stored, ok, err := journal.Pending("offline-02")
	if err != nil || !ok {
		t.Fatalf("journaled operation missing: %v", err)
	}
	for _, field := range []string{stored.Principal, stored.Grant, stored.SessionID, stored.PayloadHash, stored.CaptureProof, stored.CapturedAt, stored.ExpiresAt, stored.PolicyDecision} {
		if field == "" {
			t.Fatalf("journaled operation misses evidence: %+v", stored)
		}
	}
	if !strings.HasPrefix(stored.PayloadHash, "sha256:") || stored.PolicyDecision != "pending_sync" {
		t.Fatalf("journaled operation malformed: %+v", stored)
	}
}
