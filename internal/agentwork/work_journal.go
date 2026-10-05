// ABOUTME: Atomically admits bounded immutable intents and exclusively claims their delivery attempts.
// ABOUTME: Checks every durable disposition while retaining irrevocable dispatch uncertainty.

package agentwork

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"time"

	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/protocol/generated"
)

const workRunUnresolvedLimit = 256
const workUnresolvedLimit = 1024
const workRetainedLimit = 10_000
const workClaimLimit = 16
const workClaimDuration = 30 * time.Second

var errWorkConflict = errors.New("agent work identity conflict")
var errWorkQuota = errors.New("agent work journal capacity reached")
var errWorkClaim = errors.New("agent work claim unavailable")
var errWorkCorrupt = errors.New("agent work history corrupt; effect unknown")
var errWorkInvalid = errors.New("agent work evidence invalid")

var workHexPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var workReasonPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

// Only the daemon's verified admission consumer constructs this evidence.
// Closed-schema checks below are not signature verification or current authority.
type journalIntent struct {
	OperationKey     string
	Fingerprint      string
	Tool             string
	RunID            string
	AdmissionMode    string
	RequestJSON      string
	ConfirmationJSON string
	CaptureJSON      string
}

type journalClaim struct {
	OperationKey string
	Token        string
	Incarnation  string
	Deadline     time.Duration
}

type journalRecord struct {
	Intent         journalIntent
	State          string
	Effect         string
	EverDispatched *time.Duration
	Reason         string
	OutcomeJSON    string
	ReceiptJSON    string
	Claim          *journalClaim
}

func journalCommand(tool string) (workCommand, bool) {
	for _, name := range []string{"agent_run.comment", "agent_run.update", "agent_run.progress", "agent_run.proposal"} {
		command, known := agentWorkCommand(name)
		if known && command.tool == tool {
			return command, true
		}
	}
	return workCommand{}, false
}

func validJournalOperationKey(key string) bool {
	return len(key) == 70 && key[:6] == "agent:" && workHexPattern.MatchString(key[6:])
}

func validateJournalRequest(intent journalIntent) error {
	command, known := journalCommand(intent.Tool)
	if !known || len(intent.RequestJSON) < 1 || len(intent.RequestJSON) > 16_384 ||
		!validJournalOperationKey(intent.OperationKey) ||
		!workHexPattern.MatchString(intent.Fingerprint) || !protocol.DecodeWireDocument(command.requestDocument, []byte(intent.RequestJSON)).OK {
		return errWorkInvalid
	}
	canonical, err := protocol.CanonicalAgentWriteRequest(command.name, []byte(intent.RequestJSON))
	if err != nil {
		return errWorkInvalid
	}
	digest := sha256.Sum256([]byte(canonical))
	if intent.Fingerprint != hex.EncodeToString(digest[:]) {
		return errWorkInvalid
	}
	var request struct {
		Reference generated.AgentWorkRequest `json:"reference"`
	}
	if json.Unmarshal([]byte(intent.RequestJSON), &request) != nil {
		return errWorkInvalid
	}
	key, err := agentOperationKey(command.name, request.Reference)
	if err != nil || key != intent.OperationKey {
		return errWorkInvalid
	}
	return nil
}

func validateJournalIntent(intent journalIntent) error {
	if validateJournalRequest(intent) != nil || len(intent.ConfirmationJSON) < 1 || len(intent.ConfirmationJSON) > 4096 ||
		len(intent.CaptureJSON) < 1 || len(intent.CaptureJSON) > 8192 ||
		!protocol.DecodeWireDocument("agent-capture-confirmation-result", []byte(intent.ConfirmationJSON)).OK ||
		!protocol.DecodeWireDocument("agent-work-capture", []byte(intent.CaptureJSON)).OK {
		return errWorkInvalid
	}
	var capture generated.AgentWorkCapture
	var confirmation generated.AgentCaptureConfirmationResult
	if json.Unmarshal([]byte(intent.CaptureJSON), &capture) != nil || json.Unmarshal([]byte(intent.ConfirmationJSON), &confirmation) != nil {
		return errWorkInvalid
	}
	left, err := json.Marshal(capture.Confirmation)
	if err != nil {
		return errWorkInvalid
	}
	right, err := json.Marshal(confirmation)
	if err != nil || string(left) != string(right) || capture.Confirmation.RunId != intent.RunID ||
		capture.AdmissionMode != intent.AdmissionMode || capture.Operation["operation_key"] != intent.OperationKey ||
		capture.Operation["payload_hash"] != "sha256:"+intent.Fingerprint || capture.Operation["tool"] != intent.Tool {
		return errWorkInvalid
	}
	var request struct {
		Reference generated.AgentWorkRequest      `json:"reference"`
		Binding   generated.AgentSessionReference `json:"binding"`
	}
	if json.Unmarshal([]byte(intent.RequestJSON), &request) != nil || request.Reference.RunExecutionId != confirmation.RunExecutionId ||
		request.Reference.AssignmentGeneration != confirmation.AssignmentGeneration || request.Binding != confirmation.Binding ||
		capture.Operation["request_id"] != request.Reference.RequestId || capture.Operation["operation_schema_version"] != float64(request.Reference.SchemaVersion) {
		return errWorkInvalid
	}
	command, _ := journalCommand(intent.Tool)
	var body map[string]any
	if json.Unmarshal([]byte(intent.RequestJSON), &body) != nil || capture.Operation["command_name"] != command.name {
		return errWorkInvalid
	}
	var expectedVersion, target, parent any
	if command.action == "update" {
		expectedVersion = body["expected_version"]
	}
	if command.action == "proposal" {
		parent = body["parent_task_id"]
	} else {
		target = confirmation.SourceTaskId
	}
	if capture.Operation["expected_version"] != expectedVersion || capture.Operation["target_task_id"] != target || capture.Operation["parent_task_id"] != parent {
		return errWorkInvalid
	}
	return nil
}

// admit checks an existing identity before quota and never refreshes its capture
// or mode. immediate atomically inserts the intent, first claim and dispatch
// marker; the caller sends nothing unless this transaction commits successfully.
func (journal *workJournal) admit(ctx context.Context, intent journalIntent, immediate bool) (journalRecord, bool, error) {
	if validateJournalRequest(intent) != nil {
		return journalRecord{}, false, errWorkInvalid
	}
	tx, err := journal.db.BeginTx(ctx, nil)
	if err != nil {
		return journalRecord{}, false, errWorkStorage
	}
	defer func() { _ = tx.Rollback() }()
	prior, found, err := lookupJournalRecord(ctx, tx, intent.OperationKey)
	if err != nil {
		return prior, false, err
	}
	if found {
		if prior.Intent.Fingerprint != intent.Fingerprint {
			return journalRecord{}, false, errWorkConflict
		}
		return prior, false, nil
	}
	if validateJournalIntent(intent) != nil || (!immediate && intent.AdmissionMode != "offline_admitted") {
		return journalRecord{}, false, errWorkInvalid
	}
	if err = journalCapacity(ctx, tx, intent.RunID); err != nil {
		return journalRecord{}, false, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO work_intents(operation_key,fingerprint,tool,run_id,admission_mode,request_json,confirmation_json,capture_json)
VALUES(?,?,?,?,?,?,?,?)`, intent.OperationKey, intent.Fingerprint, intent.Tool, intent.RunID, intent.AdmissionMode, intent.RequestJSON, intent.ConfirmationJSON, intent.CaptureJSON); err != nil {
		return journalRecord{}, false, errWorkStorage
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO work_delivery(operation_key,state,effect) VALUES(?,'open','never_sent')", intent.OperationKey); err != nil {
		return journalRecord{}, false, errWorkStorage
	}
	if immediate {
		claim, sample, err := journal.newClaim(intent.OperationKey)
		if err != nil {
			return journalRecord{}, false, err
		}
		if _, err = tx.ExecContext(ctx, `UPDATE work_delivery SET effect='unknown',ever_dispatched_ns=?,claim_token=?,claim_incarnation=?,claim_deadline_ns=? WHERE operation_key=?`,
			int64(sample), claim.Token, claim.Incarnation, int64(claim.Deadline), intent.OperationKey); err != nil {
			return journalRecord{}, false, errWorkStorage
		}
	}
	record, found, err := lookupJournalRecord(ctx, tx, intent.OperationKey)
	if err != nil || !found {
		return record, false, errWorkStorage
	}
	if tx.Commit() != nil {
		return journalRecord{}, false, errWorkStorage
	}
	return record, true, nil
}

func journalCapacity(ctx context.Context, tx *sql.Tx, runID string) error {
	var total, run, retained, legacy int
	if tx.QueryRowContext(ctx, `SELECT count(*),coalesce(sum(i.run_id=?),0) FROM work_intents i LEFT JOIN work_delivery d USING(operation_key)
WHERE d.operation_key IS NULL OR d.effect='unknown' OR d.state='open'`, runID).Scan(&total, &run) != nil ||
		tx.QueryRowContext(ctx, "SELECT count(*) FROM work_intents").Scan(&retained) != nil {
		return errWorkStorage
	}
	var legacyTotal, legacyRun int
	if tx.QueryRowContext(ctx, "SELECT count(*),coalesce(sum(run_id=?),0) FROM work_legacy_quarantine", runID).Scan(&legacyTotal, &legacyRun) != nil ||
		tx.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='pending_operations'").Scan(&legacy) != nil {
		return errWorkStorage
	}
	if legacy == 1 {
		var legacyRetained, oversized int
		if tx.QueryRowContext(ctx, `SELECT count(*),coalesce(max(
length(CAST(request_id || tool || workspace_id || project_id || task_id || run_id || runner_id || checkout_id || execution_id ||
observed_session_id || principal || grant_name || payload_hash || payload_json || capture_proof || captured_at || expires_at ||
policy_decision || state || coalesce(outcome_json,'') AS BLOB)) > 32768),0) FROM pending_operations`).Scan(&legacyRetained, &oversized) != nil {
			return errWorkStorage
		}
		// Preserve oversized historical bytes. They cannot silently consume an
		// unbounded admission budget or be trimmed into supposedly valid evidence.
		if oversized != 0 {
			return errWorkQuota
		}
		retained += legacyRetained
	}
	if total+legacyTotal >= workUnresolvedLimit || run+legacyRun >= workRunUnresolvedLimit || retained >= workRetainedLimit {
		return errWorkQuota
	}
	return nil
}

type workRowScanner interface{ Scan(...any) error }

func lookupJournalRecord(ctx context.Context, db workSchemaReader, key string) (journalRecord, bool, error) {
	row := db.QueryRowContext(ctx, `SELECT i.operation_key,i.fingerprint,i.tool,i.run_id,i.admission_mode,i.request_json,i.confirmation_json,i.capture_json,
d.state,d.effect,d.ever_dispatched_ns,d.reason_code,d.outcome_json,d.receipt_json,d.claim_token,d.claim_incarnation,d.claim_deadline_ns
FROM work_intents i LEFT JOIN work_delivery d USING(operation_key) WHERE i.operation_key=?`, key)
	return scanJournalRecord(row)
}

func scanJournalRecord(row workRowScanner) (journalRecord, bool, error) {
	// Corruption is projected as unknown without repairing the row. In particular
	// a missing delivery record is never reinserted as never-sent; callers stop
	// on errWorkCorrupt. Only legacy quarantine has startup-migration writes.
	var record journalRecord
	var state, effect, reason, outcome, receipt, token, incarnation sql.NullString
	var dispatched, deadline sql.NullInt64
	if err := row.Scan(&record.Intent.OperationKey, &record.Intent.Fingerprint, &record.Intent.Tool, &record.Intent.RunID,
		&record.Intent.AdmissionMode, &record.Intent.RequestJSON, &record.Intent.ConfirmationJSON, &record.Intent.CaptureJSON,
		&state, &effect, &dispatched, &reason, &outcome, &receipt, &token, &incarnation, &deadline); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return record, false, nil
		}
		return record, false, errWorkStorage
	}
	record.State, record.Effect, record.Reason, record.OutcomeJSON, record.ReceiptJSON = state.String, effect.String, reason.String, outcome.String, receipt.String
	if dispatched.Valid {
		sample := time.Duration(dispatched.Int64)
		record.EverDispatched = &sample
	}
	if token.Valid && incarnation.Valid && deadline.Valid {
		record.Claim = &journalClaim{record.Intent.OperationKey, token.String, incarnation.String, time.Duration(deadline.Int64)}
	}
	if validateJournalIntent(record.Intent) != nil || !state.Valid || !validJournalDisposition(record) || (record.State != "open" && record.ReceiptJSON == "") ||
		(token.Valid || incarnation.Valid || deadline.Valid) && (record.Claim == nil || !workHexPattern.MatchString(token.String) || !workHexPattern.MatchString(incarnation.String) || deadline.Int64 < 0 || record.State != "open") {
		record.State, record.Effect, record.Reason, record.OutcomeJSON, record.ReceiptJSON, record.Claim = "quarantined", "unknown", "storage_corrupt", "", "", nil
		return record, true, errWorkCorrupt
	}
	if record.ReceiptJSON != "" {
		copy := record
		copy.ReceiptJSON = ""
		expected, err := journalReceipt(copy)
		if err != nil || expected != record.ReceiptJSON {
			record.State, record.Effect, record.Reason, record.OutcomeJSON, record.ReceiptJSON, record.Claim = "quarantined", "unknown", "storage_corrupt", "", "", nil
			return record, true, errWorkCorrupt
		}
	}
	return record, true, nil
}

func validJournalDisposition(record journalRecord) bool {
	if record.EverDispatched != nil && *record.EverDispatched < 0 {
		return false
	}
	command, _ := journalCommand(record.Intent.Tool)
	if record.OutcomeJSON != "" && (len(record.OutcomeJSON) > 16_384 || !protocol.DecodeWireDocument(command.resultDocument, []byte(record.OutcomeJSON)).OK) {
		return false
	}
	if record.OutcomeJSON != "" && !journalOutcomeBound(record.Intent, record.OutcomeJSON) {
		return false
	}
	if record.ReceiptJSON != "" && (len(record.ReceiptJSON) > 2048 || !protocol.DecodeWireDocument("agent-work-receipt", []byte(record.ReceiptJSON)).OK) {
		return false
	}
	switch record.State {
	case "open":
		return record.Reason == "" && record.OutcomeJSON == "" && ((record.Effect == "never_sent" && record.EverDispatched == nil) || (record.Effect == "unknown" && record.EverDispatched != nil))
	case "applied":
		return record.Reason == "" && record.Effect == "applied" && record.EverDispatched != nil && record.OutcomeJSON != ""
	case "blocked":
		return workReasonPattern.MatchString(record.Reason) && record.OutcomeJSON == "" && ((record.Effect == "never_sent" && record.EverDispatched == nil) || (record.Effect == "unknown" && record.EverDispatched != nil))
	case "quarantined":
		return workReasonPattern.MatchString(record.Reason) && record.Effect == "unknown" && record.OutcomeJSON == ""
	}
	return false
}

// lookup is internal evidence only. A consumer must verify current authority
// before exposing any receipt or private committed outcome.
func (journal *workJournal) lookup(ctx context.Context, key string) (journalRecord, bool, error) {
	return lookupJournalRecord(ctx, journal.db, key)
}

func (journal *workJournal) sample() (time.Duration, error) {
	journal.mu.Lock()
	defer journal.mu.Unlock()
	if journal.clockError != nil {
		return 0, journal.clockError
	}
	sample, err := journal.clock()
	if err != nil || sample < 0 || journal.hasSample && sample < journal.last {
		journal.clockError = errWorkStorage
		return 0, journal.clockError
	}
	journal.last, journal.hasSample = sample, true
	return sample, nil
}

func (journal *workJournal) newClaim(key string) (journalClaim, time.Duration, error) {
	sample, err := journal.sample()
	if err != nil || sample > time.Duration(math.MaxInt64)-workClaimDuration {
		journal.mu.Lock()
		journal.clockError = errWorkStorage
		journal.mu.Unlock()
		return journalClaim{}, 0, errWorkStorage
	}
	token, err := workRandomIdentity()
	if err != nil {
		return journalClaim{}, 0, err
	}
	return journalClaim{key, token, journal.incarnation, sample + workClaimDuration}, sample, nil
}

// Claim bookkeeping grants neither replay authority nor trusted expiry time.
// The consumer checks those independently before markDispatch/network send.
func (journal *workJournal) claimBatch(ctx context.Context, limit int) ([]journalRecord, error) {
	return journal.claimBatchAfter(ctx, "", limit)
}

// The consumer keeps an ephemeral keyset cursor and explicitly resets it after
// an exhausted batch. Cursor position is fairness bookkeeping, not authority,
// a durable claim, or permission to select an online-only operation.
func (journal *workJournal) claimBatchAfter(ctx context.Context, afterKey string, limit int) ([]journalRecord, error) {
	if limit < 1 || limit > workClaimLimit || (afterKey != "" && !validJournalOperationKey(afterKey)) {
		return nil, errWorkInvalid
	}
	return journal.claim(ctx, "", afterKey, limit)
}

// claimOperation supports a currently authorized explicit retry of an online-
// only identity. Such rows are never selected by the autonomous batch path.
func (journal *workJournal) claimOperation(ctx context.Context, key string) (journalRecord, error) {
	rows, err := journal.claim(ctx, key, "", 1)
	if err != nil {
		return journalRecord{}, err
	}
	if len(rows) != 1 {
		return journalRecord{}, errWorkClaim
	}
	return rows[0], nil
}

func (journal *workJournal) claim(ctx context.Context, key, afterKey string, limit int) ([]journalRecord, error) {
	tx, err := journal.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, errWorkStorage
	}
	defer func() { _ = tx.Rollback() }()
	var missing int
	if tx.QueryRowContext(ctx, "SELECT count(*) FROM work_intents i LEFT JOIN work_delivery d USING(operation_key) WHERE d.operation_key IS NULL").Scan(&missing) != nil {
		return nil, errWorkStorage
	}
	if missing != 0 {
		return nil, errWorkCorrupt
	}
	sample, err := journal.sample()
	if err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT i.operation_key FROM work_intents i JOIN work_delivery d USING(operation_key)
WHERE d.state='open' AND (d.claim_token IS NULL OR d.claim_incarnation!=? OR d.claim_deadline_ns<=?)
AND ((?='' AND i.admission_mode='offline_admitted' AND i.operation_key>?) OR i.operation_key=?) ORDER BY i.operation_key LIMIT ?`, journal.incarnation, int64(sample), key, afterKey, key, limit)
	if err != nil {
		return nil, errWorkStorage
	}
	var keys []string
	for rows.Next() {
		var key string
		if rows.Scan(&key) != nil {
			_ = rows.Close()
			return nil, errWorkStorage
		}
		keys = append(keys, key)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, errWorkStorage
	}
	records := make([]journalRecord, 0, len(keys))
	for _, key := range keys {
		if _, found, err := lookupJournalRecord(ctx, tx, key); err != nil || !found {
			if err != nil {
				return nil, err
			}
			return nil, errWorkCorrupt
		}
		claim, _, err := journal.newClaim(key)
		if err != nil {
			return nil, err
		}
		result, err := tx.ExecContext(ctx, "UPDATE work_delivery SET claim_token=?,claim_incarnation=?,claim_deadline_ns=? WHERE operation_key=? AND state='open'", claim.Token, claim.Incarnation, int64(claim.Deadline), key)
		if err != nil || !workOneRow(result) {
			return nil, errWorkStorage
		}
		record, found, err := lookupJournalRecord(ctx, tx, key)
		if err != nil || !found {
			return nil, errWorkCorrupt
		}
		records = append(records, record)
	}
	if tx.Commit() != nil {
		return nil, errWorkStorage
	}
	return records, nil
}

func workOneRow(result sql.Result) bool {
	if result == nil {
		return false
	}
	count, err := result.RowsAffected()
	return err == nil && count == 1
}

func (journal *workJournal) claimCurrent(claim journalClaim) (time.Duration, error) {
	sample, err := journal.sample()
	if err != nil {
		return 0, err
	}
	if claim.Incarnation != journal.incarnation || !workHexPattern.MatchString(claim.Token) || sample >= claim.Deadline {
		return 0, errWorkClaim
	}
	return sample, nil
}

func (journal *workJournal) markDispatch(ctx context.Context, claim journalClaim) error {
	tx, err := journal.db.BeginTx(ctx, nil)
	if err != nil {
		return errWorkStorage
	}
	defer func() { _ = tx.Rollback() }()
	sample, err := journal.claimCurrent(claim)
	if err != nil {
		return err
	}
	record, found, err := lookupJournalRecord(ctx, tx, claim.OperationKey)
	if err != nil {
		return err
	}
	if !found || record.State != "open" {
		return errWorkClaim
	}
	result, err := tx.ExecContext(ctx, `UPDATE work_delivery SET effect='unknown',ever_dispatched_ns=coalesce(ever_dispatched_ns,?)
WHERE operation_key=? AND state='open' AND claim_token=? AND claim_incarnation=? AND claim_deadline_ns=?`, int64(sample), claim.OperationKey, claim.Token, claim.Incarnation, int64(claim.Deadline))
	if err != nil {
		return errWorkStorage
	}
	if !workOneRow(result) {
		return errWorkClaim
	}
	if tx.Commit() != nil {
		return errWorkStorage
	}
	return nil
}

func (journal *workJournal) acknowledge(ctx context.Context, claim journalClaim, outcome string) error {
	if outcome == "" {
		return errWorkInvalid
	}
	return journal.finish(ctx, claim, outcome, "")
}

func (journal *workJournal) block(ctx context.Context, claim journalClaim, reason string) error {
	if !workReasonPattern.MatchString(reason) {
		return errWorkInvalid
	}
	return journal.finish(ctx, claim, "", reason)
}

func (journal *workJournal) finish(ctx context.Context, claim journalClaim, outcome, reason string) error {
	tx, err := journal.db.BeginTx(ctx, nil)
	if err != nil {
		return errWorkStorage
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = journal.claimCurrent(claim); err != nil {
		return err
	}
	record, found, err := lookupJournalRecord(ctx, tx, claim.OperationKey)
	if err != nil {
		return err
	}
	if !found || record.State != "open" || record.Claim == nil || *record.Claim != claim {
		return errWorkClaim
	}
	state, effect := "blocked", record.Effect
	var outcomeValue any
	if outcome != "" {
		command, _ := journalCommand(record.Intent.Tool)
		if len(outcome) > 16_384 || !protocol.DecodeWireDocument(command.resultDocument, []byte(outcome)).OK || record.EverDispatched == nil {
			return errWorkInvalid
		}
		if !journalOutcomeBound(record.Intent, outcome) {
			return errWorkInvalid
		}
		state, effect, outcomeValue = "applied", "applied", outcome
	}
	record.State, record.Effect, record.Reason, record.OutcomeJSON = state, effect, reason, outcome
	receipt, err := journalReceipt(record)
	if err != nil {
		return err
	}
	var reasonValue any
	if reason != "" {
		reasonValue = reason
	}
	result, err := tx.ExecContext(ctx, `UPDATE work_delivery SET state=?,effect=?,reason_code=?,outcome_json=?,receipt_json=?,claim_token=NULL,claim_incarnation=NULL,claim_deadline_ns=NULL
WHERE operation_key=? AND state='open' AND claim_token=? AND claim_incarnation=? AND claim_deadline_ns=?`, state, effect, reasonValue, outcomeValue, receipt, claim.OperationKey, claim.Token, claim.Incarnation, int64(claim.Deadline))
	if err != nil {
		return errWorkStorage
	}
	if !workOneRow(result) {
		return errWorkClaim
	}
	if tx.Commit() != nil {
		return errWorkStorage
	}
	return nil
}

func journalOutcomeBound(intent journalIntent, outcome string) bool {
	var capture generated.AgentWorkCapture
	var result struct {
		Origin generated.AgentEffectOrigin `json:"origin"`
	}
	return json.Unmarshal([]byte(intent.CaptureJSON), &capture) == nil && json.Unmarshal([]byte(outcome), &result) == nil &&
		result.Origin.RunId == capture.Confirmation.RunId && result.Origin.RunExecutionId == capture.Confirmation.RunExecutionId &&
		result.Origin.AssignmentGeneration == capture.Confirmation.AssignmentGeneration && result.Origin.ProviderSessionId == capture.Confirmation.Binding.ProviderSessionId
}

// A transient failure releases only this claim; uncertainty and the original
// dispatch marker remain. No release upgrades online-only replay permission.
func (journal *workJournal) release(ctx context.Context, claim journalClaim) error {
	tx, err := journal.db.BeginTx(ctx, nil)
	if err != nil {
		return errWorkStorage
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = journal.claimCurrent(claim); err != nil {
		return err
	}
	if _, found, err := lookupJournalRecord(ctx, tx, claim.OperationKey); err != nil || !found {
		if err != nil {
			return err
		}
		return errWorkClaim
	}
	result, err := tx.ExecContext(ctx, `UPDATE work_delivery SET claim_token=NULL,claim_incarnation=NULL,claim_deadline_ns=NULL
WHERE operation_key=? AND state='open' AND claim_token=? AND claim_incarnation=? AND claim_deadline_ns=?`, claim.OperationKey, claim.Token, claim.Incarnation, int64(claim.Deadline))
	if err != nil {
		return errWorkStorage
	}
	if !workOneRow(result) {
		return errWorkClaim
	}
	if tx.Commit() != nil {
		return errWorkStorage
	}
	return nil
}

func journalReceipt(record journalRecord) (string, error) {
	if !validJournalDisposition(record) {
		return "", errWorkCorrupt
	}
	var capture generated.AgentWorkCapture
	if json.Unmarshal([]byte(record.Intent.CaptureJSON), &capture) != nil {
		return "", errWorkCorrupt
	}
	requestID, ok := capture.Operation["request_id"].(string)
	if !ok {
		return "", errWorkCorrupt
	}
	state, effect := "pending_sync", "not_attempted"
	var reason *string
	if record.Effect == "unknown" {
		effect = "possibly_applied"
	}
	switch record.State {
	case "applied":
		state, effect = "applied", "confirmed"
	case "blocked", "quarantined":
		state = "delivery_blocked"
		if record.Effect == "never_sent" {
			state = "rejected"
		}
		value := record.Reason
		reason = &value
	}
	if record.State == "open" && record.Intent.AdmissionMode == "online_only" {
		state = "delivery_blocked"
		value := "work_unavailable"
		reason = &value
	}
	encoded, err := json.Marshal(generated.AgentWorkReceipt{SchemaVersion: 1, OperationKey: record.Intent.OperationKey, RequestId: requestID, Tool: record.Intent.Tool,
		AdmissionMode: record.Intent.AdmissionMode, DeliveryState: state, EffectCertainty: effect, CapturedAt: capture.CapturedAt, IntentExpiresAt: capture.IntentExpiresAt, ReasonCode: reason})
	if err != nil || len(encoded) > 2048 || !protocol.DecodeWireDocument("agent-work-receipt", encoded).OK {
		return "", errWorkInvalid
	}
	return string(encoded), nil
}
