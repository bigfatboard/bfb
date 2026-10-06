-- ABOUTME: Stores separate protected task and result captures under one bounded delivery journal.
-- ABOUTME: Preserves immutable admission evidence and irreversible dispatch history across both families.

CREATE TABLE work_journal_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    identity TEXT NOT NULL CHECK (length(identity) = 64),
    schema_sha256 TEXT NOT NULL CHECK (length(schema_sha256) = 64),
    layout_sha256 TEXT NOT NULL CHECK (length(layout_sha256) = 64)
) STRICT;

CREATE TABLE work_intents (
    operation_key TEXT PRIMARY KEY CHECK (length(operation_key) = 70),
    fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
    capture_family TEXT NOT NULL DEFAULT 'agent_work' CHECK (capture_family IN ('agent_work', 'agent_result')),
    capture_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (capture_schema_version = 1),
    tool TEXT NOT NULL,
    run_id TEXT NOT NULL CHECK (length(run_id) = 26),
    admission_mode TEXT NOT NULL CHECK (admission_mode IN ('online_only', 'offline_admitted')),
    request_json TEXT NOT NULL,
    confirmation_json TEXT NOT NULL CHECK (length(CAST(confirmation_json AS BLOB)) BETWEEN 1 AND 4096),
    capture_json TEXT NOT NULL CHECK (length(CAST(capture_json AS BLOB)) BETWEEN 1 AND 8192),
    CHECK ((capture_family = 'agent_work' AND tool IN ('bfb_update_task', 'bfb_add_comment', 'bfb_report_progress', 'bfb_propose_task') AND length(CAST(request_json AS BLOB)) BETWEEN 1 AND 16384) OR
           (capture_family = 'agent_result' AND tool = 'bfb_submit_result' AND length(CAST(request_json AS BLOB)) BETWEEN 1 AND 32768))
) STRICT;

CREATE TABLE work_delivery (
    operation_key TEXT PRIMARY KEY REFERENCES work_intents(operation_key),
    state TEXT NOT NULL CHECK (state IN ('open', 'applied', 'blocked', 'quarantined')),
    effect TEXT NOT NULL CHECK (effect IN ('never_sent', 'unknown', 'applied')),
    ever_dispatched_ns INTEGER CHECK (ever_dispatched_ns >= 0),
    reason_code TEXT CHECK (length(CAST(reason_code AS BLOB)) BETWEEN 1 AND 64),
    outcome_json TEXT CHECK (length(CAST(outcome_json AS BLOB)) BETWEEN 1 AND 16384),
    receipt_json TEXT CHECK (length(CAST(receipt_json AS BLOB)) BETWEEN 1 AND 2048),
    claim_token TEXT,
    claim_incarnation TEXT,
    claim_deadline_ns INTEGER CHECK (claim_deadline_ns >= 0),
    CHECK ((claim_token IS NULL AND claim_incarnation IS NULL AND claim_deadline_ns IS NULL) OR
           (length(claim_token) = 64 AND length(claim_incarnation) = 64 AND claim_deadline_ns IS NOT NULL AND state = 'open')),
    CHECK ((state = 'open' AND effect = 'never_sent' AND ever_dispatched_ns IS NULL AND outcome_json IS NULL AND reason_code IS NULL) OR
           (state = 'open' AND effect = 'unknown' AND ever_dispatched_ns IS NOT NULL AND outcome_json IS NULL AND reason_code IS NULL) OR
           (state = 'applied' AND effect = 'applied' AND ever_dispatched_ns IS NOT NULL AND outcome_json IS NOT NULL AND reason_code IS NULL) OR
           (state = 'blocked' AND effect = 'never_sent' AND ever_dispatched_ns IS NULL AND outcome_json IS NULL AND reason_code IS NOT NULL) OR
           (state = 'blocked' AND effect = 'unknown' AND ever_dispatched_ns IS NOT NULL AND outcome_json IS NULL AND reason_code IS NOT NULL) OR
           (state = 'quarantined' AND effect = 'unknown' AND outcome_json IS NULL AND reason_code IS NOT NULL))
) STRICT;

CREATE TABLE work_legacy_quarantine (
    request_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    reason_code TEXT NOT NULL CHECK (reason_code = 'legacy_capture_unverifiable'),
    effect TEXT NOT NULL CHECK (effect = 'unknown')
) STRICT;

CREATE INDEX work_intents_run ON work_intents(run_id);
CREATE INDEX work_delivery_claim ON work_delivery(state, claim_deadline_ns);
CREATE TRIGGER work_intents_no_update BEFORE UPDATE ON work_intents BEGIN SELECT RAISE(ABORT, 'immutable intent'); END;
CREATE TRIGGER work_intents_no_delete BEFORE DELETE ON work_intents BEGIN SELECT RAISE(ABORT, 'immutable intent'); END;
CREATE TRIGGER work_delivery_no_delete BEFORE DELETE ON work_delivery BEGIN SELECT RAISE(ABORT, 'immutable history'); END;
CREATE TRIGGER work_dispatch_irrevocable BEFORE UPDATE ON work_delivery
WHEN OLD.ever_dispatched_ns IS NOT NULL AND (NEW.ever_dispatched_ns IS NULL OR NEW.ever_dispatched_ns != OLD.ever_dispatched_ns)
BEGIN SELECT RAISE(ABORT, 'irrevocable dispatch'); END;
CREATE TRIGGER work_applied_irrevocable BEFORE UPDATE ON work_delivery
WHEN OLD.state = 'applied'
BEGIN SELECT RAISE(ABORT, 'irrevocable application'); END;
