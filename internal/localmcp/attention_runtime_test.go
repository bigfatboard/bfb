// ABOUTME: Proves fresh attention reads, input-only retry binding and complete client wait deadlines.
// ABOUTME: Keeps authority denials visible without private outcome caching or offline journal effects.

package localmcp

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"
)

type attentionRuntimeTransport struct {
	*fakeTransport
	reads  atomic.Int32
	writes atomic.Int32
	get    func(context.Context, Boundary, *ConfirmedSession, string, string) (AttentionRecord, error)
}

func (*attentionRuntimeTransport) attentionReadAuthorizes() {}
func (*attentionRuntimeTransport) admitAgentWork(context.Context, Boundary, ConfirmedSession, string, map[string]any, string) (any, error) {
	return nil, fail("not_implemented")
}
func (transport *attentionRuntimeTransport) GetAttention(ctx context.Context, boundary Boundary, binding *ConfirmedSession, attentionID, requestID string) (AttentionRecord, error) {
	transport.reads.Add(1)
	if transport.get != nil {
		return transport.get(ctx, boundary, binding, attentionID, requestID)
	}
	return transport.fakeTransport.GetAttention(ctx, boundary, binding, attentionID, requestID)
}
func (transport *attentionRuntimeTransport) RequestAttention(ctx context.Context, boundary Boundary, binding ConfirmedSession, input AttentionRequest, requestID string) (AttentionRecord, error) {
	transport.writes.Add(1)
	return transport.fakeTransport.RequestAttention(ctx, boundary, binding, input, requestID)
}

func attentionRuntimeHost() (*Host, *fakeAuthority, *attentionRuntimeTransport) {
	bindings, authority := &fakeBindings{}, &fakeAuthority{}
	capability := NewCapability(syntheticBoundary, bindings, authority)
	bindings.setBound(syntheticSession, capability.ref())
	transport := &attentionRuntimeTransport{fakeTransport: syntheticTransport()}
	return NewHost(HostDeps{Capability: capability, Transport: transport}), authority, transport
}

func TestAttentionRuntimeRetriesBindNormalizedInputWithoutMemoizingPrivateResults(t *testing.T) {
	host, _, transport := attentionRuntimeHost()
	params := attentionParams(map[string]any{"question": "  Synthetic question  ", "reference_kind": "  artifact_version  ", "reference_id": "  synthetic-version  "})
	first, err := host.CallTool(context.Background(), "bfb_request_human", params)
	if err != nil {
		t.Fatal(err)
	}
	params["question"], params["reference_kind"], params["reference_id"] = "Synthetic question", "artifact_version", "synthetic-version"
	second, err := host.CallTool(context.Background(), "bfb_request_human", params)
	if err != nil || first.(AttentionRecord).ID != second.(AttentionRecord).ID || transport.writes.Load() != 2 {
		t.Fatal("exact normalized retry did not reach current transport", first, second, err)
	}
	if host.seen["attention-req-001"].result != nil {
		t.Fatal("private question memoized")
	}
	params["blocking"] = false
	if _, err := host.CallTool(context.Background(), "bfb_request_human", params); CodeOf(err) != "request_rejected" || transport.writes.Load() != 2 {
		t.Fatal("changed original input reached effect", err)
	}
	if _, err := host.CallTool(context.Background(), "bfb_submit_result", map[string]any{"summary": "Synthetic", "request_id": "held-a03-001"}); CodeOf(err) != "not_implemented" {
		t.Fatal("attention lane enabled held results", err)
	}
}

func TestAttentionRuntimeRepeatedGetSeesAnswerAndResolution(t *testing.T) {
	host, _, transport := attentionRuntimeHost()
	created, err := host.CallTool(context.Background(), "bfb_request_human", attentionParams(nil))
	if err != nil {
		t.Fatal(err)
	}
	id := created.(AttentionRecord).ID
	params := map[string]any{"attention_id": id, "request_id": "fresh-attention-001"}
	first, err := host.CallTool(context.Background(), "bfb_get_attention", params)
	if err != nil || first.(AttentionRecord).State != "open" {
		t.Fatal(first, err)
	}
	transport.answerAttention(id, "Synthetic private answer")
	second, err := host.CallTool(context.Background(), "bfb_get_attention", params)
	if err != nil || second.(AttentionRecord).State != "answered" || second.(AttentionRecord).Answer != "Synthetic private answer" {
		t.Fatal("same identity returned stale open read", second, err)
	}
	transport.mutex.Lock()
	transport.attention[id].State = "resolved"
	transport.attention[id].ResolvedAt = syntheticTime.Add(time.Second).Format(time.RFC3339Nano)
	transport.attention[id].ResourceVersion++
	transport.mutex.Unlock()
	third, err := host.CallTool(context.Background(), "bfb_get_attention", params)
	if err != nil || third.(AttentionRecord).State != "resolved" || third.(AttentionRecord).Answer != second.(AttentionRecord).Answer || transport.reads.Load() != 3 {
		t.Fatal("same identity hid committed resolution", third, err)
	}
	if host.seen["fresh-attention-001"].result != nil {
		t.Fatal("private answer memoized")
	}
}

func TestAttentionRuntimeFixedGetOwnsFreshAuthorityAndPreservesBindingState(t *testing.T) {
	for _, activated := range []bool{false, true} {
		t.Run(map[bool]string{false: "provisional", true: "activated"}[activated], func(t *testing.T) {
			host, authority, transport := attentionRuntimeHost()
			if activated {
				if err := host.capability.allowWrite(context.Background()); err != nil {
					t.Fatal(err)
				}
			}
			authority.err = fail("internal_error") // A redundant authority call would fail this test.
			transport.get = func(_ context.Context, _ Boundary, binding *ConfirmedSession, id, requestID string) (AttentionRecord, error) {
				if (binding != nil) != activated || requestID != "authority-read-001" {
					return AttentionRecord{}, fail("session_conflict")
				}
				if activated && *binding != host.capability.ConfirmedSession() {
					return AttentionRecord{}, fail("session_conflict")
				}
				if transport.reads.Load() == 1 {
					return AttentionRecord{ID: id, State: "open"}, nil
				}
				return AttentionRecord{}, fail("revoked")
			}
			params := map[string]any{"attention_id": "synthetic-attention", "request_id": "authority-read-001"}
			if _, err := host.CallTool(context.Background(), "bfb_get_attention", params); err != nil {
				t.Fatal("fixed get made a redundant authority call", err)
			}
			if !activated && host.capability.State() != StateProvisional {
				t.Fatal("read created session binding")
			}
			if _, err := host.CallTool(context.Background(), "bfb_get_attention", params); CodeOf(err) != "revoked" || host.capability.State() != StateClosed {
				t.Fatal("repeat read hid current denial", err)
			}
			if _, err := host.CallTool(context.Background(), "bfb_get_attention", params); CodeOf(err) != "capability_closed" || transport.reads.Load() != 2 {
				t.Fatal("terminal denial reopened", err)
			}
		})
	}
}

func TestAttentionRuntimeWaitCoversNetworkAndRejectsLatePrivateAnswer(t *testing.T) {
	for _, outcome := range []string{"late-answer", "deadline-offline", "deadline-denial", "live-outage"} {
		t.Run(outcome, func(t *testing.T) {
			host, _, transport := attentionRuntimeHost()
			transport.get = func(ctx context.Context, _ Boundary, _ *ConfirmedSession, id, _ string) (AttentionRecord, error) {
				deadline, bounded := ctx.Deadline()
				if !bounded || time.Until(deadline) > attentionWaitTimeout {
					return AttentionRecord{}, fail("request_rejected")
				}
				if outcome == "live-outage" {
					return AttentionRecord{}, fail("offline_rejected")
				}
				<-ctx.Done()
				if outcome == "deadline-denial" {
					return AttentionRecord{}, fail("revoked")
				}
				if outcome == "deadline-offline" {
					return AttentionRecord{}, fail("offline_rejected")
				}
				return AttentionRecord{ID: id, State: "answered", Answer: "Synthetic late private answer"}, nil
			}
			ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
			defer cancel()
			start := time.Now()
			result, err := host.CallTool(ctx, "bfb_wait_for_attention", map[string]any{"attention_id": "synthetic-attention", "request_id": "complete-wait-001"})
			if time.Since(start) > time.Second {
				t.Fatal("network escaped complete wait budget")
			}
			switch outcome {
			case "deadline-denial":
				if CodeOf(err) != "revoked" || result != nil || host.capability.State() != StateClosed {
					t.Fatal("deadline hid real authority denial", result, err)
				}
			case "live-outage":
				if CodeOf(err) != "offline_rejected" || result != nil {
					t.Fatal("live channel loss became pending", result, err)
				}
			default:
				if err != nil || result.(map[string]any)["status"] != "pending" || len(result.(map[string]any)) != 1 || host.seen["complete-wait-001"].result != nil {
					t.Fatal("late private answer delivered or pending memoized", result, err)
				}
			}
		})
	}
}

func TestAttentionRuntimeWaitRechecksEveryPollAtBoundedCadence(t *testing.T) {
	host, _, transport := attentionRuntimeHost()
	var first time.Time
	transport.get = func(_ context.Context, _ Boundary, _ *ConfirmedSession, id, _ string) (AttentionRecord, error) {
		if transport.reads.Load() == 1 {
			first = time.Now()
			return AttentionRecord{ID: id, State: "open"}, nil
		}
		if time.Since(first) < 950*time.Millisecond {
			return AttentionRecord{}, fail("request_rejected")
		}
		return AttentionRecord{}, fail("revoked")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if result, err := host.CallTool(ctx, "bfb_wait_for_attention", map[string]any{"attention_id": "synthetic-attention", "request_id": "poll-authority-001"}); CodeOf(err) != "revoked" || result != nil || transport.reads.Load() != 2 {
		t.Fatal("poll reused authorization or exceeded one-second cadence", result, err, transport.reads.Load())
	}
}

func TestAttentionRuntimeQueuedWaitDeadlineDoesNotRetainInvalidIdentity(t *testing.T) {
	host, _, transport := attentionRuntimeHost()
	host.callSeat <- struct{}{}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	result, err := host.CallTool(ctx, "bfb_wait_for_attention", map[string]any{"attention_id": "", "request_id": "invalid"})
	<-host.callSeat
	if err != nil || result.(map[string]any)["status"] != "pending" || len(host.seen) != 0 || transport.reads.Load() != 0 {
		t.Fatal("queued expiry admitted invalid input or escaped budget", result, err)
	}
}

func TestAttentionRuntimeBoundedInputMapNeverRetainsPrivateBodies(t *testing.T) {
	host, _, transport := attentionRuntimeHost()
	transport.get = func(_ context.Context, _ Boundary, _ *ConfirmedSession, id, _ string) (AttentionRecord, error) {
		return AttentionRecord{ID: id, State: "answered", Answer: "Synthetic private answer"}, nil
	}
	for index := 0; index < maxCachedRequests; index++ {
		if _, err := host.CallTool(context.Background(), "bfb_get_attention", map[string]any{"attention_id": "synthetic-attention", "request_id": fmt.Sprintf("bounded-read-%04d", index)}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := host.CallTool(context.Background(), "bfb_get_attention", map[string]any{"attention_id": "synthetic-attention", "request_id": "bounded-overflow"}); CodeOf(err) != "request_rejected" || transport.reads.Load() != maxCachedRequests {
		t.Fatal("unbound overflow read was delivered", err)
	}
	for _, entry := range host.seen {
		if entry.result != nil {
			t.Fatal("private body retained in bounded input map")
		}
	}
	if _, err := host.CallTool(context.Background(), "bfb_get_attention", map[string]any{"attention_id": "synthetic-attention", "request_id": "bounded-read-0000"}); err != nil || transport.reads.Load() != maxCachedRequests+1 {
		t.Fatal("full map suppressed existing fresh read", err)
	}
}
