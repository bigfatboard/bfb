// ABOUTME: Adopts only recognized historical agent journal schemas in one immediate transaction.
// ABOUTME: Preserves raw legacy terminal evidence and quarantines unsigned pending history.

package agentwork

import (
	"context"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/hex"
	"fmt"
	"strings"
)

const workJournalVersion = 14
const workJournalApplicationID = 0x4246574a

//go:embed migrations/013_work_journal.sql
var workJournalSchema13 string

//go:embed migrations/014_result_journal.sql
var workJournalSchema string

// These are the exact two published legacy CHECK variants, not permission to
// adopt arbitrary lookalike tables. Interrupted old nontransactional rebuilds
// are preserved and rejected rather than deleting either possible history.
const legacyWorkTable = `CREATE TABLE pending_operations (
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
) STRICT`

const legacyWorkIndex = `CREATE INDEX pending_operations_run_state ON pending_operations (run_id, state, captured_at)`

type workSchemaReader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func inspectWorkSchema(ctx context.Context, db workSchemaReader) (int, error) {
	var version, appID int
	if db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version) != nil || db.QueryRowContext(ctx, "PRAGMA application_id").Scan(&appID) != nil {
		return 0, errWorkStorage
	}
	if version == workJournalVersion || version == 13 {
		if appID != workJournalApplicationID {
			return 0, errWorkMigration
		}
		return version, nil
	}
	if appID != 0 || (version != 0 && version != 11 && version != 12) {
		return 0, errWorkMigration
	}
	rows, err := db.QueryContext(ctx, "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
	if err != nil {
		return 0, errWorkStorage
	}
	defer func() { _ = rows.Close() }()
	objects := make(map[string]string)
	for rows.Next() {
		var kind, name, definition string
		if rows.Scan(&kind, &name, &definition) != nil || (kind != "table" && kind != "index") {
			return 0, errWorkMigration
		}
		objects[name] = normalizeWorkSQL(definition)
	}
	if rows.Err() != nil {
		return 0, errWorkStorage
	}
	if version == 0 && len(objects) == 0 {
		return version, nil
	}
	wide := normalizeWorkSQL(legacyWorkTable)
	narrow := normalizeWorkSQL(strings.Replace(legacyWorkTable, ", 'bfb_submit_result'", "", 1))
	if len(objects) != 2 || objects["pending_operations_run_state"] != normalizeWorkSQL(legacyWorkIndex) ||
		(objects["pending_operations"] != wide && (version == 12 || objects["pending_operations"] != narrow)) {
		return 0, errWorkMigration
	}
	return version, nil
}

func normalizeWorkSQL(value string) string {
	value = strings.ReplaceAll(value, "IF NOT EXISTS ", "")
	return strings.Join(strings.Fields(value), " ")
}

func migrateWorkJournal(ctx context.Context, db *sql.DB, identity string, beforeCommit func() error) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return errWorkStorage
	}
	defer func() { _ = tx.Rollback() }()
	if version, err := inspectWorkSchema(ctx, tx); err != nil || version == workJournalVersion {
		if err != nil {
			return err
		}
		return errWorkMigration
	}
	if _, err = tx.ExecContext(ctx, workJournalSchema); err != nil {
		return errWorkStorage
	}
	var legacy int
	if tx.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='pending_operations'").Scan(&legacy) != nil {
		return errWorkStorage
	}
	if legacy == 1 {
		if _, err = tx.ExecContext(ctx, `INSERT INTO work_legacy_quarantine(request_id, run_id, reason_code, effect)
SELECT request_id, run_id, 'legacy_capture_unverifiable', 'unknown' FROM pending_operations WHERE state='pending';
CREATE TRIGGER legacy_work_no_insert BEFORE INSERT ON pending_operations BEGIN SELECT RAISE(ABORT, 'historical evidence'); END;
CREATE TRIGGER legacy_work_no_update BEFORE UPDATE ON pending_operations BEGIN SELECT RAISE(ABORT, 'historical evidence'); END;
CREATE TRIGGER legacy_work_no_delete BEFORE DELETE ON pending_operations BEGIN SELECT RAISE(ABORT, 'historical evidence'); END;`); err != nil {
			return errWorkStorage
		}
	}
	layout, err := workLayoutDigest(ctx, tx)
	if err != nil {
		return err
	}
	digest := sha256.Sum256([]byte(workJournalSchema))
	if _, err = tx.ExecContext(ctx, "INSERT INTO work_journal_meta(singleton,identity,schema_sha256,layout_sha256) VALUES(1,?,?,?)", identity, hex.EncodeToString(digest[:]), layout); err != nil {
		return errWorkStorage
	}
	if _, err = tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version=%d; PRAGMA application_id=%d", workJournalVersion, workJournalApplicationID)); err != nil {
		return errWorkStorage
	}
	if beforeCommit != nil && beforeCommit() != nil {
		return errWorkStorage
	}
	if tx.Commit() != nil {
		return errWorkStorage
	}
	return nil
}

func verifyWorkIdentity(ctx context.Context, db workSchemaReader, identity string) error {
	return verifyWorkSchemaIdentity(ctx, db, identity, workJournalSchema)
}

func verifyWorkSchemaIdentity(ctx context.Context, db workSchemaReader, identity, definition string) error {
	var stored, schema, layout string
	if db.QueryRowContext(ctx, "SELECT identity,schema_sha256,layout_sha256 FROM work_journal_meta WHERE singleton=1").Scan(&stored, &schema, &layout) != nil {
		return errWorkIdentity
	}
	if stored != identity {
		return errWorkIdentity
	}
	digest := sha256.Sum256([]byte(definition))
	actualLayout, err := workLayoutDigest(ctx, db)
	if err != nil || schema != hex.EncodeToString(digest[:]) || actualLayout != layout {
		return errWorkMigration
	}
	rows, err := db.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return errWorkStorage
	}
	defer func() { _ = rows.Close() }()
	if rows.Next() || rows.Err() != nil {
		return errWorkStorage
	}
	return nil
}

func workLayoutDigest(ctx context.Context, db workSchemaReader) (string, error) {
	rows, err := db.QueryContext(ctx, "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
	if err != nil {
		return "", errWorkStorage
	}
	defer func() { _ = rows.Close() }()
	hash := sha256.New()
	for rows.Next() {
		var kind, name, table, definition string
		if rows.Scan(&kind, &name, &table, &definition) != nil {
			return "", errWorkStorage
		}
		for _, value := range []string{kind, name, table, definition} {
			_, _ = fmt.Fprintf(hash, "%d:%s\n", len(value), value)
		}
	}
	if rows.Err() != nil {
		return "", errWorkStorage
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
