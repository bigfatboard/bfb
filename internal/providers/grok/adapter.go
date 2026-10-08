// ABOUTME: Maps bounded execution configuration to documented Grok 1.0.34 invocations.
// ABOUTME: Never selects titles, most-recent sessions, forks, or privilege flags outside the tested contract.

package grok

import (
	"context"
	"regexp"
	"slices"

	"github.com/qdis/bfb/internal/provider"
)

// TestedVersions lists the exact Grok releases this adapter certifies.
// Unknown versions receive no tracked capabilities from help text or habit.
var TestedVersions = []string{"1.0.34"}

// TestedModels lists the exact models exercised against the tested releases.
// Grok documents grok-4.6 for code; the adapter passes the model through and
// an unknown model fails visibly at runtime, never silently.
var TestedModels = []string{"grok-4.6"}

// ManifestVersion identifies this adapter's integration contract. Bump it
// whenever argv, hook, setup, or parsing behavior changes so recorded
// integration hashes stop matching across the change.
const ManifestVersion = "1.0.0"

// IntegrationID binds a local installation to this adapter contract. L05
// records it at probe time; any adapter change invalidates prior evidence.
func IntegrationID() string { return provider.Hash([]byte("bfb-grok-integration/1")) }

// Capabilities returns the tested capability set for Grok 1.0.34.
// Deliberately absent: prompt.initial_constant (positional-prompt auto-submit
// is unverified, so interactive launches wait for human submit),
// context.session_start (SessionStart documents no additional-context output
// that opens no turn), launch.headless (unattended -p executes tools under
// unverified approval/usage surfaces), discussion.read_only and
// turn.structured (headless JSON shapes need a live model call to verify),
// session.fork (no supported Turn path consumes it), and approval.always
// (Ask still honors remembered allows, so no always-prompt counterpart).
func Capabilities() []string {
	return []string{
		"launch.interactive",
		"filesystem.read_only",
		"filesystem.workspace_write",
		"approval.never",
		"approval.on_request",
		"session.requested_id",
		"session.resume",
		"session.resume.interactive",
		"hooks.session_start",
		"mcp.stdio",
		"control.interrupt",
		"control.terminate",
	}
}

// Adapter implements provider.Adapter for Grok without touching shared kit state.
type Adapter struct{}

// uuidPattern gates --session-id and --resume targets. Grok also matches
// non-ID values against session titles and resumes the most recent session on
// a bare flag; both could attach the wrong session, so the adapter requires
// the UUID shape and never emits --continue or a title.
var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// sandboxFlag maps BFB filesystem policy to the documented grok --sandbox
// profiles. read-only keeps writes to grok and temp paths for review;
// workspace permits writes under the verified working directory.
func sandboxFlag(policy string) (string, error) {
	switch policy {
	case "read_only":
		return "read-only", nil
	case "workspace_write":
		return "workspace", nil
	default:
		return "", provider.Failure("provider_config_invalid")
	}
}

// baseArguments maps the supported policy combination to documented global
// flags. approval never auto-approves tool executions via --always-approve;
// on_request keeps the default Ask mode with no flag. approval always has no
// counterpart and fails closed before argv exists.
func baseArguments(workingDirectory, filesystemPolicy, approvalPolicy, model, effort string) ([]string, error) {
	sandbox, err := sandboxFlag(filesystemPolicy)
	if err != nil {
		return nil, err
	}
	argv := []string{"--cwd", workingDirectory, "--sandbox", sandbox, "--model", model, "--reasoning-effort", effort}
	switch approvalPolicy {
	case "never":
		argv = append(argv, "--always-approve")
	case "on_request":
	default:
		return nil, provider.Failure("provider_config_invalid")
	}
	return argv, nil
}

// Launch plans an interactive TUI session in the verified checkout. It never
// carries an initial prompt: positional-prompt auto-submit is unverified, so
// every plan starts in waiting_user_submit and the human submits visibly.
// Any other initial-turn transport fails closed here as well as at the
// capability ceiling, so a direct adapter call cannot imply a started turn.
func (Adapter) Launch(input provider.LaunchInput) (provider.Invocation, error) {
	config := input.Config
	if config.Mode != "interactive" {
		return provider.Invocation{}, provider.Failure("provider_unsupported")
	}
	if config.InitialTurnTransport != "waiting_user_submit" {
		return provider.Invocation{}, provider.Failure("provider_config_invalid")
	}
	argv, err := baseArguments(input.WorkingDirectory, config.FilesystemPolicy, config.ApprovalPolicy, config.Model, config.Effort)
	if err != nil {
		return provider.Invocation{}, err
	}
	if input.RequestedSessionID != "" {
		if !uuidPattern.MatchString(input.RequestedSessionID) {
			return provider.Invocation{}, provider.Failure("provider_config_invalid")
		}
		argv = append(argv, "--session-id", input.RequestedSessionID)
	}
	return provider.Invocation{Arguments: argv}, nil
}

// Resume continues an exact owned interactive session. It never uses
// --continue (most-recent), a title match, or --fork-session; unknown targets
// fail visibly at runtime without a fresh-session fallback.
func (Adapter) Resume(input provider.ResumeInput) (provider.Invocation, error) {
	config := input.Config
	if config.Mode != "interactive" {
		return provider.Invocation{}, provider.Failure("provider_unsupported")
	}
	if !uuidPattern.MatchString(input.Session.ObservedID) {
		return provider.Invocation{}, provider.Failure("provider_session_invalid")
	}
	argv, err := baseArguments(input.WorkingDirectory, config.FilesystemPolicy, config.ApprovalPolicy, config.Model, config.Effort)
	if err != nil {
		return provider.Invocation{}, err
	}
	return provider.Invocation{Arguments: append(argv, "--resume", input.Session.ObservedID)}, nil
}

// Turn stays unsupported: headless -p output shapes need a live model call to
// verify, and usage has no documented event source. Fail closed instead of
// inventing a transport; usage stays unavailable, never estimated.
func (Adapter) Turn(provider.TurnInput) (provider.Invocation, error) {
	return provider.Invocation{}, provider.Failure("provider_unsupported")
}

// Interrupt requests cooperative cancellation; L05 verifies identity and signals.
func (Adapter) Interrupt() provider.Control { return provider.Interrupt }

// Terminate requests forced shutdown; L05 owns TERM/KILL escalation.
func (Adapter) Terminate() provider.Control { return provider.Terminate }

// Inspect reports runtime health from the BFB hooks integration. It echoes
// the installation hash when the tested version carries the BFB session
// binder; drifted or missing hook state reports unhealthy so tracked plans
// fail closed. MCP registration is verified by Doctor, not here.
func (Adapter) Inspect(_ context.Context, installation provider.Installation) (provider.RuntimeHealth, error) {
	path := ""
	for _, source := range installation.ConfigFiles {
		if source.Name == "hooks" {
			path = source.Path
		}
	}
	if path == "" || !hasSessionStartBinding(path) {
		return provider.RuntimeHealth{}, nil
	}
	return provider.RuntimeHealth{Healthy: true, Capabilities: Capabilities(), IntegrationHash: installation.IntegrationHash}, nil
}

// grokHome reports whether the probe environment scopes GROK_HOME at the
// checked home so version, hook, and MCP checks cannot read another profile.
func grokHome(environment []string, home string) bool {
	return slices.Contains(environment, "GROK_HOME="+home)
}

// CheckVersion verifies the executable reports a tested release.
func CheckVersion(ctx context.Context, installation provider.Installation) (string, error) {
	raw, err := provider.InspectCommand(ctx, installation, Descriptor().VersionArguments...)
	if err != nil {
		return "", err
	}
	version, err := Descriptor().ParseVersion(raw)
	if err != nil {
		return "", err
	}
	if !slices.Contains(TestedVersions, version) {
		return "", provider.Failure("provider_unsupported")
	}
	return version, nil
}
