// ABOUTME: Freezes the human CLI JSON envelope and exit-code taxonomy.
// ABOUTME: Server diagnostics map to stable exits without leaking credentials.

package humancli

import (
	"encoding/json"
	"fmt"
	"io"
)

// SchemaVersion is the frozen human envelope version consumed by golden fixtures.
const SchemaVersion = 1

// ClientVersion is the CLI release train checked against /api/v1/cli/version.
const ClientVersion = "0.1.0"

// WireProtocol is the frozen wire family the client speaks.
const WireProtocol = "bfb-wire/1"

// MinAPIVersion is the oldest server api_version this client mutates against.
const MinAPIVersion = "1"

// Error is a bounded machine-readable failure without secrets or raw bodies.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Failure carries a CLI error code through registry dispatch to the exit mapping.
type Failure struct {
	Code    string
	Message string
}

func (f *Failure) Error() string {
	if f.Message == "" {
		return f.Code
	}
	return f.Code + ": " + f.Message
}

// CLIExitCode reports the frozen process exit for this failure.
func (f *Failure) CLIExitCode() int {
	if f == nil {
		return 0
	}
	return ExitCode(f.Code)
}

// fail builds a redacted failure; callers must never pass secrets as message.
func fail(code, message string) *Failure { return &Failure{Code: code, Message: message} }

// ExitCode maps a frozen error code to its process exit. Unknown codes fail
// closed as operational errors, never as success.
func ExitCode(code string) int {
	switch code {
	case "":
		return 0
	case "invalid_request", "unknown_method", "invalid_json", "body_too_large", "invalid_argument":
		return 2
	case "unauthenticated", "forbidden", "credential_confusion", "credential_missing",
		"step_up_invalid", "step_up_stale", "step_up_mismatch", "step_up_replayed",
		"step_up_unauthenticated", "peer_denied", "unsafe_state":
		return 3
	case "control_unreachable", "version_mismatch", "daemon_offline", "offline":
		return 4
	case "stale_version", "already_answered", "already_exists", "conflict", "expired_intent":
		return 6
	default:
		return 5
	}
}

// Response is the frozen machine envelope printed on standard output in JSON mode.
type Response struct {
	SchemaVersion int            `json:"schema_version"`
	Command       string         `json:"command"`
	RequestID     string         `json:"request_id"`
	APIVersion    string         `json:"api_version,omitempty"`
	Data          map[string]any `json:"data,omitempty"`
	Error         *Error         `json:"error,omitempty"`
}

// Render writes exactly one JSON document to output; diagnostics stay on stderr.
func (r Response) Render(output io.Writer) error {
	data, err := json.Marshal(r)
	if err != nil {
		return fail("internal_error", "the local operation failed")
	}
	_, err = fmt.Fprintf(output, "%s\n", data)
	return err
}
