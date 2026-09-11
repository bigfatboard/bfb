// ABOUTME: Maps bounded execution configuration to immutable locally compiled provider invocations.
// ABOUTME: Keeps peer data in stdin and requires exact observed session bindings for continuation.

package provider

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// Policy is resolved locally from the authorized immutable snapshot and local ceilings.
type Policy struct{ AllowedCapabilities []string }

func validEnvironment(environment []string) bool {
	if len(environment) > 256 {
		return false
	}
	names := map[string]bool{}
	for _, entry := range environment {
		name, _, ok := strings.Cut(entry, "=")
		if !ok || name == "" || len(entry) > 8192 || strings.ContainsAny(entry, "\x00\r\n") || names[name] {
			return false
		}
		names[name] = true
	}
	return true
}

func (registry *Registry) validatePlan(probe Probe, input LaunchInput, policy Policy, now time.Time) (Descriptor, error) {
	descriptor, ok := registry.descriptors[probe.Provider]
	if !ok || probe.registry != registry || probe.seal != probeSeal(probe) {
		return Descriptor{}, Failure("provider_probe_invalid")
	}
	if now.Before(probe.ObservedAt) || !now.Before(probe.ExpiresAt) {
		return Descriptor{}, Failure("provider_probe_expired")
	}
	if probe.Status != "healthy" || descriptor.Adapter == nil {
		return Descriptor{}, Failure("provider_unsupported")
	}
	config := input.Config
	if string(config.Provider) != probe.Provider || !slices.Contains(descriptor.Manifest.Models, config.Model) ||
		!slices.Contains([]string{"interactive", "headless"}, config.Mode) || !slices.Contains([]string{"low", "medium", "high"}, config.Effort) ||
		!slices.Contains([]string{"never", "on_request", "always"}, config.ApprovalPolicy) || !slices.Contains([]string{"read_only", "workspace_write"}, config.FilesystemPolicy) ||
		!slices.Contains([]string{"none", "session_start_additional_context"}, config.ContextInjection) ||
		!slices.Contains([]string{"none", "waiting_user_submit", "provider_prompt"}, config.InitialTurnTransport) ||
		len(config.RequiredCapabilities) == 0 || len(config.RequiredCapabilities) > 32 {
		return Descriptor{}, Failure("provider_config_invalid")
	}
	if !filepath.IsAbs(input.WorkingDirectory) || len(input.WorkingDirectory) > 4096 || strings.ContainsAny(input.WorkingDirectory, "\x00\r\n") {
		return Descriptor{}, Failure("provider_path_unsafe")
	}
	if info, err := os.Stat(input.WorkingDirectory); err != nil || !info.IsDir() {
		return Descriptor{}, Failure("provider_path_unsafe")
	}
	if input.RequestedSessionID != "" && !sessionPattern.MatchString(input.RequestedSessionID) {
		return Descriptor{}, Failure("provider_config_invalid")
	}
	required := append(slices.Clone(config.RequiredCapabilities), "launch."+config.Mode, "filesystem."+config.FilesystemPolicy, "approval."+config.ApprovalPolicy)
	if config.ContextInjection != "none" {
		required = append(required, "context.session_start")
	}
	if config.InitialTurnTransport == "provider_prompt" {
		required = append(required, "prompt.initial_constant")
	}
	if input.RequestedSessionID != "" {
		required = append(required, "session.requested_id")
	}
	available := Intersection(probe.Capabilities, policy.AllowedCapabilities)
	for _, capability := range required {
		if !namePattern.MatchString(capability) || !slices.Contains(available, capability) {
			return Descriptor{}, Failure("provider_capability_denied")
		}
	}
	return descriptor, nil
}

func makePlan(probe Probe, input LaunchInput, invocation Invocation) (Plan, error) {
	// Adapters cannot replace installation identity, ambient environment, or verified checkout.
	if invocation.Executable != "" || invocation.WorkingDirectory != "" || len(invocation.Environment) != 0 || len(invocation.Arguments) > 128 || len(invocation.Stdin) > MaxTurnBytes {
		return Plan{}, Failure("provider_config_invalid")
	}
	for _, argument := range invocation.Arguments {
		if len(argument) > 8192 || strings.ContainsAny(argument, "\x00\r\n") {
			return Plan{}, Failure("provider_config_invalid")
		}
	}
	invocation.Executable = probe.executable.CanonicalPath
	invocation.WorkingDirectory = input.WorkingDirectory
	invocation.Environment = append([]string{}, probe.installation.Environment...)
	invocation.Arguments = slices.Clone(invocation.Arguments)
	invocation.Stdin = slices.Clone(invocation.Stdin)
	state := "waiting_initial_turn"
	if input.Config.InitialTurnTransport == "waiting_user_submit" {
		state = "waiting_user_submit"
	}
	probe.Capabilities = slices.Clone(probe.Capabilities)
	return Plan{Provider: probe.Provider, InitialState: state, ManifestID: probe.ManifestID, probe: probe, invocation: invocation}, nil
}

func (registry *Registry) PlanLaunch(probe Probe, input LaunchInput, policy Policy, now time.Time) (Plan, error) {
	descriptor, err := registry.validatePlan(probe, input, policy, now)
	if err != nil {
		return Plan{}, err
	}
	input.Config.RequiredCapabilities = slices.Clone(input.Config.RequiredCapabilities)
	invocation, err := descriptor.Adapter.Launch(input)
	if err != nil {
		return Plan{}, err
	}
	return makePlan(probe, input, invocation)
}

func (registry *Registry) PlanTurn(probe Probe, input TurnInput, policy Policy, now time.Time) (Plan, error) {
	descriptor, err := registry.validatePlan(probe, input.LaunchInput, policy, now)
	if err != nil {
		return Plan{}, err
	}
	if input.Config.Mode != "headless" || input.Config.FilesystemPolicy != "read_only" || input.Config.ApprovalPolicy != "never" || input.Config.ContextInjection != "none" || input.Config.InitialTurnTransport != "provider_prompt" || !ulidPattern.MatchString(input.TurnID) || len(input.ExternalContext) > MaxTurnBytes/2 || !json.Valid(input.ExternalContext) {
		return Plan{}, Failure("provider_discussion_unsafe")
	}
	required := []string{"discussion.read_only", "turn.structured"}
	if input.Session != nil {
		binding := *input.Session
		if binding.Provider != probe.Provider || !sessionPattern.MatchString(binding.ObservedID) || !ulidPattern.MatchString(binding.RunID) || !ulidPattern.MatchString(binding.ExecutionID) || binding.Generation < 1 || binding.Generation > 9007199254740991 || input.RequestedSessionID != "" {
			return Plan{}, Failure("provider_session_invalid")
		}
		input.Session = &binding
		required = append(required, "session.resume")
	} else if input.Fork {
		return Plan{}, Failure("provider_session_invalid")
	}
	if input.Fork {
		required = append(required, "session.fork")
	}
	for _, capability := range required {
		if !slices.Contains(Intersection(probe.Capabilities, policy.AllowedCapabilities), capability) {
			return Plan{}, Failure("provider_capability_denied")
		}
	}
	context := slices.Clone(input.ExternalContext)
	input.ExternalContext = nil // A provider's argv builder never receives the peer's text.
	invocation, err := descriptor.Adapter.Turn(input)
	if err != nil {
		return Plan{}, err
	}
	invocation.Stdin, err = json.Marshal(struct {
		Instruction     string          `json:"instruction"`
		TurnID          string          `json:"turn_id"`
		ExternalContext json.RawMessage `json:"external_context"`
	}{DiscussionInstruction, input.TurnID, context})
	if err != nil {
		return Plan{}, Failure("provider_discussion_unsafe")
	}
	return makePlan(probe, input.LaunchInput, invocation)
}

func (registry *Registry) NormalizeHook(name string, raw []byte) (*Candidate, error) {
	descriptor, ok := registry.descriptors[name]
	if !ok || descriptor.Adapter == nil {
		return nil, Failure("provider_unsupported")
	}
	if len(raw) == 0 || len(raw) > MaxHookBytes {
		return nil, Failure("provider_event_invalid")
	}
	candidate, err := descriptor.Adapter.NormalizeHook(raw)
	if err != nil {
		return nil, Failure("provider_event_invalid")
	}
	if candidate == nil {
		return nil, nil
	}
	if err := candidate.Validate(); err != nil {
		return nil, err
	}
	return candidate, nil
}

func (registry *Registry) NormalizeTurn(name string, raw []byte) (*TurnEvent, error) {
	descriptor, ok := registry.descriptors[name]
	if !ok || descriptor.Adapter == nil {
		return nil, Failure("provider_unsupported")
	}
	if len(raw) == 0 || len(raw) > MaxTurnBytes {
		return nil, Failure("provider_event_invalid")
	}
	event, err := descriptor.Adapter.NormalizeTurn(raw)
	if err != nil {
		return nil, Failure("provider_event_invalid")
	}
	if event == nil {
		return nil, nil
	}
	if err := event.Validate(); err != nil {
		return nil, err
	}
	return event, nil
}
