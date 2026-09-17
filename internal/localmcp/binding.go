// ABOUTME: Declares the narrow trusted session-binding plug-in consumed from L06's hook journal.
// ABOUTME: Compares only immutable assignment identity; it never invents a session identifier.

package localmcp

import (
	"context"
	"errors"
	"time"
)

// AssignmentRef identifies one immutable execution assignment.
type AssignmentRef struct {
	ExecutionID          string
	AssignmentGeneration int64
	RunID                string
}

// SessionBinding is the trusted observed provider-session fact owned by L06.
// Every field is compared for equality before a capability activates.
type SessionBinding struct {
	ExecutionID          string
	AssignmentGeneration int64
	RunID                string
	ObservedSessionID    string
	ObservedAt           time.Time
}

// ErrSessionNotBound reports that L06 has not committed a binding for the ref yet.
var ErrSessionNotBound = errors.New("localmcp: session not bound")

// SessionBindingSource returns the trusted observed binding for an assignment.
// A01 defines this interface; L06's hook-journal store plugs in at merge by
// implementing this one method. Test doubles stand in until then.
type SessionBindingSource interface {
	ObservedBinding(ctx context.Context, ref AssignmentRef) (SessionBinding, error)
}

// bindingMatches reports whether a trusted binding authorizes the assignment.
// A competing session ID never matches an already-activated connection; the
// caller enforces that stickiness, this function enforces field equality.
func bindingMatches(ref AssignmentRef, binding SessionBinding) bool {
	return binding.ExecutionID == ref.ExecutionID &&
		binding.AssignmentGeneration == ref.AssignmentGeneration &&
		binding.RunID == ref.RunID &&
		binding.ObservedSessionID != "" &&
		!binding.ObservedAt.IsZero()
}
