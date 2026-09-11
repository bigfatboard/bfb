// ABOUTME: Defines bounded local-operation failures without exposing underlying private data.
// ABOUTME: Maps daemon errors to canonical wire diagnostics and stable CLI exit codes.

package daemon

import (
	"errors"

	"github.com/qdis/bfb/internal/protocol/generated"
)

type Failure struct{ Code string }

var failures = map[string]struct {
	category, message string
	exit              int
}{
	"invalid_request":      {"schema_invalid", "The local request is invalid.", 2},
	"unknown_method":       {"unknown_kind", "This local operation is not registered.", 2},
	"peer_denied":          {"authorization_denied", "The local process is not authorized.", 3},
	"unsafe_state":         {"authorization_denied", "BFB state must be private, owned by this user, and not symlinked.", 3},
	"daemon_offline":       {"unavailable", "The local daemon is not available.", 4},
	"not_implemented":      {"unavailable", "This capability is not implemented yet.", 4},
	"platform_unavailable": {"unavailable", "This operation requires macOS.", 4},
	"storage_failed":       {"operation_failed", "Local storage could not be opened or verified; existing data was preserved.", 5},
	"migration_mismatch":   {"operation_failed", "Local migrations do not match this binary; existing data was preserved.", 5},
	"internal_error":       {"operation_failed", "The local operation failed.", 5},
	"log_failed":           {"operation_failed", "The local diagnostic log is unavailable.", 5},
	"install_failed":       {"operation_failed", "The per-user daemon could not be installed.", 5},
	"already_running":      {"conflict", "A daemon already owns this local state directory.", 6},
	"install_conflict":     {"conflict", "A different daemon installation already exists; it was not overwritten.", 6},
}

func (f *Failure) Error() string { return f.Diagnostic().Message }

func (f *Failure) Diagnostic() *generated.TypedError {
	entry, ok := failures[f.Code]
	code := f.Code
	if !ok {
		entry, code = failures["internal_error"], "internal_error"
	}
	return &generated.TypedError{SchemaVersion: 1, Category: entry.category, Code: code, Message: entry.message}
}

func AsFailure(err error) *Failure {
	var failure *Failure
	if errors.As(err, &failure) {
		return failure
	}
	return &Failure{Code: "internal_error"}
}

func ExitCode(err error) int {
	if err == nil {
		return 0
	}
	return failures[AsFailure(err).Diagnostic().Code].exit
}
