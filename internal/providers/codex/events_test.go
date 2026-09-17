// ABOUTME: Certifies Codex hook and exec-JSONL normalization against documented shapes.
// ABOUTME: Proves stop never submits results and usage stays provider-reported with fixtures.

package codex_test

import (
	"strings"
	"testing"

	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers/codex"
)

func hookCase(event, session, extra string) string {
	body := `"hook_event_name":"` + event + `","session_id":"` + session + `"`
	if extra != "" {
		body += "," + extra
	}
	return "{" + body + `,"transcript_path":"/private/tmp/synthetic/rollout.jsonl","cwd":"/tmp/synthetic","model":"gpt-5.6-sol"}`
}

func TestSessionStartBindsOnlyFreshAndResumed(t *testing.T) {
	adapter := codex.Adapter{}
	for _, source := range []string{"startup", "resume"} {
		candidate, err := adapter.NormalizeHook([]byte(hookCase("SessionStart", "thr_synthetic0199a21381c0", `"source":"`+source+`"`)))
		if err != nil {
			t.Fatal(err)
		}
		if candidate == nil || candidate.Kind != "session_started" || candidate.SessionID != "thr_synthetic0199a21381c0" {
			t.Fatalf("source %s must bind the documented session: %+v", source, candidate)
		}
		if candidate.TurnID != "" {
			t.Fatal("bootstrap context must not mark a turn started")
		}
	}
	for _, source := range []string{"compact", "clear"} {
		candidate, err := adapter.NormalizeHook([]byte(hookCase("SessionStart", "thr_synthetic0199a21381c0", `"source":"`+source+`"`)))
		if err != nil || candidate != nil {
			t.Fatalf("source %s must not bind: %+v %v", source, candidate, err)
		}
	}
	for _, raw := range []string{
		hookCase("SessionStart", "thr_synthetic0199a21381c0", `"source":"time-travel"`),
		hookCase("SessionStart", "thr_synthetic0199a21381c0", ""),
		hookCase("SessionStart", "not a session!!", `"source":"startup"`),
		hookCase("SessionStart", "", `"source":"startup"`),
	} {
		if _, err := adapter.NormalizeHook([]byte(raw)); err == nil {
			t.Fatalf("drifted SessionStart must fail closed: %s", raw)
		}
	}
}

func TestLifecycleKinds(t *testing.T) {
	adapter := codex.Adapter{}
	session := "thr_synthetic0199a21381c0"
	turn := "trk_synthetic07ab44"
	stop, err := adapter.NormalizeHook([]byte(hookCase("Stop", session, `"turn_id":"`+turn+`","stop_hook_active":false`)))
	if err != nil {
		t.Fatal(err)
	}
	if stop.Kind != "turn_completed" || stop.SessionID != session || stop.TurnID != turn {
		t.Fatalf("stop must complete the turn: %+v", stop)
	}
	ended, err := adapter.NormalizeHook([]byte(hookCase("SessionEnd", session, `"reason":"other"`)))
	if err != nil {
		t.Fatal(err)
	}
	if ended.Kind != "session_ended" || ended.SessionID != session {
		t.Fatalf("session end mistranslated: %+v", ended)
	}
	interrupted, err := adapter.NormalizeHook([]byte(hookCase("Interrupt", session, `"turn_id":"`+turn+`","permission_mode":"default"`)))
	if err != nil {
		t.Fatal(err)
	}
	if interrupted.Kind != "interrupted" || interrupted.TurnID != turn {
		t.Fatalf("interrupt mistranslated: %+v", interrupted)
	}
	started, err := adapter.NormalizeHook([]byte(hookCase("UserPromptSubmit", session, `"turn_id":"`+turn+`","prompt":"synthetic"`)))
	if err != nil {
		t.Fatal(err)
	}
	if started.Kind != "turn_started" || started.SessionID != session {
		t.Fatalf("prompt submit must open a turn: %+v", started)
	}
	pre, err := adapter.NormalizeHook([]byte(hookCase("PreToolUse", session, `"turn_id":"`+turn+`","tool_name":"Bash","tool_use_id":"call_synthetic01","tool_input":{"command":"echo synthetic"}`)))
	if err != nil {
		t.Fatal(err)
	}
	if pre.Kind != "tool_started" || pre.Tool != "Bash" || pre.SourceEventID != "call_synthetic01" || pre.TurnID != turn {
		t.Fatalf("tool start mistranslated: %+v", pre)
	}
	post, err := adapter.NormalizeHook([]byte(hookCase("PostToolUse", session, `"turn_id":"`+turn+`","tool_name":"mcp__bfb__bfb_get_context","tool_use_id":"call_synthetic02","tool_response":{"ok":true}`)))
	if err != nil {
		t.Fatal(err)
	}
	if post.Kind != "tool_completed" || post.Tool != "mcp__bfb__bfb_get_context" || post.Outcome != "" {
		t.Fatalf("tool completion mistranslated: %+v", post)
	}
	for _, event := range []string{"PermissionRequest", "PreCompact", "PostCompact", "SubagentStart", "SubagentStop", "FutureEvent"} {
		candidate, err := adapter.NormalizeHook([]byte(hookCase(event, session, `"turn_id":"`+turn+`"`)))
		if err != nil || candidate != nil {
			t.Fatalf("%s must stay silent: %+v %v", event, candidate, err)
		}
	}
}

func TestToolIdentityDegradesWithoutDropping(t *testing.T) {
	adapter := codex.Adapter{}
	candidate, err := adapter.NormalizeHook([]byte(hookCase("PreToolUse", "thr_synthetic0199a21381c0", `"tool_name":"my tool!","tool_use_id":"id/with/slashes"`)))
	if err != nil {
		t.Fatal(err)
	}
	if candidate == nil || candidate.Kind != "tool_started" || candidate.Tool != "" || candidate.SourceEventID != "" {
		t.Fatalf("unrepresentable tool names must degrade to an unnamed event: %+v", candidate)
	}
}

func TestHookRejectsMalformedPayloads(t *testing.T) {
	adapter := codex.Adapter{}
	payloads := []string{
		"",
		"not json",
		`{"hook_event_name":"Stop","hook_event_name":"Stop","session_id":"x"}`,
		`{"hook_event_name":"Stop"}`,
		hookCase("Stop", "thr_synthetic0199a21381c0", `"turn_id":"bad turn!!"`),
		hookCase("SessionEnd", "thr_synthetic0199a21381c0", `"reason":"evicted"`),
		strings.Repeat("x", provider.MaxHookBytes+1),
	}
	for _, raw := range payloads {
		if _, err := adapter.NormalizeHook([]byte(raw)); err == nil {
			t.Fatalf("malformed hook must fail: %q", raw)
		}
	}
}

func TestDuplicateHookDeliveryIsIdempotent(t *testing.T) {
	adapter := codex.Adapter{}
	raw := []byte(hookCase("PostToolUse", "thr_synthetic0199a21381c0", `"turn_id":"trk_synthetic07ab44","tool_name":"Bash","tool_use_id":"call_synthetic03"`))
	first, err := adapter.NormalizeHook(raw)
	if err != nil {
		t.Fatal(err)
	}
	second, err := adapter.NormalizeHook(raw)
	if err != nil {
		t.Fatal(err)
	}
	if *first != *second {
		t.Fatal("concurrent duplicate hooks must normalize identically")
	}
}

func TestExecStreamBindsSessionAndUsage(t *testing.T) {
	stream := new(codex.Stream)
	session := "0199a213-81c0-7000-8aa1-bbab2a035a53"
	event, usage, err := stream.Parse([]byte(`{"type":"thread.started","thread_id":"` + session + `"}`))
	if err != nil || usage != nil || event.Kind != "session_observed" || event.SessionID != session {
		t.Fatalf("thread start must bind: %+v %+v %v", event, usage, err)
	}
	if stream.Session() != session {
		t.Fatal("stream must remember the observed thread")
	}
	event, _, err = stream.Parse([]byte(`{"type":"turn.started"}`))
	if err != nil || event.Kind != "turn_started" || event.SessionID != session {
		t.Fatalf("turn must inherit the observed session: %+v %v", event, err)
	}
	event, _, err = stream.Parse([]byte(`{"type":"item.completed","item":{"type":"agent_message","text":"synthetic reply"}}`))
	if err != nil || event.Kind != "message" || event.Text != "synthetic reply" || event.SessionID != session {
		t.Fatalf("agent message mistranslated: %+v %v", event, err)
	}
	event, usage, err = stream.Parse([]byte(`{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":100,"output_tokens":34,"reasoning_output_tokens":5}}`))
	if err != nil || event.Kind != "turn_completed" || usage == nil {
		t.Fatalf("turn completion must carry usage: %+v %+v %v", event, usage, err)
	}
	if usage.Kind != "usage" || *usage.InputTokens != 120 || *usage.OutputTokens != 34 || usage.SessionID != session {
		t.Fatalf("usage must stay provider-reported: %+v", usage)
	}
}

func TestExecCompletionWithoutUsageInventsNothing(t *testing.T) {
	stream := new(codex.Stream)
	if _, _, err := stream.Parse([]byte(`{"type":"thread.started","thread_id":"0199a213-81c0-7000-8aa1-bbab2a035a53"}`)); err != nil {
		t.Fatal(err)
	}
	event, usage, err := stream.Parse([]byte(`{"type":"turn.completed"}`))
	if err != nil || event.Kind != "turn_completed" || usage != nil {
		t.Fatalf("absent usage must stay absent: %+v %+v %v", event, usage, err)
	}
}

func TestExecFailuresAndNoise(t *testing.T) {
	stream := new(codex.Stream)
	if _, _, err := stream.Parse([]byte(`{"type":"thread.started","thread_id":"0199a213-81c0-7000-8aa1-bbab2a035a53"}`)); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{
		``,
		`   `,
		`starting worker (diagnostic noise)`,
		`{"type":"turn.started","other":"noise"}`,
		`{"type":"item.completed","item":{"type":"function_call","name":"Bash"}}`,
		`{"type":"mcp.bridge","servers":[]}`,
	} {
		event, usage, err := stream.Parse([]byte(raw))
		if err != nil || usage != nil {
			t.Fatalf("noise must not fail or mint usage: %q %v", raw, err)
		}
		if raw == `{"type":"turn.started","other":"noise"}` && (event == nil || event.Kind != "turn_started") {
			t.Fatal("session attribution must survive after thread start")
		}
	}
	failed, _, err := stream.Parse([]byte(`{"type":"turn.failed"}`))
	if err != nil || failed.Kind != "turn_failed" {
		t.Fatalf("failed turn mistranslated: %+v %v", failed, err)
	}
	errored, _, err := stream.Parse([]byte(`{"type":"error","message":"synthetic"}`))
	if err != nil || errored.Kind != "turn_failed" {
		t.Fatalf("error mistranslated: %+v %v", errored, err)
	}
	flagged, _, err := stream.Parse([]byte(`{"type":"result","result":"synthetic","is_error":true}`))
	if err != nil || flagged.Kind != "turn_failed" {
		t.Fatalf("error result must fail the turn: %+v %v", flagged, err)
	}
	assistant, _, err := stream.Parse([]byte(`{"type":"assistant","message":{"content":[{"type":"text","text":"a"},{"type":"image","url":"x"},{"type":"text","text":"b"}]}}`))
	if err != nil || assistant.Kind != "message" || assistant.Text != "a\nb" {
		t.Fatalf("assistant text mistranslated: %+v %v", assistant, err)
	}
}

func TestExecRejectsCorruptShapes(t *testing.T) {
	stream := new(codex.Stream)
	payloads := []string{
		`{"type":"turn.completed","usage":{"input_tokens":-1,"output_tokens":2}}`,
		`{"type":"turn.completed","usage":{"input_tokens":9007199254740992,"output_tokens":2}}`,
		`{"type":"turn.completed","usage":{"input_tokens":1.5,"output_tokens":2}}`,
		`{"type":"turn.completed","usage":{"output_tokens":2}}`,
		`{"type":"turn.completed","usage":{"input_tokens":1}}`,
		`{"type":"thread.started"}`,
		`{"type":"thread.started","thread_id":"bad id!!"}`,
		`{"type":"turn.completed","thread_id":"0199a213-81c0-7000-8aa1-bbab2a035a53","usage":{"input_tokens":1,"output_tokens":1},"usage":{"input_tokens":1,"output_tokens":1}}`,
		strings.Repeat("x", provider.MaxHookBytes+1),
	}
	for _, raw := range payloads {
		if _, _, err := stream.Parse([]byte(raw)); err == nil {
			t.Fatalf("corrupt line must fail: %q", raw)
		}
	}
	bare, err := codex.Adapter{}.NormalizeTurn([]byte(`{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}`))
	if err == nil || bare != nil {
		t.Fatal("stateless turns without an observed session must fail closed")
	}
	observed, err := codex.Adapter{}.NormalizeTurn([]byte(`{"type":"thread.started","thread_id":"0199a213-81c0-7000-8aa1-bbab2a035a53"}`))
	if err != nil || observed.Kind != "session_observed" {
		t.Fatalf("self-contained thread start must parse: %+v %v", observed, err)
	}
}

func TestNoCompletionKindExists(t *testing.T) {
	stream := new(codex.Stream)
	lines := []string{
		`{"type":"thread.started","thread_id":"0199a213-81c0-7000-8aa1-bbab2a035a53"}`,
		`{"type":"turn.started"}`,
		`{"type":"item.completed","item":{"type":"agent_message","text":"done"}}`,
		`{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":1}}`,
	}
	allowedEvents := map[string]bool{"session_observed": true, "turn_started": true, "message": true, "turn_completed": true, "turn_failed": true}
	allowedCandidates := map[string]bool{"session_started": true, "turn_started": true, "turn_completed": true, "tool_started": true, "tool_completed": true, "interrupted": true, "session_ended": true, "provider_error": true, "usage": true}
	for _, line := range lines {
		event, usage, err := stream.Parse([]byte(line))
		if err != nil {
			t.Fatal(err)
		}
		if !allowedEvents[event.Kind] {
			t.Fatalf("unexpected turn kind: %s", event.Kind)
		}
		if usage != nil && !allowedCandidates[usage.Kind] {
			t.Fatalf("unexpected candidate kind: %s", usage.Kind)
		}
	}
	adapter := codex.Adapter{}
	for _, raw := range []string{
		hookCase("Stop", "thr_synthetic0199a21381c0", ""),
		hookCase("SessionEnd", "thr_synthetic0199a21381c0", ""),
	} {
		candidate, err := adapter.NormalizeHook([]byte(raw))
		if err != nil {
			t.Fatal(err)
		}
		if !allowedCandidates[candidate.Kind] {
			t.Fatalf("unexpected hook kind: %s", candidate.Kind)
		}
	}
}
