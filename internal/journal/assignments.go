// ABOUTME: Reads L05-owned execution assignments without duplicating their durable state.
// ABOUTME: Hooks validate correlation, creation time and grace windows against this record only.

package journal

import (
	"context"
	"crypto/subtle"
)

// Assignment is the immutable execution-assignment view a hook must present.
// The correlation token authenticates capture only; it is never uploaded.
type Assignment struct {
	IntentID     string
	ExecutionID  string
	Generation   int64
	RunnerID     string
	WorkspaceID  string
	ProjectID    string
	TaskID       string
	RunID        string
	CheckoutID   string
	Provider     string
	Token        string
	CreatedAt    string
	WindowEndsAt string
}

// Assignments resolves L05-owned assignment records for hook validation and
// inbox import. Production uses the supervisor adapter; tests supply a fake.
type Assignments interface {
	ByExecution(ctx context.Context, executionID string, generation int64) (Assignment, error)
	ByIntent(ctx context.Context, intentID string) (Assignment, error)
}

func validToken(presented, stored string) bool {
	if presented == "" || stored == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(presented), []byte(stored)) == 1
}
