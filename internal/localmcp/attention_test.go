// ABOUTME: Proves A02 attention request, read, bounded wait, and offline replay.
// ABOUTME: Uses synthetic doubles only; the human answering side is driven through the fake.

package localmcp

import (
	"context"
	"testing"
	"time"
)

func boundHost(transport *fakeTransport, journal Journal) (*fakeBindings, *fakeAuthority, *Host) {
	record := syntheticAssignment()
	bindings := &fakeBindings{}
	authority := &fakeAuthority{}
	ref := AssignmentRef{ExecutionID: record.Boundary.ExecutionID, AssignmentGeneration: record.Boundary.Generation, RunID: record.Boundary.RunID}
	bindings.setBound(syntheticSession, ref)
	_, host := testHost(record, bindings, authority, transport, journal)
	return bindings, authority, host
}

func attentionParams(entries map[string]any) map[string]any {
	params := map[string]any{
		"kind": "clarification", "question": "Synthetic question",
		"blocking": true, "request_id": "attention-req-001",
	}
	for key, value := range entries {
		params[key] = value
	}
	return params
}

func TestRequestHumanCommitsAndReplaysIdempotently(t *testing.T) {
	transport := syntheticTransport()
	_, _, host := boundHost(transport, nil)
	ctx := context.Background()
	first, err := host.CallTool(ctx, "bfb_request_human", attentionParams(nil))
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	record, ok := first.(AttentionRecord)
	if !ok || record.State != "open" || record.RequiredRole != "reviewer" || record.Question != "Synthetic question" {
		t.Fatalf("unexpected attention record: %+v", first)
	}
	second, err := host.CallTool(ctx, "bfb_request_human", attentionParams(nil))
	if err != nil {
		t.Fatalf("replay failed: %v", err)
	}
	if second.(AttentionRecord).ID != record.ID {
		t.Fatalf("repeated request_id created a second request: %+v", second)
	}
	got, err := host.CallTool(ctx, "bfb_get_attention", map[string]any{"attention_id": record.ID, "request_id": "attention-get-001"})
	if err != nil {
		t.Fatalf("get failed: %v", err)
	}
	if got.(AttentionRecord).ID != record.ID {
		t.Fatalf("get returned a different record: %+v", got)
	}
}

func TestRequestHumanValidation(t *testing.T) {
	transport := syntheticTransport()
	_, _, host := boundHost(transport, nil)
	ctx := context.Background()
	cases := []map[string]any{
		attentionParams(map[string]any{"kind": "telepathy"}),
		attentionParams(map[string]any{"question": "   "}),
		attentionParams(map[string]any{"reference_kind": "artifact_version"}),
		attentionParams(map[string]any{"blocking": "yes"}),
		attentionParams(map[string]any{"kind": "review", "question": "Synthetic", "blocking": false, "request_id": "short"}),
	}
	for index, params := range cases {
		if _, err := host.CallTool(ctx, "bfb_request_human", params); CodeOf(err) != "invalid_params" && CodeOf(err) != "invalid_request" {
			t.Fatalf("case %d: expected bounded rejection, got %v", index, err)
		}
	}
	if _, err := host.CallTool(ctx, "bfb_request_human", attentionParams(map[string]any{"request_id": "attention-req-002", "unknown": 1})); CodeOf(err) != "invalid_params" {
		t.Fatalf("unknown field must be rejected, got %v", err)
	}
}

func TestAttentionReadsBeforeBindingWritesAfter(t *testing.T) {
	transport := syntheticTransport()
	record := syntheticAssignment()
	_, host := testHost(record, &fakeBindings{}, &fakeAuthority{}, transport, nil)
	ctx := context.Background()
	if _, err := host.CallTool(ctx, "bfb_request_human", attentionParams(nil)); CodeOf(err) != "session_not_bound" {
		t.Fatalf("provisional mutation must fail, got %v", err)
	}
	if _, err := host.CallTool(ctx, "bfb_get_attention", map[string]any{"attention_id": "attention-9", "request_id": "attention-get-002"}); CodeOf(err) != "not_found" {
		t.Fatalf("provisional read must reach the transport, got %v", err)
	}
}

func TestGetAttentionEnforcesRunBoundary(t *testing.T) {
	transport := syntheticTransport()
	_, _, hostA := boundHost(transport, nil)
	ctx := context.Background()
	created, err := hostA.CallTool(ctx, "bfb_request_human", attentionParams(nil))
	if err != nil {
		t.Fatal(err)
	}
	id := created.(AttentionRecord).ID
	other := syntheticAssignment()
	other.Boundary.RunID = "01SYNTHETICRU00000000000002"
	bindings := &fakeBindings{}
	bindings.setBound(syntheticSession, AssignmentRef{ExecutionID: other.Boundary.ExecutionID, AssignmentGeneration: other.Boundary.Generation, RunID: other.Boundary.RunID})
	_, hostB := testHost(other, bindings, &fakeAuthority{}, transport, nil)
	if _, err := hostB.CallTool(ctx, "bfb_get_attention", map[string]any{"attention_id": id, "request_id": "attention-get-003"}); CodeOf(err) != "not_found" {
		t.Fatalf("cross-run attention must stay hidden, got %v", err)
	}
}

func TestWaitReturnsAnswerCommittedMidWait(t *testing.T) {
	transport := syntheticTransport()
	_, _, host := boundHost(transport, nil)
	ctx := context.Background()
	created, err := host.CallTool(ctx, "bfb_request_human", attentionParams(nil))
	if err != nil {
		t.Fatal(err)
	}
	id := created.(AttentionRecord).ID
	go func() {
		time.Sleep(150 * time.Millisecond)
		transport.answerAttention(id, "Synthetic committed answer")
	}()
	start := time.Now()
	outcome, err := host.CallTool(ctx, "bfb_wait_for_attention", map[string]any{"attention_id": id, "request_id": "attention-wait-001"})
	if err != nil {
		t.Fatalf("wait failed: %v", err)
	}
	elapsed := time.Since(start)
	result := outcome.(map[string]any)
	if result["status"] != "answered" {
		t.Fatalf("waiter missed the committed answer: %+v", result)
	}
	if result["attention"].(AttentionRecord).Answer != "Synthetic committed answer" {
		t.Fatalf("waiter lost the answer text: %+v", result)
	}
	if elapsed >= attentionWaitTimeout {
		t.Fatalf("waiter outlived its bound: %v", elapsed)
	}
}

func TestWaitTimesOutPendingAndRepeatsSafely(t *testing.T) {
	transport := syntheticTransport()
	_, _, host := boundHost(transport, nil)
	created, err := host.CallTool(context.Background(), "bfb_request_human", attentionParams(nil))
	if err != nil {
		t.Fatal(err)
	}
	id := created.(AttentionRecord).ID
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	start := time.Now()
	outcome, err := host.CallTool(ctx, "bfb_wait_for_attention", map[string]any{"attention_id": id, "request_id": "attention-wait-002"})
	if err != nil {
		t.Fatalf("bounded wait must not fail: %v", err)
	}
	if outcome.(map[string]any)["status"] != "pending" {
		t.Fatalf("unanswered wait must report pending: %+v", outcome)
	}
	if elapsed := time.Since(start); elapsed >= attentionWaitTimeout {
		t.Fatalf("short wait outlived the 30-second bound: %v", elapsed)
	}
	transport.answerAttention(id, "Synthetic late answer")
	repeated, err := host.CallTool(context.Background(), "bfb_wait_for_attention", map[string]any{"attention_id": id, "request_id": "attention-wait-002"})
	if err != nil {
		t.Fatalf("repeated wait failed: %v", err)
	}
	// Pending outcomes are never memoized: the same request_id re-reads
	// committed state and observes the late answer.
	if repeated.(map[string]any)["status"] != "answered" {
		t.Fatalf("repeated wait did not observe the answer: %+v", repeated)
	}
}

// Attention tools need a live channel: a question is only useful inside a
// live waiter loop, so every tool fails visibly offline instead of queueing
// a stale question in the A01 task-mutation journal.
func TestAttentionOfflineFailsVisibleThenReconnects(t *testing.T) {
	transport := syntheticTransport()
	transport.online = false
	_, _, host := boundHost(transport, nil)
	ctx := context.Background()
	if _, err := host.CallTool(ctx, "bfb_request_human", attentionParams(map[string]any{"request_id": "attention-off-001"})); CodeOf(err) != "offline_rejected" {
		t.Fatalf("offline request must fail visibly, got %v", err)
	}
	if _, err := host.CallTool(ctx, "bfb_get_attention", map[string]any{"attention_id": "attention-1", "request_id": "attention-off-002"}); CodeOf(err) != "offline_rejected" {
		t.Fatalf("offline read must fail visibly, got %v", err)
	}
	if _, err := host.CallTool(ctx, "bfb_wait_for_attention", map[string]any{"attention_id": "attention-1", "request_id": "attention-off-003"}); CodeOf(err) != "offline_rejected" {
		t.Fatalf("offline wait must fail visibly, got %v", err)
	}
	transport.online = true
	created, err := host.CallTool(ctx, "bfb_request_human", attentionParams(map[string]any{"request_id": "attention-off-004"}))
	if err != nil {
		t.Fatalf("reconnected request failed: %v", err)
	}
	id := created.(AttentionRecord).ID
	transport.answerAttention(id, "Synthetic post-reconnect answer")
	outcome, err := host.CallTool(ctx, "bfb_wait_for_attention", map[string]any{"attention_id": id, "request_id": "attention-off-005"})
	if err != nil {
		t.Fatalf("reconnected wait failed: %v", err)
	}
	if outcome.(map[string]any)["status"] != "answered" {
		t.Fatalf("reconnected waiter missed the answer: %+v", outcome)
	}
}

func TestAttentionRevocationClosesCapability(t *testing.T) {
	transport := syntheticTransport()
	_, authority, host := boundHost(transport, nil)
	authority.state = AuthorityState{Revoked: true}
	if _, err := host.CallTool(context.Background(), "bfb_request_human", attentionParams(nil)); CodeOf(err) != "revoked" {
		t.Fatalf("revoked request must fail closed, got %v", err)
	}
	if _, err := host.CallTool(context.Background(), "bfb_get_attention", map[string]any{"attention_id": "attention-1", "request_id": "attention-get-010"}); CodeOf(err) != "capability_closed" {
		t.Fatalf("closure must stick, got %v", err)
	}
}
