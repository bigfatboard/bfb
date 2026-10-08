// ABOUTME: Publishes immutable authenticated execution assignments for independent local readers.
// ABOUTME: Separates historical correlation evidence from fresh online authority to start a provider.

package supervisor

import (
	"encoding/base64"
	"os"
	"path/filepath"

	"github.com/qdis/bfb/internal/protocol/generated"
)

type AssignmentFiles struct{ directory *privateDirectory }

// OpenAssignmentFiles is daemon-only publication authority below prepared state.
func OpenAssignmentFiles(root string) (*AssignmentFiles, error) {
	return openAssignmentFiles(root, true)
}

// ReadAssignmentFiles cannot create state, keys, guard files or assignments.
func ReadAssignmentFiles(root string) (*AssignmentFiles, error) {
	return openAssignmentFiles(root, false)
}

func openAssignmentFiles(root string, create bool) (*AssignmentFiles, error) {
	info, err := os.Lstat(root)
	if err != nil || !filepath.IsAbs(root) || filepath.Clean(root) != root || !info.IsDir() || !privateOwned(info) {
		return nil, failure("unsafe_state")
	}
	path := filepath.Join(root, "execution-records")
	var directory *privateDirectory
	if create {
		directory, err = openPrivateDirectory(path)
	} else {
		directory, err = openExistingPrivateDirectory(path)
	}
	if err != nil {
		return nil, err
	}
	return &AssignmentFiles{directory: directory}, nil
}

func (files *AssignmentFiles) Close() error { return files.directory.file.Close() }

func validateLocalAssignment(assignment generated.LocalExecutionAssignment) error {
	if _, err := wireJSON("local-execution-assignment", assignment); err != nil {
		return failure("execution_assignment_invalid")
	}
	claim := assignment.Claim
	if err := validateClaim(claim, claim.Assignment.WorkspaceId, claim.Assignment.RunnerId, claim.Specification.LaunchId, claim.Specification.ExpiresAt); err != nil {
		return err
	}
	token, err := base64.RawURLEncoding.DecodeString(assignment.CorrelationToken)
	if err != nil || len(token) != 32 || base64.RawURLEncoding.EncodeToString(token) != assignment.CorrelationToken {
		return failure("execution_assignment_invalid")
	}
	return nil
}

func (files *AssignmentFiles) Publish(assignment generated.LocalExecutionAssignment) error {
	if err := validateLocalAssignment(assignment); err != nil {
		return err
	}
	return files.directory.createOnce(assignment.TerminalIntentId+".assignment.json", assignment)
}

// Read validates historical evidence, not current launch permission. The original
// launch deadline may have passed during a live execution or delayed hook replay.
func (files *AssignmentFiles) Read(intent string) (generated.LocalExecutionAssignment, error) {
	var assignment generated.LocalExecutionAssignment
	if !terminalIntent.MatchString(intent) {
		return assignment, failure("invalid_request")
	}
	if err := files.directory.read(intent+".assignment.json", &assignment); err != nil {
		return generated.LocalExecutionAssignment{}, failure("execution_assignment_invalid")
	}
	if assignment.TerminalIntentId != intent {
		return generated.LocalExecutionAssignment{}, failure("execution_assignment_invalid")
	}
	if err := validateLocalAssignment(assignment); err != nil {
		return generated.LocalExecutionAssignment{}, err
	}
	return assignment, nil
}
