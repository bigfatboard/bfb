// ABOUTME: Normalizes Codex hook payloads and exec JSONL into bounded semantic candidates.
// ABOUTME: Drops local paths and peer text; stop and exit never become result submission.

package codex

import (
	"bytes"
	"encoding/json"
	"strings"

	"github.com/qdis/bfb/internal/provider"
)

// hookPayload selects the documented Codex stdin fields BFB correlates.
// transcript_path and cwd are local paths and are never forwarded; tool
// input and response may carry prompts and are never forwarded either.
type hookPayload struct {
	SessionID string `json:"session_id"`
	EventName string `json:"hook_event_name"`
	Source    string `json:"source"`
	Reason    string `json:"reason"`
	TurnID    string `json:"turn_id"`
	ToolName  string `json:"tool_name"`
	ToolUseID string `json:"tool_use_id"`
}

func validIdentity(value string) bool {
	if value == "" {
		return false
	}
	candidate := provider.Candidate{Kind: "usage", SessionID: value}
	return candidate.Validate() == nil
}

// NormalizeHook parses one Codex hook stdin payload into a bounded semantic
// candidate. Unknown event names are ignored for forward compatibility; known
// events with drifted identity values fail closed so L06 sees a typed
// rejection instead of a misbound session.
func (Adapter) NormalizeHook(raw []byte) (*provider.Candidate, error) {
	var payload hookPayload
	if len(raw) > provider.MaxHookBytes || provider.DecodeJSON(raw, &payload) != nil {
		return nil, provider.Failure("provider_event_invalid")
	}
	switch payload.EventName {
	case "SessionStart":
		switch payload.Source {
		case "startup", "resume":
			if !validIdentity(payload.SessionID) {
				return nil, provider.Failure("provider_event_invalid")
			}
			return &provider.Candidate{Kind: "session_started", SessionID: payload.SessionID}, nil
		case "compact", "clear":
			return nil, nil
		default:
			return nil, provider.Failure("provider_event_invalid")
		}
	case "SessionEnd":
		if payload.Reason != "" && payload.Reason != "other" {
			return nil, provider.Failure("provider_event_invalid")
		}
		if !validIdentity(payload.SessionID) {
			return nil, provider.Failure("provider_event_invalid")
		}
		return &provider.Candidate{Kind: "session_ended", SessionID: payload.SessionID}, nil
	case "Stop":
		if !validIdentity(payload.SessionID) {
			return nil, provider.Failure("provider_event_invalid")
		}
		candidate := &provider.Candidate{Kind: "turn_completed", SessionID: payload.SessionID}
		if payload.TurnID != "" {
			if !validIdentity(payload.TurnID) {
				return nil, provider.Failure("provider_event_invalid")
			}
			candidate.TurnID = payload.TurnID
		}
		return candidate, nil
	case "SubagentStop":
		return nil, nil
	case "PreToolUse":
		return toolCandidate("tool_started", payload)
	case "PostToolUse":
		return toolCandidate("tool_completed", payload)
	case "Interrupt":
		if !validIdentity(payload.SessionID) {
			return nil, provider.Failure("provider_event_invalid")
		}
		candidate := &provider.Candidate{Kind: "interrupted", SessionID: payload.SessionID}
		if payload.TurnID != "" {
			if !validIdentity(payload.TurnID) {
				return nil, provider.Failure("provider_event_invalid")
			}
			candidate.TurnID = payload.TurnID
		}
		return candidate, nil
	case "UserPromptSubmit":
		if !validIdentity(payload.SessionID) {
			return nil, provider.Failure("provider_event_invalid")
		}
		candidate := &provider.Candidate{Kind: "turn_started", SessionID: payload.SessionID}
		if payload.TurnID != "" {
			if !validIdentity(payload.TurnID) {
				return nil, provider.Failure("provider_event_invalid")
			}
			candidate.TurnID = payload.TurnID
		}
		return candidate, nil
	case "PermissionRequest", "PreCompact", "PostCompact", "SubagentStart":
		return nil, nil
	default:
		return nil, nil
	}
}

// toolCandidate keeps the tool event even when the tool name or call ID falls
// outside the bounded identity alphabet (user MCP servers choose those
// names). Correlation keys stay strict; auxiliary fields degrade to absent.
func toolCandidate(kind string, payload hookPayload) (*provider.Candidate, error) {
	if !validIdentity(payload.SessionID) {
		return nil, provider.Failure("provider_event_invalid")
	}
	candidate := &provider.Candidate{Kind: kind, SessionID: payload.SessionID}
	if payload.TurnID != "" {
		if !validIdentity(payload.TurnID) {
			return nil, provider.Failure("provider_event_invalid")
		}
		candidate.TurnID = payload.TurnID
	}
	if validIdentity(payload.ToolName) {
		candidate.Tool = payload.ToolName
	}
	if validIdentity(payload.ToolUseID) {
		candidate.SourceEventID = payload.ToolUseID
	}
	return candidate, nil
}

type execUsage struct {
	Input     json.Number `json:"input_tokens"`
	Cached    json.Number `json:"cached_input_tokens"`
	Output    json.Number `json:"output_tokens"`
	Reasoning json.Number `json:"reasoning_output_tokens"`
}

type execItem struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type execContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type execMessage struct {
	Content []execContent `json:"content"`
}

// execLine covers the documented codex exec --json event shapes. Fields the
// 0.153.4 stream does not repeat on every line stay optional; Stream fills
// the session from the observed thread start.
type execLine struct {
	Type      string          `json:"type"`
	ThreadID  string          `json:"thread_id"`
	SessionID string          `json:"session_id"`
	TurnID    string          `json:"turn_id"`
	ID        string          `json:"id"`
	Usage     *execUsage      `json:"usage"`
	Item      *execItem       `json:"item"`
	Message   json.RawMessage `json:"message"`
	Result    *string         `json:"result"`
	IsError   *bool           `json:"is_error"`
}

// Stream feeds exec JSONL lines of one execution in order. It remembers the
// observed thread identity so turn lines that carry no session still bind to
// the exact observed session instead of a guessed one.
type Stream struct{ session string }

// Session reports the observed thread identity, if any.
func (stream *Stream) Session() string { return stream.session }

func tokenCount(value json.Number) (int64, error) {
	if value == "" {
		return 0, provider.Failure("provider_event_invalid")
	}
	count, err := value.Int64()
	if err != nil || count < 0 || count > 9007199254740991 {
		return 0, provider.Failure("provider_event_invalid")
	}
	return count, nil
}

func usageCandidate(session string, usage *execUsage) (*provider.Candidate, error) {
	if usage == nil {
		return nil, nil
	}
	input, err := tokenCount(usage.Input)
	if err != nil {
		return nil, err
	}
	output, err := tokenCount(usage.Output)
	if err != nil {
		return nil, err
	}
	candidate := &provider.Candidate{Kind: "usage", SessionID: session, InputTokens: &input, OutputTokens: &output}
	if err := candidate.Validate(); err != nil {
		return nil, err
	}
	return candidate, nil
}

func messageText(line execLine) string {
	if line.Item != nil && line.Item.Type == "agent_message" {
		return line.Item.Text
	}
	if len(line.Message) != 0 {
		var message execMessage
		if provider.DecodeJSON(line.Message, &message) != nil {
			return ""
		}
		parts := []string{}
		for _, part := range message.Content {
			if part.Type == "text" {
				parts = append(parts, part.Text)
			}
		}
		return strings.Join(parts, "\n")
	}
	if line.Result != nil {
		return *line.Result
	}
	return ""
}

// Parse feeds one exec --json line through the stream. Blank lines and
// non-JSON diagnostics are ignored like the L03 probe ignores them; corrupt
// shapes of documented events fail closed. Usage appears only from a
// provider turn.completed usage object, so a usage candidate is always
// provider-reported and never estimated or invented.
func (stream *Stream) Parse(raw []byte) (*provider.TurnEvent, *provider.Candidate, error) {
	if len(raw) > provider.MaxHookBytes || len(bytes.TrimSpace(raw)) == 0 {
		if len(raw) > provider.MaxHookBytes {
			return nil, nil, provider.Failure("provider_event_invalid")
		}
		return nil, nil, nil
	}
	trimmed := bytes.TrimSpace(raw)
	if !json.Valid(trimmed) {
		return nil, nil, nil
	}
	var line execLine
	if provider.DecodeJSON(trimmed, &line) != nil {
		return nil, nil, provider.Failure("provider_event_invalid")
	}
	session := line.ThreadID
	if session == "" {
		session = line.SessionID
	}
	if session == "" {
		session = stream.session
	}
	turn := line.TurnID
	if turn == "" && validIdentity(line.ID) && (line.Type == "turn.started" || line.Type == "turn.completed" || line.Type == "turn.failed") {
		turn = line.ID
	}
	switch line.Type {
	case "thread.started":
		if !validIdentity(session) {
			return nil, nil, provider.Failure("provider_event_invalid")
		}
		stream.session = session
		return &provider.TurnEvent{Kind: "session_observed", SessionID: session}, nil, nil
	case "turn.started":
		if !validIdentity(session) {
			return nil, nil, provider.Failure("provider_event_invalid")
		}
		event := &provider.TurnEvent{Kind: "turn_started", SessionID: session}
		if turn != "" {
			if !validIdentity(turn) {
				return nil, nil, provider.Failure("provider_event_invalid")
			}
			event.TurnID = turn
		}
		return event, nil, nil
	case "item.completed", "assistant", "result":
		if line.Item == nil && len(line.Message) == 0 && line.Result == nil {
			return nil, nil, nil
		}
		if line.Item != nil && line.Item.Type != "agent_message" {
			return nil, nil, nil
		}
		if !validIdentity(session) {
			return nil, nil, provider.Failure("provider_event_invalid")
		}
		if line.IsError != nil && *line.IsError {
			event := &provider.TurnEvent{Kind: "turn_failed", SessionID: session}
			if turn != "" {
				if !validIdentity(turn) {
					return nil, nil, provider.Failure("provider_event_invalid")
				}
				event.TurnID = turn
			}
			return event, nil, nil
		}
		text := messageText(line)
		if len(text) > provider.MaxTurnBytes {
			return nil, nil, provider.Failure("provider_event_invalid")
		}
		event := &provider.TurnEvent{Kind: "message", SessionID: session, Text: text}
		if turn != "" {
			if !validIdentity(turn) {
				return nil, nil, provider.Failure("provider_event_invalid")
			}
			event.TurnID = turn
		}
		return event, nil, nil
	case "turn.completed":
		if !validIdentity(session) {
			return nil, nil, provider.Failure("provider_event_invalid")
		}
		usage, err := usageCandidate(session, line.Usage)
		if err != nil {
			return nil, nil, err
		}
		event := &provider.TurnEvent{Kind: "turn_completed", SessionID: session}
		if turn != "" {
			if !validIdentity(turn) {
				return nil, nil, provider.Failure("provider_event_invalid")
			}
			event.TurnID = turn
		}
		return event, usage, nil
	case "turn.failed", "error":
		if !validIdentity(session) {
			return nil, nil, provider.Failure("provider_event_invalid")
		}
		event := &provider.TurnEvent{Kind: "turn_failed", SessionID: session}
		if turn != "" {
			if !validIdentity(turn) {
				return nil, nil, provider.Failure("provider_event_invalid")
			}
			event.TurnID = turn
		}
		return event, nil, nil
	default:
		return nil, nil, nil
	}
}

// ParseExecEvent parses one self-contained exec --json line without stream
// memory. Lines that need an observed session fail closed here; feed ordered
// lines through Stream instead.
func ParseExecEvent(raw []byte) (*provider.TurnEvent, *provider.Candidate, error) {
	return new(Stream).Parse(raw)
}

// NormalizeTurn implements the kit interface over self-contained lines. The
// daemon feeds ordered execution output through Stream to keep session
// attribution; usage candidates stay available through Parse and Stream.
func (Adapter) NormalizeTurn(raw []byte) (*provider.TurnEvent, error) {
	event, _, err := ParseExecEvent(raw)
	return event, err
}
