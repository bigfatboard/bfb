// ABOUTME: Proves local response shape, cache input binding and sticky current-authority denials.
// ABOUTME: Keeps bounded connection-cache behavior independent of the native Worker integration fixture.

package localmcp

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
)

func TestAuthoritySnakeCaseFlags(t *testing.T) {
	var state AuthorityState
	if err := json.Unmarshal([]byte(`{"revoked":true,"execution_ended":true,"result_terminal":true}`), &state); err != nil {
		t.Fatal(err)
	}
	if !state.Revoked || !state.ExecutionEnded || !state.ResultTerminal {
		t.Fatal("wire authority flags lost", state)
	}
}

func TestOnlineOperationDenialsRemainTypedAndTerminalTransportDenialsClose(t *testing.T) {
	for _, code := range []string{"invalid_argument", "child_limit", "stale_version", "session_conflict", "policy_rejected", "assignment_ended", "revoked", "capability_closed"} {
		t.Run(code, func(t *testing.T) {
			bindings, authority := &fakeBindings{}, &fakeAuthority{}
			capability := NewCapability(syntheticBoundary, bindings, authority)
			bindings.setBound(syntheticSession, capability.ref())
			transport := syntheticTransport()
			transport.failCode = code
			host := NewHost(HostDeps{Capability: capability, Transport: transport})
			if _, err := host.CallTool(context.Background(), "bfb_add_comment", map[string]any{"body": "Synthetic denied comment", "request_id": "transport-denial-001"}); CodeOf(err) != code {
				t.Fatal("transport denial lost", err)
			}
			terminal := code == "assignment_ended" || code == "revoked" || code == "capability_closed"
			if (capability.State() == StateClosed) != terminal {
				t.Fatal("operation-local and terminal denial confused", capability.State())
			}
			if numeric, _ := jsonRPCCode(code); numeric == -32603 {
				t.Fatal("typed operation denial presented as an internal failure")
			}
		})
	}
}

func TestCacheKeepsInputBindingAfterFailedRequestSaturation(t *testing.T) {
	authority := &fakeAuthority{}
	host := NewHost(HostDeps{Capability: NewCapability(syntheticBoundary, &fakeBindings{}, authority), Transport: syntheticTransport()})
	ctx := context.Background()
	for index := 0; index < 256; index++ {
		_, err := host.CallTool(ctx, "bfb_get_task", map[string]any{"task_id": "foreign", "request_id": fmt.Sprintf("failure-%04d", index)})
		if CodeOf(err) != "boundary_escape" {
			t.Fatal(err)
		}
	}
	params := map[string]any{"request_id": "cache-saturated"}
	if _, err := host.CallTool(ctx, "bfb_get_task", params); err != nil {
		t.Fatal(err)
	}
	if _, err := host.CallTool(ctx, "bfb_get_context", params); CodeOf(err) != "request_rejected" {
		t.Fatal("tool reuse lost binding", err)
	}
	params["task_id"] = syntheticBoundary.TaskID
	if _, err := host.CallTool(ctx, "bfb_get_task", params); CodeOf(err) != "request_rejected" {
		t.Fatal("payload reuse lost binding", err)
	}
}

func TestCacheRejectsUnseenIdentityAfterSuccessfulRequestSaturation(t *testing.T) {
	authority := &fakeAuthority{}
	bindings := &fakeBindings{}
	capability := NewCapability(syntheticBoundary, bindings, authority)
	bindings.setBound(syntheticSession, capability.ref())
	transport := syntheticTransport()
	host := NewHost(HostDeps{Capability: capability, Transport: transport})
	ctx := context.Background()
	for index := 0; index < maxCachedRequests; index++ {
		params := map[string]any{"body": "Synthetic comment", "request_id": fmt.Sprintf("success-%04d", index)}
		if _, err := host.CallTool(ctx, "bfb_add_comment", params); err != nil {
			t.Fatal(err)
		}
	}
	for _, attempt := range []struct {
		tool   string
		params map[string]any
	}{
		{"bfb_get_task", map[string]any{"request_id": "success-overflow"}},
		{"bfb_get_context", map[string]any{"request_id": "success-overflow"}},
		{"bfb_get_task", map[string]any{"task_id": syntheticBoundary.TaskID, "request_id": "success-overflow"}},
		{"bfb_add_comment", map[string]any{"body": "Changed synthetic comment", "request_id": "success-overflow"}},
	} {
		if _, err := host.CallTool(ctx, attempt.tool, attempt.params); CodeOf(err) != "request_rejected" {
			t.Fatal("unbound overflow request executed", attempt.tool, err)
		}
	}
	if len(host.seen) != maxCachedRequests || len(transport.commented) != maxCachedRequests {
		t.Fatal("overflow changed cache or business effects")
	}
	cached := map[string]any{"body": "Synthetic comment", "request_id": "success-0000"}
	if _, err := host.CallTool(ctx, "bfb_add_comment", cached); err != nil || len(transport.commented) != maxCachedRequests {
		t.Fatal("full cache lost an existing authorized outcome", err)
	}
	cached["body"] = "Changed synthetic comment"
	if _, err := host.CallTool(ctx, "bfb_add_comment", cached); CodeOf(err) != "request_rejected" {
		t.Fatal("full cache lost existing input binding", err)
	}
	cached["body"] = "Synthetic comment"
	authority.err = fail("revoked")
	if _, err := host.CallTool(ctx, "bfb_add_comment", cached); CodeOf(err) != "revoked" || capability.State() != StateClosed {
		t.Fatal("full cache bypassed current authority", err)
	}
}

func TestCachedReadRechecksTypedAuthorityDenials(t *testing.T) {
	for _, code := range []string{"revoked", "assignment_ended", "capability_closed"} {
		t.Run(code, func(t *testing.T) {
			authority := &fakeAuthority{}
			capability := NewCapability(syntheticBoundary, &fakeBindings{}, authority)
			host := NewHost(HostDeps{Capability: capability, Transport: syntheticTransport()})
			params := map[string]any{"request_id": "cached-read-001"}
			if _, err := host.CallTool(context.Background(), "bfb_get_context", params); err != nil {
				t.Fatal(err)
			}
			authority.err = fail(code)
			if _, err := host.CallTool(context.Background(), "bfb_get_context", params); CodeOf(err) != code || capability.State() != StateClosed {
				t.Fatal("cached reply skipped authority", err)
			}
			authority.err = nil
			if _, err := host.CallTool(context.Background(), "bfb_get_context", params); CodeOf(err) != "capability_closed" {
				t.Fatal("closure reopened", err)
			}
		})
	}
}

func TestTransientAuthorityDoesNotCloseOrQueue(t *testing.T) {
	authority := &fakeAuthority{err: fail("offline_rejected")}
	capability := NewCapability(syntheticBoundary, &fakeBindings{}, authority)
	host := NewHost(HostDeps{Capability: capability, Transport: syntheticTransport()})
	params := map[string]any{"request_id": "transient-read-1"}
	if _, err := host.CallTool(context.Background(), "bfb_get_task", params); CodeOf(err) != "offline_rejected" || capability.State() == StateClosed {
		t.Fatal(err)
	}
	authority.err = nil
	if _, err := host.CallTool(context.Background(), "bfb_get_task", params); err != nil {
		t.Fatal("transient denial closed valid capability", err)
	}
}

func TestRequestIDMatchesWirePrimitive(t *testing.T) {
	for _, value := range []string{"abcdefgh", "._:~-abc", "ascii-key-01"} {
		if checkRequestID(value) != nil {
			t.Fatal("valid ASCII request rejected", value)
		}
	}
	for _, value := range []string{"unicode-é", "spaces key", "newline\n", "short"} {
		if CodeOf(checkRequestID(value)) != "invalid_request" {
			t.Fatal("invalid request accepted", value)
		}
	}
}
