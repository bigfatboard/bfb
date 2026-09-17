// ABOUTME: Holds one stdio connection's in-memory run capability and its activation race.
// ABOUTME: Activation is atomic and sticky; revocation, execution end, and terminal results close it.

package localmcp

import (
	"context"
	"sync"
)

// CapabilityState is provisional (read-only bootstrap), activated (full run
// scope), or closed (revoked, ended, terminal result, or EOF).
type CapabilityState string

const (
	StateProvisional CapabilityState = "provisional"
	StateActivated   CapabilityState = "activated"
	StateClosed      CapabilityState = "closed"
)

// AuthorityState is the current cloud/local authority for the run, rechecked
// on every call. Any set flag closes the capability before the call runs.
type AuthorityState struct {
	// Revoked reports an authorization or grant epoch change.
	Revoked bool
	// ExecutionEnded reports the execution reached ended.
	ExecutionEnded bool
	// ResultTerminal reports a terminal run result (accepted/failed/cancelled).
	ResultTerminal bool
}

// AuthoritySource reports current authority for a boundary. Production
// consults the daemon database and L08 channel state; tests inject fakes.
type AuthoritySource interface {
	Current(ctx context.Context, boundary Boundary) (AuthorityState, error)
}

// Capability binds one stdio connection to one assignment and boundary.
// The zero value is unusable; build one with NewCapability.
type Capability struct {
	mutex     sync.Mutex
	state     CapabilityState
	boundary  Boundary
	sessionID string
	bindings  SessionBindingSource
	authority AuthoritySource
}

// NewCapability returns a provisional capability for a verified assignment.
func NewCapability(boundary Boundary, bindings SessionBindingSource, authority AuthoritySource) *Capability {
	return &Capability{state: StateProvisional, boundary: boundary, bindings: bindings, authority: authority}
}

// Boundary returns the capability's derived boundary copy.
func (capability *Capability) Boundary() Boundary { return capability.boundary }

// State reports the current capability state for diagnostics (never stdout).
func (capability *Capability) State() CapabilityState {
	capability.mutex.Lock()
	defer capability.mutex.Unlock()
	return capability.state
}

// Close moves the capability to closed. It is sticky and never reopens.
func (capability *Capability) Close() {
	capability.mutex.Lock()
	defer capability.mutex.Unlock()
	capability.state = StateClosed
}

// ref derives the assignment reference for binding lookups.
func (capability *Capability) ref() AssignmentRef {
	return AssignmentRef{
		ExecutionID:          capability.boundary.ExecutionID,
		AssignmentGeneration: capability.boundary.Generation,
		RunID:                capability.boundary.RunID,
	}
}

// authorize rechecks current authority and fails closed on revocation, end,
// or terminal result. It closes the capability before returning the failure.
func (capability *Capability) authorize(ctx context.Context) error {
	capability.mutex.Lock()
	if capability.state == StateClosed {
		capability.mutex.Unlock()
		return fail("capability_closed")
	}
	capability.mutex.Unlock()
	state, err := capability.authority.Current(ctx, capability.boundary)
	if err != nil {
		return fail("internal_error")
	}
	switch {
	case state.Revoked:
		capability.Close()
		return fail("revoked")
	case state.ExecutionEnded:
		capability.Close()
		return fail("assignment_ended")
	case state.ResultTerminal:
		capability.Close()
		return fail("capability_closed")
	default:
		return nil
	}
}

// allowRead authorizes a bootstrap read: provisional or activated both serve.
func (capability *Capability) allowRead(ctx context.Context) error {
	return capability.authorize(ctx)
}

// allowWrite authorizes a mutation: the capability must be activated, and a
// provisional capability attempts exactly one atomic activation first.
func (capability *Capability) allowWrite(ctx context.Context) error {
	if err := capability.authorize(ctx); err != nil {
		return err
	}
	capability.mutex.Lock()
	if capability.state == StateActivated {
		capability.mutex.Unlock()
		return nil
	}
	capability.mutex.Unlock()
	if err := capability.activate(ctx); err != nil {
		return err
	}
	return nil
}

// activate observes the trusted binding and transitions provisional to
// activated exactly once. A competing session ID can never activate: after
// the first activation any other session reports session_conflict, and
// concurrent activators serialize on the mutex with one winner.
func (capability *Capability) activate(ctx context.Context) error {
	binding, err := capability.bindings.ObservedBinding(ctx, capability.ref())
	if err != nil {
		return fail("session_not_bound")
	}
	if !bindingMatches(capability.ref(), binding) {
		return fail("session_conflict")
	}
	capability.mutex.Lock()
	defer capability.mutex.Unlock()
	if capability.state == StateClosed {
		return fail("capability_closed")
	}
	if capability.state == StateActivated {
		if capability.sessionID != binding.ObservedSessionID {
			return fail("session_conflict")
		}
		return nil
	}
	capability.sessionID = binding.ObservedSessionID
	capability.state = StateActivated
	return nil
}

// SessionID returns the bound observed session, or "" while provisional.
func (capability *Capability) SessionID() string {
	capability.mutex.Lock()
	defer capability.mutex.Unlock()
	return capability.sessionID
}
