// ABOUTME: Upgrades recognized signed task journals without changing immutable capture or delivery bytes.
// ABOUTME: Rebuilds result-capable tables atomically while preserving identity, foreign keys and legacy quarantine.

package agentwork

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
)

// The private journal flock excludes another daemon throughout this upgrade.
// Temporary copies exist only inside this transaction; failure restores every
// original table, trigger, identity digest and row with the v13 head intact.
func upgradeWorkJournal13(ctx context.Context, db *sql.DB, identity string, beforeCommit func() error) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return errWorkStorage
	}
	defer func() { _ = tx.Rollback() }()
	version, err := inspectWorkSchema(ctx, tx)
	if err != nil || version != 13 {
		return errWorkMigration
	}
	if err := verifyWorkSchemaIdentity(ctx, tx, identity, workJournalSchema13); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `
CREATE TEMP TABLE saved_work_intents AS SELECT * FROM work_intents;
CREATE TEMP TABLE saved_work_delivery AS SELECT * FROM work_delivery;
CREATE TEMP TABLE saved_work_quarantine AS SELECT * FROM work_legacy_quarantine;
DROP TABLE work_delivery;
DROP TABLE work_intents;
DROP TABLE work_legacy_quarantine;
DROP TABLE work_journal_meta;`); err != nil {
		return errWorkStorage
	}
	if _, err = tx.ExecContext(ctx, workJournalSchema); err != nil {
		return errWorkStorage
	}
	if _, err = tx.ExecContext(ctx, `
INSERT INTO work_intents(operation_key,fingerprint,capture_family,capture_schema_version,tool,run_id,admission_mode,request_json,confirmation_json,capture_json)
SELECT operation_key,fingerprint,'agent_work',1,tool,run_id,admission_mode,request_json,confirmation_json,capture_json FROM saved_work_intents;
INSERT INTO work_delivery SELECT * FROM saved_work_delivery;
INSERT INTO work_legacy_quarantine SELECT * FROM saved_work_quarantine;
DROP TABLE saved_work_intents;
DROP TABLE saved_work_delivery;
DROP TABLE saved_work_quarantine;`); err != nil {
		return errWorkStorage
	}
	layout, err := workLayoutDigest(ctx, tx)
	if err != nil {
		return err
	}
	digest := sha256.Sum256([]byte(workJournalSchema))
	if _, err = tx.ExecContext(ctx, "INSERT INTO work_journal_meta(singleton,identity,schema_sha256,layout_sha256) VALUES(1,?,?,?)", identity, hex.EncodeToString(digest[:]), layout); err != nil {
		return errWorkStorage
	}
	if err = verifyWorkIdentity(ctx, tx, identity); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version=%d", workJournalVersion)); err != nil {
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
