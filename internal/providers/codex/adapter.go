// ABOUTME: Maps bounded execution configuration to documented Codex 0.153.4 invocations.
// ABOUTME: Never selects sessions, transports, or privilege flags outside the tested contract.

package codex

import (
	"context"

	"github.com/qdis/bfb/internal/provider"
)

// TestedVersions lists the exact Codex releases this adapter certifies.
// Unknown versions receive no tracked capabilities from help text or habit.
var TestedVersions = []string{"0.153.4"}

// TestedModels lists the exact models exercised against the tested releases.
var TestedModels = []string{"gpt-5.6-sol"}

// ManifestVersion identifies this adapter's integration contract. Bump it
// whenever argv, hook, setup, or parsing behavior changes so recorded
// integration hashes stop matching across the change.
const ManifestVersion = "1.0.0"

// IntegrationID binds a local installation to this adapter contract. L05
// records it at probe time; any adapter change invalidates prior evidence.
func IntegrationID() string { return provider.Hash([]byte("bfb-codex-integration/1")) }

// Capabilities returns the tested capability set for Codex 0.153.4.
// Deliberately absent: session.requested_id (no documented TUI flag accepts a
// predetermined session) and approval.always (0.153.4 has no always-prompt
// policy, so such launches fail closed through capability denial).
func Capabilities() []string {
	return []string{
		"launch.interactive",
		"launch.headless",
		"filesystem.read_only",
		"filesystem.workspace_write",
		"approval.never",
		"approval.on_request",
		"context.session_start",
		"prompt.initial_constant",
		"session.resume",
		"session.resume.interactive",
		"session.fork",
		"discussion.read_only",
		"turn.structured",
		"hooks.session_start",
		"mcp.stdio",
		"control.interrupt",
		"control.terminate",
	}
}

// Adapter implements provider.Adapter for Codex without touching shared kit state.
type Adapter struct{}

func sandboxFlag(policy string) (string, error) {
	switch policy {
	case "read_only":
		return "read-only", nil
	case "workspace_write":
		return "workspace-write", nil
	default:
		return "", provider.Failure("provider_config_invalid")
	}
}

// interactiveApproval maps BFB approval policy to the TUI --ask-for-approval
// values documented by codex --help for 0.153.4 (on-request, never).
func interactiveApproval(policy string) (string, error) {
	switch policy {
	case "never":
		return "never", nil
	case "on_request":
		return "on-request", nil
	default:
		return "", provider.Failure("provider_config_invalid")
	}
}

// headlessApproval maps BFB approval policy to the exec -c approval_policy
// values accepted by 0.153.4 (probed: never and on-request pass config load,
// always and on_request are rejected before execution).
func headlessApproval(policy string) (string, error) {
	switch policy {
	case "never":
		return "never", nil
	case "on_request":
		return "on-request", nil
	default:
		return "", provider.Failure("provider_config_invalid")
	}
}

func effortFlag(effort string) []string {
	return []string{"-c", "model_reasoning_effort=\"" + effort + "\""}
}

func (Adapter) Launch(input provider.LaunchInput) (provider.Invocation, error) {
	config := input.Config
	sandbox, err := sandboxFlag(config.FilesystemPolicy)
	if err != nil {
		return provider.Invocation{}, err
	}
	if config.Mode == "interactive" {
		approval, err := interactiveApproval(config.ApprovalPolicy)
		if err != nil {
			return provider.Invocation{}, err
		}
		argv := []string{"--cd", input.WorkingDirectory, "--sandbox", sandbox, "--ask-for-approval", approval, "--model", config.Model}
		argv = append(argv, effortFlag(config.Effort)...)
		if config.InitialTurnTransport == "provider_prompt" {
			argv = append(argv, provider.InitialInstruction)
		}
		return provider.Invocation{Arguments: argv}, nil
	}
	approval, err := headlessApproval(config.ApprovalPolicy)
	if err != nil {
		return provider.Invocation{}, err
	}
	argv := []string{"exec", "--cd", input.WorkingDirectory, "--sandbox", sandbox, "--model", config.Model, "-c", "approval_policy=\"" + approval + "\""}
	argv = append(argv, effortFlag(config.Effort)...)
	argv = append(argv, "--json", "--color", "never", "-")
	invocation := provider.Invocation{Arguments: argv}
	if config.InitialTurnTransport == "provider_prompt" {
		invocation.Stdin = []byte(provider.InitialInstruction)
	}
	return invocation, nil
}

// Resume continues an exact owned interactive session. It never uses --last,
// a picker, or a fresh session fallback; unknown targets fail at runtime.
func (Adapter) Resume(input provider.ResumeInput) (provider.Invocation, error) {
	config := input.Config
	sandbox, err := sandboxFlag(config.FilesystemPolicy)
	if err != nil {
		return provider.Invocation{}, err
	}
	approval, err := interactiveApproval(config.ApprovalPolicy)
	if err != nil {
		return provider.Invocation{}, err
	}
	argv := []string{"resume", input.Session.ObservedID, "--cd", input.WorkingDirectory, "--sandbox", sandbox, "--ask-for-approval", approval, "--model", config.Model}
	argv = append(argv, effortFlag(config.Effort)...)
	return provider.Invocation{Arguments: argv}, nil
}

// Turn plans a headless read-only discussion turn. Peer content never reaches
// argv; the kit encodes it as attributed stdin after this returns. Exec
// resume and fork inherit the bound session's working root, so they carry no
// --cd or --sandbox flags, which those subcommands do not accept.
func (Adapter) Turn(input provider.TurnInput) (provider.Invocation, error) {
	config := input.Config
	if config.Mode != "headless" || config.FilesystemPolicy != "read_only" || config.ApprovalPolicy != "never" {
		return provider.Invocation{}, provider.Failure("provider_discussion_unsafe")
	}
	base := []string{"--model", config.Model, "-c", "approval_policy=\"never\""}
	base = append(base, effortFlag(config.Effort)...)
	base = append(base, "--json")
	switch {
	case input.Session != nil && input.Fork:
		return provider.Invocation{Arguments: append([]string{"exec", "fork", input.Session.ObservedID}, append(base, "-")...)}, nil
	case input.Session != nil:
		return provider.Invocation{Arguments: append([]string{"exec", "resume", input.Session.ObservedID}, append(base, "-")...)}, nil
	case input.Fork:
		return provider.Invocation{}, provider.Failure("provider_session_invalid")
	default:
		argv := []string{"exec", "--cd", input.WorkingDirectory, "--sandbox", "read-only", "--model", config.Model, "-c", "approval_policy=\"never\""}
		argv = append(argv, effortFlag(config.Effort)...)
		argv = append(argv, "--json", "--color", "never", "-")
		return provider.Invocation{Arguments: argv}, nil
	}
}

// Interrupt requests cooperative cancellation; L05 verifies identity and signals.
func (Adapter) Interrupt() provider.Control { return provider.Interrupt }

// Terminate requests forced shutdown; L05 owns TERM/KILL escalation.
func (Adapter) Terminate() provider.Control { return provider.Terminate }

// Inspect reports runtime health from the BFB hook integration. It echoes the
// installation hash when healthy, like the fake adapter; drifted or missing
// hook state reports unhealthy so tracked plans fail closed.
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
