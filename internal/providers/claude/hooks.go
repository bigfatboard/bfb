// ABOUTME: Parses Claude Code raw hook payloads into bounded L03 semantic candidates.
// ABOUTME: Never copies prompt text or unknown fields; Stop is telemetry, not a result.

package claude

import (
	"crypto/sha256"
	"encoding/hex"
	"slices"

	"github.com/qdis/bfb/internal/provider"
)

// mappedEvents are hook events with a BFB semantic candidate.
var mappedEvents = []string{"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure", "SessionEnd"}

// ignoredEvents are documented hook events with no BFB semantic candidate on
// the tested version. Vendor-native permission dialogs stay separate from BFB
// attention; compaction, subagents, tasks, and notifications are telemetry the
// ledger does not consume.
var ignoredEvents = []string{
	"Setup", "InstructionsLoaded", "UserPromptExpansion", "MessageDisplay",
	"PermissionRequest", "PostToolBatch", "PermissionDenied", "Notification",
	"SubagentStart", "SubagentStop", "TaskCreated", "TaskCompleted",
	"TeammateIdle", "PreCompact", "PostCompact", "Elicitation", "ElicitationResult",
	"PreModelSwitch", "PostModelSwitch", "ConfigChange", "CwdChanged",
	"DirectoryAdded", "FileChanged", "WorktreeCreate", "WorktreeRemove",
}

// sessionSources are the documented SessionStart sources. Forked sessions
// reported "resume" before 2.1.214; the tested version reports "fork".
var sessionSources = []string{"startup", "resume", "clear", "compact", "fork"}

// sessionEndReasons are the documented SessionEnd reasons. The
// bypass_permissions_disabled value was removed in 2.1.234 and now fails as
// drift instead of silently mapping.
var sessionEndReasons = []string{"clear", "resume", "logout", "prompt_input_exit", "other"}

type rawHook struct {
	SessionID   string `json:"session_id"`
	HookEvent   string `json:"hook_event_name"`
	Source      string `json:"source"`
	Reason      string `json:"reason"`
	ToolName    string `json:"tool_name"`
	ToolUseID   string `json:"tool_use_id"`
	PromptID    string `json:"prompt_id"`
	IsInterrupt bool   `json:"is_interrupt"`
}

// sourceEventID derives a stable duplicate-suppression identity from the exact
// raw bytes. Byte-identical redeliveries share it; distinct deliveries differ.
// L06 owns sequencing and persistence; this only makes duplicates diagnosable.
func sourceEventID(raw []byte) string {
	sum := sha256.Sum256(raw)
	return "claude-" + hex.EncodeToString(sum[:])[:32]
}

// ParseHook converts one raw Claude hook payload into the bounded semantic
// candidate L06 journals. Unknown events fail closed; documented but unmapped
// events return nil; prompt text, tool input/output, and transcript paths are
// never copied into the candidate.
func ParseHook(raw []byte) (*provider.Candidate, error) {
	if len(raw) == 0 || len(raw) > provider.MaxHookBytes {
		return nil, provider.Failure("provider_event_invalid")
	}
	var hook rawHook
	if err := provider.DecodeJSON(raw, &hook); err != nil {
		return nil, provider.Failure("provider_event_invalid")
	}
	if hook.SessionID == "" || hook.HookEvent == "" {
		return nil, provider.Failure("provider_event_invalid")
	}
	if !slices.Contains(mappedEvents, hook.HookEvent) {
		if slices.Contains(ignoredEvents, hook.HookEvent) {
			return nil, nil
		}
		return nil, provider.Failure("provider_event_invalid")
	}
	candidate := &provider.Candidate{SessionID: hook.SessionID, SourceEventID: sourceEventID(raw)}
	switch hook.HookEvent {
	case "SessionStart":
		if !slices.Contains(sessionSources, hook.Source) {
			return nil, provider.Failure("provider_event_invalid")
		}
		candidate.Kind = "session_started"
	case "UserPromptSubmit":
		candidate.Kind = "turn_started"
		candidate.TurnID = hook.PromptID
	case "PreToolUse":
		if hook.ToolName == "" {
			return nil, provider.Failure("provider_event_invalid")
		}
		candidate.Kind = "tool_started"
		candidate.Tool = hook.ToolName
		candidate.TurnID = hook.ToolUseID
	case "PostToolUse":
		if hook.ToolName == "" {
			return nil, provider.Failure("provider_event_invalid")
		}
		candidate.Kind = "tool_completed"
		candidate.Tool = hook.ToolName
		candidate.TurnID = hook.ToolUseID
		candidate.Outcome = "succeeded"
	case "PostToolUseFailure":
		if hook.ToolName == "" {
			return nil, provider.Failure("provider_event_invalid")
		}
		candidate.Tool = hook.ToolName
		candidate.TurnID = hook.ToolUseID
		if hook.IsInterrupt {
			candidate.Kind = "interrupted"
		} else {
			candidate.Kind = "tool_completed"
			candidate.Outcome = "failed"
		}
	case "Stop":
		// A stopped turn is telemetry. It never submits or accepts a run
		// result; only explicit BFB submit commands do that.
		candidate.Kind = "turn_completed"
		candidate.TurnID = hook.PromptID
	case "StopFailure":
		candidate.Kind = "provider_error"
	case "SessionEnd":
		if !slices.Contains(sessionEndReasons, hook.Reason) {
			return nil, provider.Failure("provider_event_invalid")
		}
		candidate.Kind = "session_ended"
	}
	if err := candidate.Validate(); err != nil {
		return nil, err
	}
	return candidate, nil
}
