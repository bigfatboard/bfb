// ABOUTME: Certifies Grok hook normalization against the documented hook shapes.
// ABOUTME: Proves stop never submits results and usage stays unavailable with fixtures.

package grok_test

import (
	"strings"
	"testing"

	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers/grok"
)

const grokSession = "123e4567-e89b-12d3-a456-426614174000"

func hookCase(event, session, extra string) string {
	body := `"hookEventName":"` + event + `","sessionId":"` + session + `"`
	if extra != "" {
		body += "," + extra
	}
	return "{" + body + `,"cwd":"/tmp/synthetic","workspaceRoot":"/tmp/synthetic"}`
}

func TestSessionStartBindsDocumentedSession(t *testing.T) {
	adapter := grok.Adapter{}
	candidate, err := adapter.NormalizeHook([]byte(hookCase("SessionStart", grokSession, "")))
	if err != nil {
		t.Fatal(err)
	}
	if candidate == nil || candidate.Kind != "session_started" || candidate.SessionID != grokSession {
		t.Fatalf("SessionStart must bind the documented session: %+v", candidate)
	}
	if candidate.TurnID != "" {
		t.Fatal("session binding must not mark a turn started")
	}
	for _, raw := range []string{
		hookCase("SessionStart", "not a session!!", ""),
		hookCase("SessionStart", "", ""),
		`{"hookEventName":"SessionStart"}`,
	} {
		if _, err := adapter.NormalizeHook([]byte(raw)); err == nil {
			t.Fatalf("drifted SessionStart must fail closed: %s", raw)
		}
	}
	// A payload with no documented event name stays silent like any unknown
	// future event. A known event with an undocumented session key fails
	// closed above: the kit never binds a session it cannot name.
	for _, raw := range []string{
		`{"hook_event_name":"SessionStart","session_id":"` + grokSession + `"}`,
		`{"unknown":"event"}`,
	} {
		candidate, err := adapter.NormalizeHook([]byte(raw))
		if err != nil || candidate != nil {
			t.Fatalf("undocumented shape must stay silent: %s", raw)
		}
	}
	if _, err := adapter.NormalizeHook([]byte(`{"hookEventName":"SessionStart","session_id":"` + grokSession + `"}`)); err == nil {
		t.Fatal("known event with an undocumented session key must fail closed")
	}
}

func TestLifecycleKinds(t *testing.T) {
	adapter := grok.Adapter{}
	ended, err := adapter.NormalizeHook([]byte(hookCase("SessionEnd", grokSession, "")))
	if err != nil {
		t.Fatal(err)
	}
	if ended.Kind != "session_ended" || ended.SessionID != grokSession {
		t.Fatalf("session end mistranslated: %+v", ended)
	}
	started, err := adapter.NormalizeHook([]byte(hookCase("UserPromptSubmit", grokSession, "")))
	if err != nil {
		t.Fatal(err)
	}
	if started.Kind != "turn_started" || started.SessionID != grokSession {
		t.Fatalf("prompt submit must open a turn: %+v", started)
	}
	stop, err := adapter.NormalizeHook([]byte(hookCase("Stop", grokSession, "")))
	if err != nil {
		t.Fatal(err)
	}
	if stop.Kind != "turn_completed" || stop.SessionID != grokSession {
		t.Fatalf("stop must complete the turn: %+v", stop)
	}
	failed, err := adapter.NormalizeHook([]byte(hookCase("StopFailure", grokSession, "")))
	if err != nil {
		t.Fatal(err)
	}
	if failed.Kind != "provider_error" || failed.SessionID != grokSession {
		t.Fatalf("failed stop must stay provider telemetry: %+v", failed)
	}
	pre, err := adapter.NormalizeHook([]byte(hookCase("PreToolUse", grokSession, `"toolName":"Bash","toolInput":{"command":"echo synthetic"}`)))
	if err != nil {
		t.Fatal(err)
	}
	if pre.Kind != "tool_started" || pre.Tool != "Bash" {
		t.Fatalf("tool start mistranslated: %+v", pre)
	}
	post, err := adapter.NormalizeHook([]byte(hookCase("PostToolUse", grokSession, `"toolName":"Read","toolInput":{"path":"synthetic"}`)))
	if err != nil {
		t.Fatal(err)
	}
	if post.Kind != "tool_completed" || post.Tool != "Read" || post.Outcome != "" {
		t.Fatalf("tool completion mistranslated: %+v", post)
	}
	toolFailed, err := adapter.NormalizeHook([]byte(hookCase("PostToolUseFailure", grokSession, `"toolName":"Bash"`)))
	if err != nil {
		t.Fatal(err)
	}
	if toolFailed.Kind != "tool_completed" || toolFailed.Outcome != "failed" {
		t.Fatalf("tool failure must stay telemetry with a failed outcome: %+v", toolFailed)
	}
	for _, event := range []string{"PermissionDenied", "Notification", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact", "FutureEvent"} {
		candidate, err := adapter.NormalizeHook([]byte(hookCase(event, grokSession, "")))
		if err != nil || candidate != nil {
			t.Fatalf("%s must stay silent: %+v %v", event, candidate, err)
		}
	}
}

func TestToolIdentityDegradesWithoutDropping(t *testing.T) {
	adapter := grok.Adapter{}
	candidate, err := adapter.NormalizeHook([]byte(hookCase("PreToolUse", grokSession, `"toolName":"my tool!"`)))
	if err != nil {
		t.Fatal(err)
	}
	if candidate == nil || candidate.Kind != "tool_started" || candidate.Tool != "" {
		t.Fatalf("unrepresentable tool names must degrade to an unnamed event: %+v", candidate)
	}
}

func TestToolPayloadsNeverCross(t *testing.T) {
	adapter := grok.Adapter{}
	candidate, err := adapter.NormalizeHook([]byte(hookCase("PreToolUse", grokSession, `"toolName":"Bash","toolInput":{"command":"echo secret-canary"},"transcript":"/private/secret-canary"`)))
	if err != nil {
		t.Fatal(err)
	}
	encoded := candidate.SessionID + candidate.TurnID + candidate.SourceEventID + candidate.Tool + candidate.Kind
	if strings.Contains(encoded, "secret-canary") {
		t.Fatal("tool payloads and local paths crossed into the candidate")
	}
}

func TestHookRejectsMalformedPayloads(t *testing.T) {
	adapter := grok.Adapter{}
	for _, raw := range []string{
		`{"hookEventName":"Stop","sessionId":"` + grokSession + `","sessionId":"duplicate"}`,
		`{"hookEventName":"Stop","sessionId":` + "\x00" + `}`,
		hookCase("Stop", grokSession, "") + hookCase("Stop", grokSession, ""),
		`[not json`,
		``,
	} {
		if _, err := adapter.NormalizeHook([]byte(raw)); err == nil {
			t.Fatalf("malformed payload must fail closed: %q", raw)
		}
	}
	if _, err := adapter.NormalizeHook(make([]byte, provider.MaxHookBytes+1)); err == nil {
		t.Fatal("oversize payload must fail closed")
	}
}

func TestNoCandidateSubmitsOrEstimates(t *testing.T) {
	adapter := grok.Adapter{}
	corpus := []string{
		hookCase("SessionStart", grokSession, ""),
		hookCase("SessionEnd", grokSession, ""),
		hookCase("UserPromptSubmit", grokSession, ""),
		hookCase("Stop", grokSession, ""),
		hookCase("StopFailure", grokSession, ""),
		hookCase("PreToolUse", grokSession, `"toolName":"Bash"`),
		hookCase("PostToolUse", grokSession, `"toolName":"Bash"`),
		hookCase("PostToolUseFailure", grokSession, `"toolName":"Bash"`),
	}
	for _, raw := range corpus {
		candidate, err := adapter.NormalizeHook([]byte(raw))
		if err != nil {
			t.Fatal(err)
		}
		if candidate == nil {
			t.Fatal("documented event produced no candidate")
		}
		switch candidate.Kind {
		case "result_submitted", "attention_requested", "task_completed", "usage":
			t.Fatalf("telemetry became business state or invented usage: %+v", candidate)
		}
		if candidate.InputTokens != nil || candidate.OutputTokens != nil {
			t.Fatalf("usage must stay unavailable, never estimated: %+v", candidate)
		}
		if err := candidate.Validate(); err != nil {
			t.Fatalf("candidate failed kit validation: %v", err)
		}
	}
}
