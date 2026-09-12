// ABOUTME: Durably accepts runner commands and issues exactly one local Terminal intent per execution.
// ABOUTME: Registers immutable native supervisor identity before exposing a claimed execution assignment.

package supervisor

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/runner"
)

var terminalIntent = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)

type IntentStore struct{ db *sql.DB }

func NewIntentStore(db *sql.DB) *IntentStore { return &IntentStore{db: db} }

type LocalCommand struct {
	WorkspaceID, RunnerID, ID, Kind, ExpiresAt, ClaimKey, ClaimStartedAt, State string
	CleanupLockID                                                               string
}

func localTimestamp(now time.Time) string {
	return now.UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano)
}

func (store *IntentStore) Accept(ctx context.Context, enrollment runner.Enrollment, reference runner.CommandReference, now time.Time) error {
	if !executionID.MatchString(enrollment.WorkspaceID) || !executionID.MatchString(enrollment.RunnerID) || !executionID.MatchString(reference.ID) || (reference.Kind != "launch" && reference.Kind != "run_control") {
		return failure("invalid_request")
	}
	if _, err := time.Parse(time.RFC3339Nano, reference.ExpiresAt); err != nil {
		return failure("invalid_request")
	}
	stamp := localTimestamp(now)
	_, err := store.db.ExecContext(ctx, `INSERT INTO execution_commands
(runner_id, command_id, workspace_id, command_kind, expires_at, received_at, claim_key, claim_started_at, state)
SELECT ?,?,?,?,?,?,?,?,'queued' WHERE (SELECT count(*) FROM execution_commands) < 8192
AND (SELECT count(*) FROM execution_commands WHERE state IN ('queued','waiting')) < 256
ON CONFLICT(runner_id,command_id) DO NOTHING`, enrollment.RunnerID, reference.ID, enrollment.WorkspaceID, reference.Kind, reference.ExpiresAt, stamp, daemon.NewRequestID(), stamp)
	if err != nil {
		return failure("storage_failed")
	}
	command, err := store.Command(ctx, enrollment.RunnerID, reference.ID)
	if err != nil {
		return failure("execution_capacity")
	}
	if command.WorkspaceID != enrollment.WorkspaceID || command.Kind != reference.Kind || command.ExpiresAt != reference.ExpiresAt {
		return failure("execution_assignment_invalid")
	}
	return nil
}

func (store *IntentStore) Command(ctx context.Context, runner, id string) (LocalCommand, error) {
	var command LocalCommand
	err := scanCommand(store.db.QueryRowContext(ctx, "SELECT "+commandColumns+" FROM execution_commands WHERE runner_id = ? AND command_id = ?", runner, id), &command)
	if err != nil {
		return LocalCommand{}, failure("storage_failed")
	}
	return command, nil
}

type SupervisorIdentity struct {
	Process        Process `json:"process"`
	ExecutableHash string  `json:"executable_hash"`
}

func (identity SupervisorIdentity) valid() bool {
	return validRecordedProcess(identity.Process) && !identity.Process.Zombie && worktreeDigest.MatchString(identity.ExecutableHash)
}

type LocalAssignment struct {
	IntentID, State, ProviderIdentityHash, CorrelationToken, CreatedAt string
	Claim                                                              generated.LaunchClaimResult
	Supervisor                                                         *SupervisorIdentity
	LockID                                                             string
	Group                                                              *Process
}

func newIntentID() (string, error) {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", failure("storage_failed")
	}
	random[6], random[8] = random[6]&15|64, random[8]&63|128
	encoded := hex.EncodeToString(random[:])
	return encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:], nil
}

const assignmentColumns = `intent_id,state,provider_identity_hash,correlation_token,created_at,claim_json,supervisor_json,
execution_id,assignment_generation,workspace_id,project_id,task_id,run_id,runner_id,checkout_id,launch_id,
physical_worktree_hash,fencing_generation,expires_at,local_lock_id,owned_group_json`

type assignmentScanner interface{ Scan(...any) error }

func scanAssignment(row assignmentScanner) (LocalAssignment, error) {
	var assignment LocalAssignment
	var data string
	var supervisor sql.NullString
	var lock, group sql.NullString
	var pinned generated.ExecutionAssignment
	var launch, physical, expires string
	var fence int64
	if err := row.Scan(&assignment.IntentID, &assignment.State, &assignment.ProviderIdentityHash, &assignment.CorrelationToken, &assignment.CreatedAt, &data, &supervisor,
		&pinned.RunExecutionId, &pinned.AssignmentGeneration, &pinned.WorkspaceId, &pinned.ProjectId, &pinned.TaskId, &pinned.RunId, &pinned.RunnerId, &pinned.CheckoutId, &launch, &physical, &fence, &expires, &lock, &group); err != nil {
		return LocalAssignment{}, failure("execution_assignment_invalid")
	}
	if !terminalIntent.MatchString(assignment.IntentID) || !worktreeDigest.MatchString(assignment.ProviderIdentityHash) || len(data) > 32768 || strictPrivateJSON([]byte(data), &assignment.Claim) != nil {
		return LocalAssignment{}, failure("execution_assignment_invalid")
	}
	token, err := base64.RawURLEncoding.DecodeString(assignment.CorrelationToken)
	if err != nil || len(token) != 32 || base64.RawURLEncoding.EncodeToString(token) != assignment.CorrelationToken {
		return LocalAssignment{}, failure("execution_assignment_invalid")
	}
	claim := assignment.Claim
	if err = validateClaim(claim, pinned.WorkspaceId, pinned.RunnerId, launch, expires); err != nil {
		return LocalAssignment{}, err
	}
	binding := claim.Assignment
	if binding.RunExecutionId != pinned.RunExecutionId || binding.AssignmentGeneration != pinned.AssignmentGeneration || binding.ProjectId != pinned.ProjectId || binding.TaskId != pinned.TaskId || binding.RunId != pinned.RunId || binding.CheckoutId != pinned.CheckoutId || claim.Snapshot.PhysicalWorktreeHash != physical || claim.FencingGeneration != fence {
		return LocalAssignment{}, failure("execution_assignment_invalid")
	}
	if supervisor.Valid {
		var identity SupervisorIdentity
		if strictPrivateJSON([]byte(supervisor.String), &identity) != nil || !identity.valid() {
			return LocalAssignment{}, failure("execution_assignment_invalid")
		}
		assignment.Supervisor = &identity
	}
	if lock.Valid {
		if !executionID.MatchString(lock.String) || assignment.Supervisor == nil {
			return LocalAssignment{}, failure("execution_assignment_invalid")
		}
		assignment.LockID = lock.String
	}
	if group.Valid {
		var leader Process
		if strictPrivateJSON([]byte(group.String), &leader) != nil || !validRecordedProcess(leader) || leader.Zombie || leader.GroupID != leader.PID || assignment.Supervisor == nil || leader.ParentPID != assignment.Supervisor.Process.PID || assignment.LockID == "" {
			return LocalAssignment{}, failure("execution_assignment_invalid")
		}
		assignment.Group = &leader
	}
	if (assignment.State == "group_ready" || assignment.State == "running") && assignment.Group == nil {
		return LocalAssignment{}, failure("execution_assignment_invalid")
	}
	return assignment, nil
}

func (store *IntentStore) ByIntent(ctx context.Context, intent string) (LocalAssignment, error) {
	if !terminalIntent.MatchString(intent) {
		return LocalAssignment{}, failure("invalid_request")
	}
	return scanAssignment(store.db.QueryRowContext(ctx, "SELECT "+assignmentColumns+" FROM local_execution_assignments WHERE intent_id = ?", intent))
}

func (store *IntentStore) Issue(ctx context.Context, command LocalCommand, claim generated.LaunchClaimResult, providerIdentity string, now time.Time) (LocalAssignment, error) {
	if command.Kind != "launch" || command.CleanupLockID != "" || (command.State != "queued" && command.State != "waiting") || !worktreeDigest.MatchString(providerIdentity) {
		return LocalAssignment{}, failure("invalid_request")
	}
	stored, err := store.Command(ctx, command.RunnerID, command.ID)
	if err != nil || stored != command {
		return LocalAssignment{}, failure("execution_assignment_invalid")
	}
	if err := validateClaim(claim, command.WorkspaceID, command.RunnerID, command.ID, command.ExpiresAt); err != nil {
		return LocalAssignment{}, err
	}
	deadline, _ := time.Parse(time.RFC3339Nano, command.ExpiresAt)
	if !now.Before(deadline) {
		return LocalAssignment{}, failure("expired_intent")
	}
	data, err := json.Marshal(claim)
	if err != nil || len(data) > 32768 {
		return LocalAssignment{}, failure("invalid_request")
	}
	intent, err := newIntentID()
	if err != nil {
		return LocalAssignment{}, err
	}
	var token [32]byte
	if _, err = rand.Read(token[:]); err != nil {
		return LocalAssignment{}, failure("storage_failed")
	}
	binding := claim.Assignment
	_, err = store.db.ExecContext(ctx, `INSERT INTO local_execution_assignments
(execution_id,assignment_generation,workspace_id,project_id,task_id,run_id,runner_id,checkout_id,
launch_id,intent_id,physical_worktree_hash,fencing_generation,claim_json,provider_identity_hash,correlation_token,created_at,expires_at,state)
SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'intent_ready' WHERE (SELECT count(*) FROM local_execution_assignments) < 8192
ON CONFLICT(runner_id,launch_id) DO NOTHING`, binding.RunExecutionId, binding.AssignmentGeneration, binding.WorkspaceId, binding.ProjectId, binding.TaskId, binding.RunId, binding.RunnerId, binding.CheckoutId, command.ID, intent, claim.Snapshot.PhysicalWorktreeHash, claim.FencingGeneration, string(data), providerIdentity, base64.RawURLEncoding.EncodeToString(token[:]), localTimestamp(now), command.ExpiresAt)
	if err != nil {
		return LocalAssignment{}, failure("storage_failed")
	}
	assignment, err := scanAssignment(store.db.QueryRowContext(ctx, "SELECT "+assignmentColumns+" FROM local_execution_assignments WHERE runner_id = ? AND launch_id = ?", command.RunnerID, command.ID))
	if err != nil {
		return LocalAssignment{}, err
	}
	existing, _ := json.Marshal(assignment.Claim)
	if string(existing) != string(data) || assignment.ProviderIdentityHash != providerIdentity {
		return LocalAssignment{}, failure("execution_assignment_invalid")
	}
	return assignment, nil
}

// Offer commits before asking the signed app to open Terminal. A lost delivery
// result must not repeat that effect or mint another local intent.
func (store *IntentStore) Offer(ctx context.Context, intent string) (bool, error) {
	if !terminalIntent.MatchString(intent) {
		return false, failure("invalid_request")
	}
	result, err := store.db.ExecContext(ctx, "UPDATE local_execution_assignments SET state = 'offered' WHERE intent_id = ? AND state = 'intent_ready'", intent)
	if err != nil {
		return false, failure("storage_failed")
	}
	count, _ := result.RowsAffected()
	return count == 1, nil
}

// Register accepts only an identity freshly derived and signature-checked by
// the RPC service. Caller-provided PID/hash fields are never this authority.
func (store *IntentStore) Register(ctx context.Context, intent string, identity SupervisorIdentity, now time.Time) (LocalAssignment, error) {
	if !terminalIntent.MatchString(intent) || !identity.valid() {
		return LocalAssignment{}, failure("peer_denied")
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return LocalAssignment{}, failure("storage_failed")
	}
	defer tx.Rollback()
	assignment, err := scanAssignment(tx.QueryRowContext(ctx, "SELECT "+assignmentColumns+" FROM local_execution_assignments WHERE intent_id = ?", intent))
	if err != nil {
		return LocalAssignment{}, err
	}
	deadline, _ := time.Parse(time.RFC3339Nano, assignment.Claim.Specification.ExpiresAt)
	if !now.Before(deadline) {
		return LocalAssignment{}, failure("expired_intent")
	}
	if assignment.Supervisor != nil {
		if !assignment.Supervisor.Process.Same(identity.Process) || assignment.Supervisor.ExecutableHash != identity.ExecutableHash {
			return LocalAssignment{}, failure("execution_intent_consumed")
		}
		if assignment.State != "registered" {
			return LocalAssignment{}, failure("execution_intent_consumed")
		}
		return assignment, nil
	}
	if assignment.State != "offered" && assignment.State != "delivery_unknown" {
		return LocalAssignment{}, failure("execution_intent_consumed")
	}
	encoded, _ := json.Marshal(identity)
	if _, err = tx.ExecContext(ctx, "UPDATE local_execution_assignments SET supervisor_json = ?, state = 'registered' WHERE intent_id = ? AND supervisor_json IS NULL", string(encoded), intent); err != nil {
		return LocalAssignment{}, failure("storage_failed")
	}
	if err = tx.Commit(); err != nil {
		return LocalAssignment{}, failure("storage_failed")
	}
	assignment.Supervisor, assignment.State = &identity, "registered"
	return assignment, nil
}

func (store *IntentStore) DeliveryUnknown(ctx context.Context, intent string) error {
	if !terminalIntent.MatchString(intent) {
		return failure("invalid_request")
	}
	_, err := store.db.ExecContext(ctx, "UPDATE local_execution_assignments SET state = 'delivery_unknown' WHERE intent_id = ? AND state = 'offered'", intent)
	if err != nil && !errors.Is(err, context.Canceled) {
		return failure("storage_failed")
	}
	return err
}
