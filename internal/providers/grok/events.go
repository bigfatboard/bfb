// ABOUTME: Normalizes documented Grok hook payloads into bounded semantic candidates.
// ABOUTME: Drops local paths and tool payloads; stop and exit never become result submission.

package grok

import (
	"github.com/qdis/bfb/internal/provider"
)

// hookPayload selects the documented Grok hook stdin fields BFB correlates.
// Event names and keys are camelCase per the hooks reference: hookEventName,
// sessionId, cwd, workspaceRoot, toolName, toolInput. cwd, workspaceRoot, and
// toolInput may carry local paths or prompts and are never forwarded.
type hookPayload struct {
	EventName string `json:"hookEventName"`
	SessionID string `json:"sessionId"`
	ToolName  string `json:"toolName"`
}

func validIdentity(value string) bool {
	if value == "" {
		return false
	}
	candidate := provider.Candidate{Kind: "usage", SessionID: value}
	return candidate.Validate() == nil
}

func sessionCandidate(kind, session string) (*provider.Candidate, error) {
	if !validIdentity(session) {
		return nil, provider.Failure("provider_event_invalid")
	}
	return &provider.Candidate{Kind: kind, SessionID: session}, nil
}

// NormalizeHook parses one Grok hook stdin payload into a bounded semantic
// candidate. SessionStart binds the documented session ID; compact and clear
// have no Grok counterpart, so every documented start binds. Unknown event
// names are ignored for forward compatibility; known events with drifted
// identity values fail closed so L06 sees a typed rejection instead of a
// misbound session. No hook, stop, or exit kind can submit or accept a
// result: the candidate vocabulary has no result kind by construction.
func (Adapter) NormalizeHook(raw []byte) (*provider.Candidate, error) {
	var payload hookPayload
	if len(raw) > provider.MaxHookBytes || provider.DecodeJSON(raw, &payload) != nil {
		return nil, provider.Failure("provider_event_invalid")
	}
	switch payload.EventName {
	case "SessionStart":
		return sessionCandidate("session_started", payload.SessionID)
	case "SessionEnd":
		return sessionCandidate("session_ended", payload.SessionID)
	case "UserPromptSubmit":
		return sessionCandidate("turn_started", payload.SessionID)
	case "Stop":
		return sessionCandidate("turn_completed", payload.SessionID)
	case "StopFailure":
		return sessionCandidate("provider_error", payload.SessionID)
	case "PreToolUse":
		return toolCandidate("tool_started", payload, "")
	case "PostToolUse":
		return toolCandidate("tool_completed", payload, "")
	case "PostToolUseFailure":
		return toolCandidate("tool_completed", payload, "failed")
	case "PermissionDenied", "Notification", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact":
		return nil, nil
	default:
		return nil, nil
	}
}

// toolCandidate keeps the tool event even when the tool name falls outside
// the bounded identity alphabet (user MCP servers choose those names).
// Correlation keys stay strict; the auxiliary tool field degrades to absent.
// Tool input and response payloads are never selected into the struct, so
// prompts and local paths cannot cross into the candidate.
func toolCandidate(kind string, payload hookPayload, outcome string) (*provider.Candidate, error) {
	candidate, err := sessionCandidate(kind, payload.SessionID)
	if err != nil {
		return nil, err
	}
	if validIdentity(payload.ToolName) {
		candidate.Tool = payload.ToolName
	}
	if outcome != "" {
		candidate.Outcome = outcome
	}
	return candidate, nil
}

// NormalizeTurn has no supported headless event surface while Turn is
// unsupported. Usage stays unavailable; the adapter never estimates tokens.
func (Adapter) NormalizeTurn([]byte) (*provider.TurnEvent, error) { return nil, nil }
