// ABOUTME: Certifies raw Claude hook payloads map to bounded semantic candidates.
// ABOUTME: Proves Stop never submits a result and unknown events fail closed.

package claude_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/providers/claude"
)

const hookSession = "11111111-1111-4111-8111-111111111111"

func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil || daemon.AsFailure(err).Diagnostic().Code != code {
		t.Fatalf("want %s, got %v", code, err)
	}
}

func TestHookFixtures(t *testing.T) {
	fixtures := []struct {
		file    string
		kind    string
		session string
		turn    string
		tool    string
		outcome string
		wantNil bool
		wantErr string
	}{
		{file: "hook-sessionstart-startup.json", kind: "session_started", session: hookSession},
		{file: "hook-sessionstart-resume.json", kind: "session_started", session: hookSession},
		{file: "hook-sessionstart-fork.json", kind: "session_started", session: hookSession},
		{file: "hook-sessionstart-clear.json", kind: "session_started", session: hookSession},
		{file: "hook-sessionstart-compact.json", kind: "session_started", session: hookSession},
		{file: "hook-userpromptsubmit.json", kind: "turn_started", session: hookSession, turn: "22222222-2222-4222-8222-222222222222"},
		{file: "hook-pretooluse-bash.json", kind: "tool_started", session: hookSession, turn: "toolu_01ABC123DEF456", tool: "Bash"},
		{file: "hook-posttooluse-write.json", kind: "tool_completed", session: hookSession, turn: "toolu_01ABC123DEF456", tool: "Write", outcome: "succeeded"},
		{file: "hook-posttoolusefailure-bash.json", kind: "tool_completed", session: hookSession, turn: "toolu_01ABC123DEF456", tool: "Bash", outcome: "failed"},
		{file: "hook-posttoolusefailure-interrupt.json", kind: "interrupted", session: hookSession, turn: "toolu_01ABC123DEF456", tool: "Bash"},
		{file: "hook-stop.json", kind: "turn_completed", session: hookSession},
		{file: "hook-stopfailure.json", kind: "provider_error", session: hookSession},
		{file: "hook-sessionend-other.json", kind: "session_ended", session: hookSession},
		{file: "hook-sessionend-resume.json", kind: "session_ended", session: hookSession},
		{file: "hook-notification-idle.json", wantNil: true},
		{file: "hook-unknown-future.json", wantErr: "provider_event_invalid"},
		{file: "hook-sessionstart-bad-source.json", wantErr: "provider_event_invalid"},
		{file: "hook-sessionend-removed-reason.json", wantErr: "provider_event_invalid"},
		{file: "hook-missing-session.json", wantErr: "provider_event_invalid"},
		{file: "hook-duplicate-keys.json", wantErr: "provider_event_invalid"},
		{file: "hook-pretooluse-bad-tool.json", wantErr: "provider_event_invalid"},
	}
	for _, fixture := range fixtures {
		t.Run(fixture.file, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join("testdata", fixture.file))
			if err != nil {
				t.Fatal(err)
			}
			candidate, err := claude.ParseHook(raw)
			if fixture.wantErr != "" {
				requireCode(t, err, fixture.wantErr)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if fixture.wantNil {
				if candidate != nil {
					t.Fatal("documented unmapped event produced a candidate")
				}
				return
			}
			if candidate == nil {
				t.Fatal("missing candidate")
			}
			if candidate.Kind != fixture.kind || candidate.SessionID != fixture.session || candidate.TurnID != fixture.turn || candidate.Tool != fixture.tool || candidate.Outcome != fixture.outcome {
				t.Fatalf("got %+v", candidate)
			}
			if candidate.SourceEventID == "" {
				t.Fatal("missing duplicate-suppression identity")
			}
			if err := candidate.Validate(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestHookDuplicatePayloadsShareIdentity(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "hook-stop.json"))
	if err != nil {
		t.Fatal(err)
	}
	first, err := claude.ParseHook(raw)
	if err != nil {
		t.Fatal(err)
	}
	second, err := claude.ParseHook(raw)
	if err != nil {
		t.Fatal(err)
	}
	if first.SourceEventID != second.SourceEventID {
		t.Fatal("identical deliveries must share one suppression identity")
	}
	other, err := os.ReadFile(filepath.Join("testdata", "hook-sessionend-other.json"))
	if err != nil {
		t.Fatal(err)
	}
	third, err := claude.ParseHook(other)
	if err != nil {
		t.Fatal(err)
	}
	if first.SourceEventID == third.SourceEventID {
		t.Fatal("distinct deliveries must not share a suppression identity")
	}
}

func TestHookBoundsAndLeakage(t *testing.T) {
	if _, err := claude.ParseHook(nil); err == nil {
		t.Fatal("empty input accepted")
	}
	huge := make([]byte, 65*1024)
	for index := range huge {
		huge[index] = 'x'
	}
	requireCode(t, mustParseErr(huge), "provider_event_invalid")
	raw, err := os.ReadFile(filepath.Join("testdata", "hook-posttooluse-write.json"))
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := claude.ParseHook(raw)
	if err != nil {
		t.Fatal(err)
	}
	encoded := candidate.Kind + candidate.SessionID + candidate.TurnID + candidate.Tool + candidate.Outcome + candidate.SourceEventID
	for _, leaked := range []string{"redacted", "transcript", "checkout", "content", "filePath"} {
		if strings.Contains(encoded, leaked) {
			t.Fatalf("provider payload leaked into candidate: %s", leaked)
		}
	}
}

func mustParseErr(raw []byte) error {
	_, err := claude.ParseHook(raw)
	return err
}

func TestHookStopNeverSubmits(t *testing.T) {
	for _, file := range []string{"hook-stop.json", "hook-stopfailure.json", "hook-posttoolusefailure-bash.json", "hook-sessionend-other.json"} {
		raw, err := os.ReadFile(filepath.Join("testdata", file))
		if err != nil {
			t.Fatal(err)
		}
		candidate, err := claude.ParseHook(raw)
		if err != nil || candidate == nil {
			t.Fatal(file, err)
		}
		// The candidate type carries no result-submission field; assert the
		// mapped kinds stay within telemetry.
		switch candidate.Kind {
		case "turn_completed", "provider_error", "tool_completed", "session_ended":
		default:
			t.Fatalf("%s mapped to %s", file, candidate.Kind)
		}
	}
}
