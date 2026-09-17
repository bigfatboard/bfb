// ABOUTME: Persists policy-permitted offline mutations with full replay evidence in journal 011.
// ABOUTME: Replays through the L08 transport only after rechecking authority, policy, and versions.

package localmcp

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"os"
	"syscall"
	"time"
)

//go:embed migrations/011_pending_operations.sql
var pendingMigration string

// PendingOperation is one durable offline business mutation. Every field the
// scope requires is persisted: originating principal/grant, immutable
// assignment/session binding, request identity, expected version, payload
// hash, capture proof, capture/expiry times, and the policy decision.
type PendingOperation struct {
	RequestID       string
	Tool            string
	Boundary        Boundary
	SessionID       string
	Principal       string
	Grant           string
	ExpectedVersion int64
	PayloadHash     string
	PayloadJSON     string
	CaptureProof    string
	CapturedAt      string
	ExpiresAt       string
	PolicyDecision  string
	State           string
	OutcomeJSON     string
}

// Journal is the durable pending-operation store. Store is idempotent on
// request_id: a repeated Store reports stored=false and keeps the original.
type Journal interface {
	Store(operation PendingOperation) (bool, error)
	Pending(requestID string) (PendingOperation, bool, error)
	Outcome(requestID string) (result any, code string, ok bool, err error)
	CountForRun(runID string) (int, error)
	ClaimReplayBatch(limit int) ([]PendingOperation, error)
	MarkApplied(requestID string, outcomeJSON string) error
	MarkRejected(requestID string, reason string) error
	Close() error
}

// SQLiteJournal is the file-backed Journal. The file is user-only (0600);
// opening a group/world-accessible or foreign-owned file fails closed.
type SQLiteJournal struct{ db *sql.DB }

func journalFileSafe(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fail("storage_failed")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) || info.Mode().Perm()&0077 != 0 {
		return fail("unsafe_state")
	}
	return nil
}

// OpenJournal opens (creating when absent) the A01 pending-operation journal
// at path and applies local migration 011. It never touches L06 hook state.
func OpenJournal(path string) (*SQLiteJournal, error) {
	if err := journalFileSafe(path); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, fail("storage_failed")
	}
	_ = file.Close()
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=synchronous(FULL)")
	if err != nil {
		return nil, fail("storage_failed")
	}
	db.SetMaxOpenConns(1)
	failed := true
	defer func() {
		if failed {
			_ = db.Close()
		}
	}()
	var check string
	if err = db.QueryRow("PRAGMA quick_check").Scan(&check); err != nil || check != "ok" {
		return nil, fail("storage_failed")
	}
	if err = db.QueryRow("PRAGMA journal_mode=WAL").Scan(&check); err != nil || check != "wal" {
		return nil, fail("storage_failed")
	}
	if _, err = db.Exec(pendingMigration); err != nil {
		return nil, fail("storage_failed")
	}
	var version int
	if err = db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return nil, fail("storage_failed")
	}
	if version != 0 && version != 11 && version != 12 {
		return nil, fail("migration_mismatch")
	}
	if version == 11 {
		if err = widenJournalTools(db); err != nil {
			return nil, fail("storage_failed")
		}
	}
	if _, err = db.Exec("PRAGMA user_version=12"); err != nil {
		return nil, fail("storage_failed")
	}
	failed = false
	return &SQLiteJournal{db: db}, nil
}

// widenJournalTools rebuilds a version-11 journal whose tool CHECK predates
// result submission. Rows are preserved; only the CHECK widens. New files
// already carry the wide CHECK from migration 011.
func widenJournalTools(db *sql.DB) error {
	if _, err := db.Exec(`CREATE TABLE pending_operations_a03 (
    request_id TEXT PRIMARY KEY,
    tool TEXT NOT NULL CHECK (tool IN ('bfb_update_task', 'bfb_add_comment', 'bfb_report_progress', 'bfb_propose_task', 'bfb_submit_result')),
    workspace_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    runner_id TEXT NOT NULL,
    checkout_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    assignment_generation INTEGER NOT NULL CHECK (assignment_generation >= 1),
    observed_session_id TEXT NOT NULL,
    principal TEXT NOT NULL,
    grant_name TEXT NOT NULL,
    expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
    payload_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    capture_proof TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    policy_decision TEXT NOT NULL CHECK (policy_decision = 'pending_sync'),
    state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'rejected')),
    outcome_json TEXT
) STRICT`); err != nil {
		return err
	}
	if _, err := db.Exec(`INSERT INTO pending_operations_a03
(request_id, tool, workspace_id, project_id, task_id, run_id, runner_id, checkout_id,
 execution_id, assignment_generation, observed_session_id, principal, grant_name,
 expected_version, payload_hash, payload_json, capture_proof, captured_at, expires_at,
 policy_decision, state, outcome_json)
SELECT request_id, tool, workspace_id, project_id, task_id, run_id, runner_id, checkout_id,
 execution_id, assignment_generation, observed_session_id, principal, grant_name,
 expected_version, payload_hash, payload_json, capture_proof, captured_at, expires_at,
 policy_decision, state, outcome_json FROM pending_operations`); err != nil {
		return err
	}
	if _, err := db.Exec(`DROP TABLE pending_operations`); err != nil {
		return err
	}
	if _, err := db.Exec(`ALTER TABLE pending_operations_a03 RENAME TO pending_operations`); err != nil {
		return err
	}
	_, err := db.Exec(`CREATE INDEX IF NOT EXISTS pending_operations_run_state
    ON pending_operations (run_id, state, captured_at)`)
	return err
}

func (journal *SQLiteJournal) Close() error { return journal.db.Close() }

func (journal *SQLiteJournal) Store(operation PendingOperation) (bool, error) {
	result, err := journal.db.Exec(`INSERT INTO pending_operations
(request_id, tool, workspace_id, project_id, task_id, run_id, runner_id, checkout_id,
 execution_id, assignment_generation, observed_session_id, principal, grant_name,
 expected_version, payload_hash, payload_json, capture_proof, captured_at, expires_at,
 policy_decision, state, outcome_json)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending', NULL)
ON CONFLICT(request_id) DO NOTHING`,
		operation.RequestID, operation.Tool,
		operation.Boundary.WorkspaceID, operation.Boundary.ProjectID, operation.Boundary.TaskID,
		operation.Boundary.RunID, operation.Boundary.RunnerID, operation.Boundary.CheckoutID,
		operation.Boundary.ExecutionID, operation.Boundary.Generation,
		operation.SessionID, operation.Principal, operation.Grant,
		operation.ExpectedVersion, operation.PayloadHash, operation.PayloadJSON,
		operation.CaptureProof, operation.CapturedAt, operation.ExpiresAt, operation.PolicyDecision)
	if err != nil {
		return false, fail("storage_failed")
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, fail("storage_failed")
	}
	return affected == 1, nil
}

func scanOperation(row *sql.Row) (PendingOperation, error) {
	var operation PendingOperation
	var generation int64
	err := row.Scan(&operation.RequestID, &operation.Tool,
		&operation.Boundary.WorkspaceID, &operation.Boundary.ProjectID, &operation.Boundary.TaskID,
		&operation.Boundary.RunID, &operation.Boundary.RunnerID, &operation.Boundary.CheckoutID,
		&operation.Boundary.ExecutionID, &generation,
		&operation.SessionID, &operation.Principal, &operation.Grant,
		&operation.ExpectedVersion, &operation.PayloadHash, &operation.PayloadJSON,
		&operation.CaptureProof, &operation.CapturedAt, &operation.ExpiresAt,
		&operation.PolicyDecision, &operation.State, &operation.OutcomeJSON)
	if err == sql.ErrNoRows {
		return PendingOperation{}, sql.ErrNoRows
	}
	if err != nil {
		return PendingOperation{}, fail("storage_failed")
	}
	operation.Boundary.Generation = generation
	return operation, nil
}

func (journal *SQLiteJournal) Pending(requestID string) (PendingOperation, bool, error) {
	operation, err := scanOperation(journal.db.QueryRow(
		`SELECT request_id, tool, workspace_id, project_id, task_id, run_id, runner_id, checkout_id,
execution_id, assignment_generation, observed_session_id, principal, grant_name,
expected_version, payload_hash, payload_json, capture_proof, captured_at, expires_at,
policy_decision, state, COALESCE(outcome_json, '')
FROM pending_operations WHERE request_id = ? AND state = 'pending'`, requestID))
	if err == sql.ErrNoRows {
		return PendingOperation{}, false, nil
	}
	if err != nil {
		return PendingOperation{}, false, err
	}
	return operation, true, nil
}

// Outcome returns the terminal result of an applied or rejected operation:
// applied yields its decoded outcome, rejected yields its reason code.
func (journal *SQLiteJournal) Outcome(requestID string) (any, string, bool, error) {
	operation, err := scanOperation(journal.db.QueryRow(
		`SELECT request_id, tool, workspace_id, project_id, task_id, run_id, runner_id, checkout_id,
execution_id, assignment_generation, observed_session_id, principal, grant_name,
expected_version, payload_hash, payload_json, capture_proof, captured_at, expires_at,
policy_decision, state, COALESCE(outcome_json, '')
FROM pending_operations WHERE request_id = ? AND state != 'pending'`, requestID))
	if err == sql.ErrNoRows {
		return nil, "", false, nil
	}
	if err != nil {
		return nil, "", false, err
	}
	if operation.State == "applied" {
		var result any
		if err := json.Unmarshal([]byte(operation.OutcomeJSON), &result); err != nil {
			return nil, "", false, fail("storage_failed")
		}
		return result, "", true, nil
	}
	return nil, operation.OutcomeJSON, true, nil
}

func (journal *SQLiteJournal) CountForRun(runID string) (int, error) {
	var count int
	if err := journal.db.QueryRow(
		`SELECT COUNT(*) FROM pending_operations WHERE run_id = ? AND state = 'pending'`, runID).Scan(&count); err != nil {
		return 0, fail("storage_failed")
	}
	return count, nil
}

func (journal *SQLiteJournal) ClaimReplayBatch(limit int) ([]PendingOperation, error) {
	rows, err := journal.db.Query(
		`SELECT request_id, tool, workspace_id, project_id, task_id, run_id, runner_id, checkout_id,
execution_id, assignment_generation, observed_session_id, principal, grant_name,
expected_version, payload_hash, payload_json, capture_proof, captured_at, expires_at,
policy_decision, state, COALESCE(outcome_json, '')
FROM pending_operations WHERE state = 'pending' ORDER BY captured_at ASC, request_id ASC LIMIT ?`, limit)
	if err != nil {
		return nil, fail("storage_failed")
	}
	defer rows.Close()
	var operations []PendingOperation
	for rows.Next() {
		var operation PendingOperation
		var generation int64
		if err := rows.Scan(&operation.RequestID, &operation.Tool,
			&operation.Boundary.WorkspaceID, &operation.Boundary.ProjectID, &operation.Boundary.TaskID,
			&operation.Boundary.RunID, &operation.Boundary.RunnerID, &operation.Boundary.CheckoutID,
			&operation.Boundary.ExecutionID, &generation,
			&operation.SessionID, &operation.Principal, &operation.Grant,
			&operation.ExpectedVersion, &operation.PayloadHash, &operation.PayloadJSON,
			&operation.CaptureProof, &operation.CapturedAt, &operation.ExpiresAt,
			&operation.PolicyDecision, &operation.State, &operation.OutcomeJSON); err != nil {
			return nil, fail("storage_failed")
		}
		operation.Boundary.Generation = generation
		operations = append(operations, operation)
	}
	if err := rows.Err(); err != nil {
		return nil, fail("storage_failed")
	}
	return operations, nil
}

func (journal *SQLiteJournal) MarkApplied(requestID string, outcomeJSON string) error {
	result, err := journal.db.Exec(
		`UPDATE pending_operations SET state = 'applied', outcome_json = ? WHERE request_id = ? AND state = 'pending'`,
		outcomeJSON, requestID)
	if err != nil {
		return fail("storage_failed")
	}
	affected, err := result.RowsAffected()
	if err != nil || affected != 1 {
		return fail("storage_failed")
	}
	return nil
}

func (journal *SQLiteJournal) MarkRejected(requestID string, reason string) error {
	result, err := journal.db.Exec(
		`UPDATE pending_operations SET state = 'rejected', outcome_json = ? WHERE request_id = ? AND state = 'pending'`,
		reason, requestID)
	if err != nil {
		return fail("storage_failed")
	}
	affected, err := result.RowsAffected()
	if err != nil || affected != 1 {
		return fail("storage_failed")
	}
	return nil
}

// ReplayPolicy reports whether current project policy still permits replaying
// a journaled tool. Production consults cloud policy through L08; tests fake it.
type ReplayPolicy interface {
	CurrentAllow(ctx context.Context, tool string, boundary Boundary) bool
}

// ReplayResult is the terminal disposition of one replayed operation.
type ReplayResult struct {
	RequestID   string `json:"request_id"`
	Tool        string `json:"tool"`
	Disposition string `json:"disposition"`
	Reason      string `json:"reason,omitempty"`
}

// Replay replays pending operations through the transport, rechecking capture
// proof, expiry, current authority, current policy, and resource version in
// that order. Stale operations become visible terminal rejections; transport
// failures that are not terminal leave the record pending for a later replay.
// Replay is idempotent: applied/rejected records are never re-executed.
func Replay(ctx context.Context, journal Journal, transport WorkTransport, authority AuthoritySource, policy ReplayPolicy, now time.Time, limit int) ([]ReplayResult, error) {
	operations, err := journal.ClaimReplayBatch(limit)
	if err != nil {
		return nil, err
	}
	results := make([]ReplayResult, 0, len(operations))
	for _, operation := range operations {
		result := replayOne(ctx, journal, transport, authority, policy, now, operation)
		results = append(results, result)
	}
	return results, nil
}

func replayOne(ctx context.Context, journal Journal, transport WorkTransport, authority AuthoritySource, policy ReplayPolicy, now time.Time, operation PendingOperation) ReplayResult {
	outcome := ReplayResult{RequestID: operation.RequestID, Tool: operation.Tool, Disposition: "applied"}
	reject := func(reason string) ReplayResult {
		_ = journal.MarkRejected(operation.RequestID, reason)
		outcome.Disposition = "rejected"
		outcome.Reason = reason
		return outcome
	}
	if captureProof(operation) != operation.CaptureProof || hashHex([]byte(operation.PayloadJSON)) != operation.PayloadHash {
		return reject("capture_invalid")
	}
	expires, err := time.Parse(time.RFC3339Nano, operation.ExpiresAt)
	if err != nil || !now.Before(expires) {
		return reject("expired")
	}
	state, err := authority.Current(ctx, operation.Boundary)
	if err != nil {
		outcome.Disposition = "retryable"
		outcome.Reason = "authority_unavailable"
		return outcome
	}
	switch {
	case state.Revoked:
		return reject("revoked")
	case state.ExecutionEnded:
		return reject("execution_ended")
	case state.ResultTerminal:
		return reject("result_terminal")
	}
	if !policy.CurrentAllow(ctx, operation.Tool, operation.Boundary) {
		return reject("policy_changed")
	}
	var payload struct {
		Tool  string         `json:"tool"`
		Input map[string]any `json:"input"`
	}
	if err := json.Unmarshal([]byte(operation.PayloadJSON), &payload); err != nil || payload.Tool != operation.Tool {
		return reject("payload_invalid")
	}
	executed, terminal, reason := executeReplay(ctx, transport, operation, payload.Input)
	if executed == nil {
		if terminal {
			return reject(reason)
		}
		outcome.Disposition = "retryable"
		outcome.Reason = reason
		return outcome
	}
	encoded, err := json.Marshal(executed)
	if err != nil {
		outcome.Disposition = "retryable"
		outcome.Reason = "outcome_encode"
		return outcome
	}
	_ = journal.MarkApplied(operation.RequestID, string(encoded))
	return outcome
}

// executeReplay re-runs one journaled mutation with its original request_id
// so transport-side idempotency returns the first outcome instead of
// duplicating the effect. It reports (result, terminal, reason); result is
// nil if and only if the effect did not execute, because every successful
// transport outcome is a non-empty struct value.
func executeReplay(ctx context.Context, transport WorkTransport, operation PendingOperation, input map[string]any) (any, bool, string) {
	boundary := operation.Boundary
	requestID := operation.RequestID
	switch operation.Tool {
	case "bfb_add_comment":
		body, _ := input["body"].(string)
		result, err := transport.AddComment(ctx, boundary, body, requestID)
		return replayEffect(result, err)
	case "bfb_report_progress":
		summary, _ := input["summary"].(string)
		var percent, confidence *float64
		if raw, ok := input["percent"].(float64); ok {
			percent = &raw
		}
		if raw, ok := input["confidence"].(float64); ok {
			confidence = &raw
		}
		result, err := transport.ReportProgress(ctx, boundary, summary, percent, confidence, requestID)
		return replayEffect(result, err)
	case "bfb_update_task":
		restored, err := restoreUpdate(input, operation.ExpectedVersion)
		if err != nil {
			return nil, true, "payload_invalid"
		}
		result, callErr := transport.UpdateTask(ctx, boundary, restored, requestID)
		return replayEffect(result, callErr)
	case "bfb_propose_task":
		restored, err := restorePropose(input)
		if err != nil {
			return nil, true, "payload_invalid"
		}
		result, callErr := transport.ProposeTask(ctx, boundary, restored, requestID)
		return replayEffect(result, callErr)
	case "bfb_submit_result":
		restored, err := restoreSubmit(input)
		if err != nil {
			return nil, true, "payload_invalid"
		}
		result, callErr := transport.SubmitResult(ctx, boundary, restored, requestID)
		return replayEffect(result, callErr)
	default:
		return nil, true, "payload_invalid"
	}
}

func replayEffect(result any, err error) (any, bool, string) {
	if err == nil {
		return result, false, ""
	}
	switch CodeOf(err) {
	case "stale_version":
		return nil, true, "stale_version"
	case "forbidden", "policy_rejected", "boundary_escape":
		return nil, true, CodeOf(err)
	default:
		return nil, false, CodeOf(err)
	}
}

func restoreUpdate(input map[string]any, expected int64) (UpdateTaskInput, error) {
	restored := UpdateTaskInput{ExpectedVersion: expected}
	if raw, present := input["title"]; present {
		title, ok := raw.(string)
		if !ok {
			return restored, fail("payload_invalid")
		}
		restored.Title = &title
	}
	if raw, present := input["punchline"]; present {
		punchline, ok := raw.(string)
		if !ok {
			return restored, fail("payload_invalid")
		}
		restored.Punchline = &punchline
	}
	return restored, nil
}

func restorePropose(input map[string]any) (ProposeTaskInput, error) {
	restored := ProposeTaskInput{Priority: "P2"}
	title, ok := input["title"].(string)
	if !ok || title == "" {
		return restored, fail("payload_invalid")
	}
	restored.Title = title
	if raw, present := input["priority"]; present {
		priority, ok := raw.(string)
		if !ok {
			return restored, fail("payload_invalid")
		}
		restored.Priority = priority
	}
	if raw, present := input["parent_task_id"]; present {
		parent, ok := raw.(string)
		if !ok {
			return restored, fail("payload_invalid")
		}
		restored.ParentTaskID = &parent
	}
	return restored, nil
}
