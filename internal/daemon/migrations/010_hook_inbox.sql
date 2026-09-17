-- ABOUTME: Tracks L06 offline inbox imports and the visible telemetry-degraded state.
-- ABOUTME: Stores only file hashes and outcomes, never correlation secrets or provider payloads.

CREATE TABLE hook_inbox_receipts (
    file_hash TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('imported','quarantined')),
    recorded_at TEXT NOT NULL
) STRICT;

CREATE TABLE hook_journal_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

INSERT INTO hook_journal_meta (key, value) VALUES
    ('db_epoch', ''),
    ('telemetry_degraded', '0'),
    ('degraded_reason', ''),
    ('degraded_at', '');

CREATE TRIGGER hook_inbox_receipt_capacity
BEFORE INSERT ON hook_inbox_receipts
WHEN (SELECT count(*) FROM hook_inbox_receipts) >= 4096
BEGIN
    SELECT RAISE(ABORT, 'hook inbox receipt capacity');
END;
