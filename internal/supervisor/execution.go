// ABOUTME: Reconstructs an execution from authenticated preparation and exact registered checkout state.
// ABOUTME: Repeats local policy and identity checks without accepting transport-supplied paths or arguments.

package supervisor

import (
	"context"
	"database/sql"
	"encoding/json"
	"slices"
	"time"

	"github.com/qdis/bfb/internal/checkout"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
)

type preparedExecution struct {
	paths       daemon.Paths
	assignment  generated.LocalExecutionAssignment
	preparation LaunchPreparation
	checkout    checkout.Record
	db          *sql.DB
	registry    *provider.Registry
	plan        provider.Plan
}

func launchDeadline(assignment generated.LocalExecutionAssignment, now time.Time) (time.Time, error) {
	deadline, err := time.Parse(time.RFC3339Nano, assignment.Claim.Specification.ExpiresAt)
	if err != nil || !now.Before(deadline) {
		return time.Time{}, failure("expired_intent")
	}
	return deadline, nil
}

// checkCheckout binds both registration and live filesystem observations to
// the cloud snapshot. A routine inventory refresh cannot change this binding.
func checkCheckout(ctx context.Context, registry *checkout.Registry, assignment generated.LocalExecutionAssignment) (checkout.Record, error) {
	claim := assignment.Claim
	binding, snapshot := claim.Assignment, claim.Snapshot
	record, err := registry.Get(ctx, binding.CheckoutId)
	if err != nil {
		return checkout.Record{}, err
	}
	summary := record.Summary
	if summary.WorkspaceId != binding.WorkspaceId || summary.RunnerId != binding.RunnerId || summary.ProjectId != binding.ProjectId || summary.PhysicalWorktreeHash != snapshot.PhysicalWorktreeHash || provider.Hash([]byte(summary.RepositoryIdentity)) != snapshot.RepositoryIdentityHash {
		return checkout.Record{}, failure("execution_assignment_invalid")
	}
	// The snapshot was authorized by C09. The L02 checker also enforces that
	// actual repository restrictions cannot widen its parent project ceiling.
	encoded, _ := json.Marshal(snapshot.ProjectPolicy)
	var parent checkout.Policy
	if strictPrivateJSON(encoded, &parent) != nil {
		return checkout.Record{}, failure("execution_assignment_invalid")
	}
	observed, err := registry.RevalidateForExecution(ctx, binding.CheckoutId, snapshot.RepositoryConfigHash, parent)
	if err != nil {
		return checkout.Record{}, err
	}
	effective, err := observed.Config.Tighten(parent)
	if err != nil || !effective.AllowPassToAgent || !slices.Contains(effective.AllowedProviders, string(claim.Specification.ExecutionConfig.Provider)) {
		return checkout.Record{}, failure("checkout_policy_widening")
	}
	if observed.Location != record.Location {
		return checkout.Record{}, failure("checkout_identity_changed")
	}
	// Registration supplies identity, not current Git facts. Keep this fresh
	// observation local without turning execution preflight into a registry write.
	record.Summary.Branch, record.Summary.Head = nil, nil
	if observed.Branch != "" {
		record.Summary.Branch = &observed.Branch
	}
	if observed.Head != "" {
		record.Summary.Head = &observed.Head
	}
	record.Summary.Dirty, record.Summary.ValidatedAt = observed.Dirty, observed.ValidatedAt
	return record, nil
}

// loadExecution follows authenticated registration (or an authenticated kernel
// parent in the gated child). It opens no daemon writer and runs no migration.
func loadExecution(ctx context.Context, paths daemon.Paths, assignment generated.LocalExecutionAssignment, registry *provider.Registry, normal []string) (*preparedExecution, error) {
	if validateLocalAssignment(assignment) != nil || registry == nil {
		return nil, failure("execution_assignment_invalid")
	}
	if _, err := launchDeadline(assignment, time.Now()); err != nil {
		return nil, err
	}
	db, err := daemon.OpenReader(ctx, paths)
	if err != nil {
		return nil, err
	}
	failed := true
	defer func() {
		if failed {
			_ = db.Close()
		}
	}()
	source, err := resumeForClaim(ctx, db, assignment.Claim, time.Now())
	if err != nil {
		return nil, err
	}
	record, err := checkCheckout(ctx, checkout.NewRegistry(db), assignment)
	if err != nil {
		return nil, err
	}
	files, err := ReadAssignmentFiles(paths.Root)
	if err != nil {
		return nil, err
	}
	defer files.Close()
	preparation, err := files.ReadPreparation(assignment, record.Location.GitRoot)
	if err != nil {
		return nil, err
	}
	probe, err := preparation.Probe(ctx, registry, assignment, normal, time.Now())
	if err != nil {
		return nil, err
	}
	plan, err := planExecution(registry, probe, assignment.Claim, record.Location.WorkingDirectory, source, time.Now())
	if err != nil {
		return nil, err
	}
	// Interactive stdin must remain the PTY. Adapters provide a native initial
	// prompt transport; this layer must never inject terminal keystrokes.
	if assignment.Claim.Specification.ExecutionConfig.Mode != "interactive" || len(plan.Invocation().Stdin) != 0 {
		return nil, failure("provider_config_invalid")
	}
	failed = false
	return &preparedExecution{paths: paths, assignment: assignment, preparation: preparation, checkout: record, db: db, registry: registry, plan: plan}, nil
}

func (execution *preparedExecution) revalidate(ctx context.Context) error {
	if _, err := launchDeadline(execution.assignment, time.Now()); err != nil {
		return err
	}
	if _, err := resumeForClaim(ctx, execution.db, execution.assignment.Claim, time.Now()); err != nil {
		return err
	}
	current, err := checkCheckout(ctx, checkout.NewRegistry(execution.db), execution.assignment)
	if err != nil {
		return err
	}
	if current.Location != execution.checkout.Location {
		return failure("checkout_identity_changed")
	}
	if err := execution.preparation.RevalidateArtifacts(execution.paths.Root, execution.assignment.Claim.Assignment.RunExecutionId, execution.checkout.Location.GitRoot); err != nil {
		return err
	}
	return execution.registry.RevalidateSources(execution.plan, time.Now())
}
