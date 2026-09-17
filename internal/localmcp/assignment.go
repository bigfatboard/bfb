// ABOUTME: Models the immutable execution assignment a capability derives its boundary from.
// ABOUTME: Boundaries are copied out of the assignment; caller-supplied IDs never widen them.

package localmcp

import (
	"context"
	"regexp"
)

// Boundary is the workspace/project/task/run scope one capability may touch.
// It is copied from the verified assignment, never from caller arguments.
type Boundary struct {
	WorkspaceID string
	ProjectID   string
	TaskID      string
	RunID       string
	RunnerID    string
	CheckoutID  string
	ExecutionID string
	Generation  int64
}

// AssignmentRecord is the daemon-local view of one immutable execution
// assignment: identity, containment evidence, correlation, and liveness.
type AssignmentRecord struct {
	Known            bool
	Active           bool
	Boundary         Boundary
	CorrelationToken string
	ProviderPID      int
	ProviderStart    string
	OwnedGroupID     int
}

var idPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// AssignmentSource resolves the immutable assignment for an execution.
// Production reads the daemon database; tests inject fakes.
type AssignmentSource interface {
	Lookup(ctx context.Context, executionID string, generation int64) (AssignmentRecord, error)
}

// checkTask confines an optional caller-supplied task ID to the boundary.
func (boundary Boundary) checkTask(taskID string) error {
	if taskID == "" || taskID == boundary.TaskID {
		return nil
	}
	return fail("boundary_escape")
}

// checkProject confines an optional caller-supplied project ID to the boundary.
func (boundary Boundary) checkProject(projectID string) error {
	if projectID == "" || projectID == boundary.ProjectID {
		return nil
	}
	return fail("boundary_escape")
}

// checkParent confines an optional caller-supplied parent task: it must equal
// the bound task (child of the run's task). Any other value escapes.
func (boundary Boundary) checkParent(parentID string) error {
	if parentID == "" || parentID == boundary.TaskID {
		return nil
	}
	return fail("boundary_escape")
}
