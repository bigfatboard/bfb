// ABOUTME: Implements a synthetic provider lifecycle and bounded semantic event normalization.
// ABOUTME: Exercises immutable invocation and read-only discussion contracts without network access.

package fake

import (
	"context"
	"slices"

	"github.com/qdis/bfb/internal/provider"
)

func Capabilities() []string {
	return []string{"launch.interactive", "launch.headless", "filesystem.read_only", "filesystem.workspace_write", "approval.never", "approval.on_request", "approval.always", "context.session_start", "prompt.initial_constant", "session.requested_id", "session.resume", "session.fork", "discussion.read_only", "turn.structured", "hooks.session_start", "mcp.stdio", "control.interrupt", "control.terminate"}
}

func Descriptor() provider.Descriptor {
	return provider.Descriptor{Name: "fake", VersionArguments: []string{"--version"}, ParseVersion: provider.ParseVersion("bfb-fake-provider ", ""), Manifest: provider.Manifest{Provider: "fake", Version: "1.0.0", TestedVersions: []string{"1.0.0"}, Capabilities: Capabilities(), Models: []string{"synthetic"}}, Adapter: Adapter{}}
}

type Adapter struct{}

func (Adapter) Inspect(ctx context.Context, installation provider.Installation) (provider.RuntimeHealth, error) {
	raw, err := provider.InspectCommand(ctx, installation, "--probe")
	if err != nil {
		return provider.RuntimeHealth{}, err
	}
	var result struct {
		Healthy      bool     `json:"healthy"`
		Capabilities []string `json:"capabilities"`
	}
	if provider.DecodeJSON(raw, &result) != nil {
		return provider.RuntimeHealth{}, provider.Failure("provider_probe_failed")
	}
	return provider.RuntimeHealth{Healthy: result.Healthy, Capabilities: provider.Intersection(result.Capabilities, Capabilities()), IntegrationHash: installation.IntegrationHash}, nil
}

func (Adapter) Launch(input provider.LaunchInput) (provider.Invocation, error) {
	config := input.Config
	args := []string{"--mode", config.Mode, "--model", config.Model, "--effort", config.Effort, "--approval", config.ApprovalPolicy, "--filesystem", config.FilesystemPolicy, "--context", config.ContextInjection}
	if input.RequestedSessionID != "" {
		args = append(args, "--session", input.RequestedSessionID)
	}
	if config.InitialTurnTransport == "provider_prompt" {
		if config.Mode == "interactive" {
			return provider.Invocation{Arguments: append(args, "--initial-prompt", provider.InitialInstruction)}, nil
		}
		args = append(args, "--initial-stdin")
		return provider.Invocation{Arguments: args, Stdin: []byte(provider.InitialInstruction)}, nil
	}
	return provider.Invocation{Arguments: args}, nil
}

func (adapter Adapter) Turn(input provider.TurnInput) (provider.Invocation, error) {
	invocation, err := adapter.Launch(input.LaunchInput)
	if err != nil {
		return invocation, err
	}
	invocation.Arguments = append(invocation.Arguments, "--turn", input.TurnID)
	if input.Session != nil {
		invocation.Arguments = append(invocation.Arguments, "--resume", input.Session.ObservedID)
	}
	if input.Fork {
		invocation.Arguments = append(invocation.Arguments, "--fork")
	}
	return invocation, nil
}

func (Adapter) NormalizeHook(raw []byte) (*provider.Candidate, error) {
	var candidate provider.Candidate
	if len(raw) > provider.MaxHookBytes || provider.DecodeJSON(raw, &candidate) != nil {
		return nil, provider.Failure("provider_event_invalid")
	}
	if err := candidate.Validate(); err != nil {
		return nil, err
	}
	return &candidate, nil
}

func (Adapter) NormalizeTurn(raw []byte) (*provider.TurnEvent, error) {
	var event provider.TurnEvent
	if len(raw) > provider.MaxTurnBytes || provider.DecodeJSON(raw, &event) != nil {
		return nil, provider.Failure("provider_event_invalid")
	}
	if !slices.Contains([]string{"session_observed", "turn_started", "message", "turn_completed", "turn_failed"}, event.Kind) {
		return nil, nil
	}
	if err := event.Validate(); err != nil {
		return nil, err
	}
	return &event, nil
}

func (Adapter) Interrupt() provider.Control { return provider.Interrupt }
func (Adapter) Terminate() provider.Control { return provider.Terminate }
