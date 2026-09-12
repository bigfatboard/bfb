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
	"invalid_request":               {"schema_invalid", "The local request is invalid.", 2},
	"unknown_method":                {"unknown_kind", "This local operation is not registered.", 2},
	"peer_denied":                   {"authorization_denied", "The local process is not authorized.", 3},
	"unsafe_state":                  {"authorization_denied", "BFB state must be private, owned by this user, and not symlinked.", 3},
	"daemon_offline":                {"unavailable", "The local daemon is not available.", 4},
	"app_unavailable":               {"unavailable", "The signed BFB app is not available in the interactive login session.", 4},
	"app_delivery_unknown":          {"unavailable", "The app did not acknowledge delivery. Reconcile the local intent before retrying.", 4},
	"session_locked":                {"unavailable", "Unlock this Mac before opening an interactive session.", 4},
	"consent_denied":                {"authorization_denied", "Allow BFB to control Terminal in macOS Automation settings.", 3},
	"notification_denied":           {"authorization_denied", "Allow BFB notifications in macOS settings.", 3},
	"expired_intent":                {"conflict", "This local app delivery or Terminal intent has expired.", 6},
	"containment_unknown":           {"conflict", "Process containment is not verified. Keep this checkout blocked until explicit local recovery proves absence.", 6},
	"execution_signal_failed":       {"operation_failed", "The verified provider group could not be signalled.", 5},
	"execution_terminal_lost":       {"unavailable", "The owned terminal is unavailable; its foreground was not changed.", 4},
	"not_implemented":               {"unavailable", "This capability is not implemented yet.", 4},
	"platform_unavailable":          {"unavailable", "This operation requires macOS.", 4},
	"storage_failed":                {"operation_failed", "Local storage could not be opened or verified; existing data was preserved.", 5},
	"migration_mismatch":            {"operation_failed", "Local migrations do not match this binary; existing data was preserved.", 5},
	"internal_error":                {"operation_failed", "The local operation failed.", 5},
	"log_failed":                    {"operation_failed", "The local diagnostic log is unavailable.", 5},
	"install_failed":                {"operation_failed", "The per-user daemon could not be installed.", 5},
	"already_running":               {"conflict", "A daemon already owns this local state directory.", 6},
	"install_conflict":              {"conflict", "A different daemon installation already exists; it was not overwritten.", 6},
	"checkout_not_found":            {"unavailable", "This checkout is not linked.", 4},
	"checkout_occupied":             {"conflict", "A local execution still owns this physical worktree.", 6},
	"checkout_path_missing":         {"unavailable", "The registered checkout directory is missing.", 4},
	"checkout_path_unsafe":          {"authorization_denied", "The checkout path or policy file is unsafe.", 3},
	"checkout_git_unavailable":      {"unavailable", "Read-only Git inspection could not complete.", 4},
	"checkout_not_worktree":         {"authorization_denied", "The selected directory is not inside a Git working tree.", 3},
	"checkout_identity_changed":     {"conflict", "The registered filesystem or Git identity has changed; relink explicitly after inspection.", 6},
	"checkout_repository_mismatch":  {"conflict", "The checkout does not match the bound repository.", 6},
	"checkout_subpath_mismatch":     {"conflict", "The checkout does not match the bound project subdirectory.", 6},
	"checkout_already_linked":       {"conflict", "This physical worktree is already linked on this Mac.", 6},
	"checkout_default_conflict":     {"conflict", "This project already has a default checkout on this runner.", 6},
	"checkout_config_invalid":       {"authorization_denied", "Repository policy must contain only supported non-secret restrictions.", 3},
	"checkout_config_changed":       {"conflict", "Repository policy changed; obtain a replacement specification and final authorization.", 6},
	"checkout_policy_widening":      {"authorization_denied", "Repository policy cannot widen its parent policy.", 3},
	"provider_manifest_invalid":     {"schema_invalid", "The packaged provider descriptor is invalid.", 2},
	"provider_config_invalid":       {"schema_invalid", "The provider configuration is not supported.", 2},
	"provider_path_unsafe":          {"authorization_denied", "The provider executable or configuration path is unsafe.", 3},
	"provider_capability_denied":    {"authorization_denied", "A required provider capability is not authorized and verified.", 3},
	"provider_discussion_unsafe":    {"authorization_denied", "The discussion does not have a verified read-only boundary.", 3},
	"provider_session_invalid":      {"authorization_denied", "Continuation requires an explicit owned session binding.", 3},
	"provider_probe_invalid":        {"authorization_denied", "The provider probe is not valid for this registry.", 3},
	"provider_unavailable":          {"unavailable", "The provider is not installed or registered.", 4},
	"provider_unsupported":          {"unavailable", "This provider version or integration is not certified for the requested behavior.", 4},
	"provider_probe_failed":         {"operation_failed", "The bounded provider inspection failed.", 5},
	"provider_event_invalid":        {"schema_invalid", "The provider event exceeds its semantic contract.", 2},
	"provider_changed":              {"conflict", "The provider executable, version, integration or configuration changed; probe again.", 6},
	"provider_probe_expired":        {"conflict", "The provider probe expired; probe again before launching.", 6},
	"provider_setup_denied":         {"authorization_denied", "Setup requires approval of the exact BFB-owned diff.", 3},
	"provider_setup_conflict":       {"conflict", "Provider configuration changed or a recovery is pending; existing data was preserved.", 6},
	"provider_setup_failed":         {"operation_failed", "Provider setup or verification failed; inspect the bounded recovery status.", 5},
	"runner_credential_unavailable": {"unavailable", "The signed daemon cannot access this runner's Keychain item. Unlock the login Keychain and verify the daemon signature.", 4},
	"runner_authorization_required": {"authorization_denied", "This runner requires current browser approval or a renewed workspace grant.", 3},
	"runner_revoked":                {"authorization_denied", "This workspace runner enrollment is revoked. It cannot reconnect.", 3},
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
