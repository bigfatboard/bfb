// ABOUTME: Compiles supervised discussion turns through certified L03 adapters only.
// ABOUTME: Fresh turns start new sessions; continuations resume the exact owned observed session.

package discussion

import (
	"time"

	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
)

// KitPlanner plans discussion turns through the frozen L03 provider kit. Its
// configs are the D01-frozen read-only snapshots, one per provider; peer
// content reaches only stdin and never influences the plan.
type KitPlanner struct {
	Registry *provider.Registry
	Probes   map[string]provider.Probe
	Policy   provider.Policy
	Configs  map[string]generated.ExecutionConfig
	Now      func() time.Time
}

// PlanDiscussionTurn compiles one read-only headless turn. A fresh request
// starts a new session; a continuation resumes the exact owned observed
// session. Forks, predetermined sessions, and writable configs fail closed in
// the kit with provider_discussion_unsafe or provider_session_invalid.
func (planner *KitPlanner) PlanDiscussionTurn(name string, request TurnRequest) (provider.Invocation, error) {
	config, ok := planner.Configs[name]
	if !ok {
		return provider.Invocation{}, failure("provider_unsupported")
	}
	probe, ok := planner.Probes[name]
	if !ok {
		return provider.Invocation{}, failure("provider_unsupported")
	}
	now := time.Now()
	if planner.Now != nil {
		now = planner.Now()
	}
	input := provider.TurnInput{
		LaunchInput: provider.LaunchInput{
			Config:           config,
			WorkingDirectory: request.WorkingDir,
		},
		TurnID:          request.TurnID,
		ExternalContext: request.ExternalContext,
	}
	if !request.Fresh {
		if request.ObservedSession == "" {
			return provider.Invocation{}, failure("session_mismatch")
		}
		input.Session = &provider.SessionBinding{
			Provider:    name,
			ObservedID:  request.ObservedSession,
			RunID:       request.RunID,
			ExecutionID: request.ExecutionID,
			Generation:  request.Generation,
		}
	}
	plan, err := planner.Registry.PlanTurn(probe, input, planner.Policy, now)
	if err != nil {
		return provider.Invocation{}, err
	}
	return plan.Invocation(), nil
}
