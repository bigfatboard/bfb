// ABOUTME: Proves v13 signed intent and delivery history survives the result-journal upgrade unchanged.
// ABOUTME: Rejects interrupted or damaged migrations and preserves original task bounds and immutable triggers.

package agentwork

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func workJournal13Fixture(t *testing.T, legacy bool) (string, string, string) {
	t.Helper()
	path := workTestPath(t)
	db := workLegacyDB(t, path, 0, false)
	ctx := context.Background()
	identity := strings.Repeat("a", 64)
	if err := writeWorkIdentity(path+".identity", identity); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(workJournalSchema13); err != nil {
		t.Fatal(err)
	}
	if legacy {
		if _, err := db.Exec(legacyWorkTable + ";" + legacyWorkIndex); err != nil {
			t.Fatal(err)
		}
		workLegacyRow(t, db, "old-result", workTestID, "pending", "private retained unsigned result")
		if _, err := db.Exec(`UPDATE pending_operations SET tool='bfb_submit_result';
INSERT INTO work_legacy_quarantine VALUES('old-result','` + workTestID + `','legacy_capture_unverifiable','unknown');
CREATE TRIGGER legacy_work_no_insert BEFORE INSERT ON pending_operations BEGIN SELECT RAISE(ABORT, 'historical evidence'); END;
CREATE TRIGGER legacy_work_no_update BEFORE UPDATE ON pending_operations BEGIN SELECT RAISE(ABORT, 'historical evidence'); END;
CREATE TRIGGER legacy_work_no_delete BEFORE DELETE ON pending_operations BEGIN SELECT RAISE(ABORT, 'historical evidence'); END;`); err != nil {
			t.Fatal(err)
		}
	}
	for index, state := range []string{"pending", "claimed", "applied", "rejected", "uncertain"} {
		intent := workTestIntent(t, "upgrade-"+state, workTestID, "offline_admitted")
		if _, err := db.Exec(`INSERT INTO work_intents VALUES(?,?,?,?,?,?,?,?)`, intent.OperationKey, intent.Fingerprint, intent.Tool, intent.RunID, intent.AdmissionMode, intent.RequestJSON, intent.ConfirmationJSON, intent.CaptureJSON); err != nil {
			t.Fatal(err)
		}
		record := journalRecord{Intent: intent, State: "open", Effect: "never_sent"}
		var dispatched, reason, outcome, receipt, token, incarnation, deadline any
		if state == "claimed" || state == "applied" || state == "uncertain" {
			sample := time.Duration(index + 1)
			record.Effect, record.EverDispatched = "unknown", &sample
			dispatched = int64(sample)
		}
		switch state {
		case "claimed":
			token, incarnation, deadline = strings.Repeat("b", 64), strings.Repeat("c", 64), int64(time.Minute)
		case "applied":
			record.State, record.Effect, record.OutcomeJSON = "applied", "applied", workTestOutcome(t, intent)
			outcome = record.OutcomeJSON
		case "rejected", "uncertain":
			record.State, record.Reason, reason = "blocked", "revoked", "revoked"
		}
		if record.State != "open" {
			encoded, err := journalReceipt(record)
			if err != nil {
				t.Fatal(err)
			}
			receipt = encoded
		}
		if _, err := db.Exec(`INSERT INTO work_delivery(operation_key,state,effect,ever_dispatched_ns,reason_code,outcome_json,receipt_json,claim_token,claim_incarnation,claim_deadline_ns) VALUES(?,?,?,?,?,?,?,?,?,?)`, intent.OperationKey, record.State, record.Effect, dispatched, reason, outcome, receipt, token, incarnation, deadline); err != nil {
			t.Fatal(err)
		}
	}
	layout, err := workLayoutDigest(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(workJournalSchema13))
	if _, err = db.Exec("INSERT INTO work_journal_meta VALUES(1,?,?,?)", identity, hex.EncodeToString(digest[:]), layout); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(fmt.Sprintf("PRAGMA user_version=13; PRAGMA application_id=%d", workJournalApplicationID)); err != nil {
		t.Fatal(err)
	}
	evidence := workProtectedEvidence(t, db)
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	return path, identity, evidence
}

func workProtectedEvidence(t *testing.T, db *sql.DB) string {
	t.Helper()
	rows, err := db.Query(`SELECT json_array(i.operation_key,i.fingerprint,i.tool,i.run_id,i.admission_mode,i.request_json,i.confirmation_json,i.capture_json,
d.state,d.effect,d.ever_dispatched_ns,d.reason_code,d.outcome_json,d.receipt_json,d.claim_token,d.claim_incarnation,d.claim_deadline_ns)
FROM work_intents i LEFT JOIN work_delivery d USING(operation_key) ORDER BY i.operation_key`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var evidence strings.Builder
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			t.Fatal(err)
		}
		evidence.WriteString(value + "\n")
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	return evidence.String()
}

func TestWorkJournal13UpgradePreservesAllEvidence(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		t.Run(fmt.Sprint(legacy), func(t *testing.T) {
			path, identity, before := workJournal13Fixture(t, legacy)
			journal, err := openWorkJournal(context.Background(), path, func() (time.Duration, error) { return 0, nil })
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = journal.close() }()
			if workProtectedEvidence(t, journal.db) != before {
				t.Fatal("upgrade changed original intent, capture, outcome, receipt or claim bytes")
			}
			if err = verifyWorkIdentity(context.Background(), journal.db, identity); err != nil {
				t.Fatal(err)
			}
			var count int
			if err = journal.db.QueryRow("SELECT count(*) FROM work_intents WHERE capture_family='agent_work' AND capture_schema_version=1").Scan(&count); err != nil || count != 5 {
				t.Fatal("historical family assignment", count, err)
			}
			if legacy {
				if err = journal.db.QueryRow("SELECT count(*) FROM work_legacy_quarantine WHERE request_id='old-result' AND effect='unknown'").Scan(&count); err != nil || count != 1 {
					t.Fatal("unsigned result quarantine changed", count, err)
				}
				if _, err = journal.db.Exec("UPDATE pending_operations SET state='applied'"); err == nil {
					t.Fatal("legacy evidence became mutable")
				}
			}
			for _, statement := range []string{"UPDATE work_intents SET capture_family='agent_result'", "DELETE FROM work_intents", "DELETE FROM work_delivery", "UPDATE work_delivery SET ever_dispatched_ns=NULL WHERE ever_dispatched_ns IS NOT NULL", "UPDATE work_delivery SET state='open' WHERE state='applied'"} {
				if _, err = journal.db.Exec(statement); err == nil {
					t.Fatal("immutable history guard removed", statement)
				}
			}
		})
	}
}

func TestWorkJournal13UpgradeRollbackAndRetry(t *testing.T) {
	path, identity, before := workJournal13Fixture(t, true)
	clock := func() (time.Duration, error) { return 0, nil }
	if _, err := openWorkJournalWithHook(context.Background(), path, clock, func() error { return errors.New("synthetic commit failure") }); !errors.Is(err, errWorkStorage) {
		t.Fatal("upgrade did not fail", err)
	}
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	var version int
	if db.QueryRow("PRAGMA user_version").Scan(&version) != nil || version != 13 || workProtectedEvidence(t, db) != before {
		t.Fatal("failed upgrade partially committed")
	}
	if err = verifyWorkSchemaIdentity(context.Background(), db, identity, workJournalSchema13); err != nil {
		t.Fatal("failed upgrade damaged original layout", err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	journal, err := openWorkJournal(context.Background(), path, clock)
	if err != nil {
		t.Fatal("recognized intact v13 cannot retry", err)
	}
	defer func() { _ = journal.close() }()
	if workProtectedEvidence(t, journal.db) != before {
		t.Fatal("retry changed history")
	}
}

func TestWorkJournal13DamagedLayoutNeverUpgrades(t *testing.T) {
	path, _, before := workJournal13Fixture(t, false)
	db, err := sql.Open("sqlite", "file:"+path+"?mode=rw")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("DROP TRIGGER work_dispatch_irrevocable"); err != nil {
		t.Fatal(err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = openWorkJournal(context.Background(), path, func() (time.Duration, error) { return 0, nil }); !errors.Is(err, errWorkMigration) {
		t.Fatal("damaged protected history adopted", err)
	}
	db, err = sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if workProtectedEvidence(t, db) != before {
		t.Fatal("rejected history changed")
	}
}
