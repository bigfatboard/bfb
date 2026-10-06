// ABOUTME: Proves exclusive journal startup and transactional legacy preservation across crashes.
// ABOUTME: Exercises ambiguous identity, unsafe files, historical quotas and restart claim recovery.

package agentwork

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func workTestPath(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	if err := os.Chmod(directory, 0700); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(directory, "local-mcp-journal.sqlite")
}

func workLegacyDB(t *testing.T, path string, version int, narrow bool) *sql.DB {
	t.Helper()
	file, err := workPrivateFile(path, unix.O_CREAT|unix.O_EXCL|unix.O_RDWR)
	if err != nil {
		t.Fatal(err)
	}
	if err = file.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", "file:"+path+"?mode=rw")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	if version != 0 {
		schema := legacyWorkTable
		if narrow {
			schema = strings.Replace(schema, ", 'bfb_submit_result'", "", 1)
		}
		if _, err = db.Exec(schema + ";" + legacyWorkIndex + fmt.Sprintf("; PRAGMA user_version=%d", version)); err != nil {
			t.Fatal(err)
		}
	}
	return db
}

func workLegacyRow(t *testing.T, db *sql.DB, id, run, state, payload string) {
	t.Helper()
	_, err := db.Exec(`INSERT INTO pending_operations VALUES(?, 'bfb_add_comment', ?,?,?,?, ?,?,?,1, 'legacy-session','legacy-principal','legacy-grant',0,
'legacy-hash',?,'unsigned legacy bytes','old-capture','old-expiry','pending_sync',?,?)`, id, workTestID, workTestID, workTestID, run, workTestID, workTestID, run, payload, state, "original outcome \n with whitespace")
	if err != nil {
		t.Fatal(err)
	}
}

func workLegacyEvidence(t *testing.T, db *sql.DB) string {
	t.Helper()
	rows, err := db.Query("SELECT request_id,payload_json,capture_proof,state,outcome_json FROM pending_operations ORDER BY request_id")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var evidence strings.Builder
	for rows.Next() {
		var id, payload, proof, state string
		var outcome sql.NullString
		if rows.Scan(&id, &payload, &proof, &state, &outcome) != nil {
			t.Fatal("legacy scan failed")
		}
		fmt.Fprintf(&evidence, "%q %q %q %q %+v\n", id, payload, proof, state, outcome)
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	return evidence.String()
}

func TestWorkJournalOpenExclusiveAndCurrent(t *testing.T) {
	journal, clock, path := newWorkTestJournal(t)
	ctx := context.Background()
	if _, err := openWorkJournal(ctx, path, clock.read); !errors.Is(err, errWorkAlreadyOwned) {
		t.Fatal("second owner accepted", err)
	}
	intent := workTestIntent(t, "restart", workTestID, "offline_admitted")
	first, _, err := journal.admit(ctx, intent, true)
	if err != nil {
		t.Fatal(err)
	}
	incarnation := journal.incarnation
	if err = journal.close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := openWorkJournal(ctx, path, clock.read)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.close() }()
	if reopened.incarnation == incarnation {
		t.Fatal("restart kept old incarnation")
	}
	if err = reopened.acknowledge(ctx, *first.Claim, workTestOutcome(t, intent)); !errors.Is(err, errWorkClaim) {
		t.Fatal("old incarnation acknowledged", err)
	}
	second, err := reopened.claimOperation(ctx, intent.OperationKey)
	if err != nil || second.Effect != "unknown" || second.EverDispatched == nil || second.Claim.Incarnation == incarnation {
		t.Fatal("restart lost marker", second, err)
	}
	if err = reopened.acknowledge(ctx, *second.Claim, workTestOutcome(t, intent)); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"", ".identity", ".lock"} {
		info, err := os.Lstat(path + suffix)
		if err != nil || !workPrivateOwner(info) {
			t.Fatal("private state mode", suffix, err)
		}
	}
}

func TestWorkJournalLegacyMigrationPreservesAndQuarantines(t *testing.T) {
	for _, version := range []int{0, 11, 12} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			path := workTestPath(t)
			head := version
			if head == 0 {
				head = 12
			}
			db := workLegacyDB(t, path, head, version == 11)
			if version == 0 {
				if _, err := db.Exec("PRAGMA user_version=0"); err != nil {
					t.Fatal(err)
				}
			}
			for _, state := range []string{"pending", "applied", "rejected"} {
				workLegacyRow(t, db, state, workTestID, state, " raw private body \n \t ")
			}
			before := workLegacyEvidence(t, db)
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			journal, err := openWorkJournal(context.Background(), path, func() (time.Duration, error) { return 0, nil })
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = journal.close() }()
			if after := workLegacyEvidence(t, journal.db); after != before {
				t.Fatal("legacy bytes changed", before, after)
			}
			var count int
			if err = journal.db.QueryRow("SELECT count(*) FROM work_legacy_quarantine WHERE request_id='pending' AND reason_code='legacy_capture_unverifiable' AND effect='unknown'").Scan(&count); err != nil || count != 1 {
				t.Fatal("unsigned pending not quarantined", count, err)
			}
			if err = journal.db.QueryRow("SELECT count(*) FROM work_intents").Scan(&count); err != nil || count != 0 {
				t.Fatal("legacy row became signed intent", count, err)
			}
			for _, statement := range []string{"INSERT INTO pending_operations SELECT * FROM pending_operations WHERE request_id='pending'", "UPDATE pending_operations SET state='applied' WHERE request_id='pending'", "DELETE FROM pending_operations WHERE request_id='pending'"} {
				if _, err = journal.db.Exec(statement); err == nil {
					t.Fatal("legacy history still mutable", statement)
				}
			}
		})
	}
}

func TestWorkJournalExistingEmptyHistoryIsAmbiguous(t *testing.T) {
	path := workTestPath(t)
	db := workLegacyDB(t, path, 0, false)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := openWorkJournal(context.Background(), path, func() (time.Duration, error) { return 0, nil }); !errors.Is(err, errWorkIdentity) {
		t.Fatal("empty existing history reinitialized", err)
	}
	if _, err := os.Stat(path + ".identity"); !os.IsNotExist(err) {
		t.Fatal("ambiguous empty state acquired identity", err)
	}
}

func TestWorkJournalRejectsForeignFutureAndInterruptedSchemas(t *testing.T) {
	for _, kind := range []string{"future", "foreign", "partial", "partial-head", "wrong-check"} {
		t.Run(kind, func(t *testing.T) {
			path := workTestPath(t)
			db := workLegacyDB(t, path, 11, true)
			workLegacyRow(t, db, "original", workTestID, "pending", "preserve me")
			before := workLegacyEvidence(t, db)
			switch kind {
			case "future":
				_, _ = db.Exec(fmt.Sprintf("PRAGMA user_version=%d", workJournalVersion+1))
			case "foreign":
				_, _ = db.Exec("PRAGMA application_id=123")
			case "partial":
				_, _ = db.Exec("CREATE TABLE pending_operations_a03 (id TEXT PRIMARY KEY) STRICT")
			case "partial-head":
				_, _ = db.Exec("DROP INDEX pending_operations_run_state")
			case "wrong-check":
				_, _ = db.Exec("PRAGMA user_version=12") // Narrow CHECK never was head 12.
			}
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			if _, err := openWorkJournal(context.Background(), path, func() (time.Duration, error) { return 0, nil }); !errors.Is(err, errWorkMigration) {
				t.Fatal("unrecognized schema adopted", err)
			}
			if _, err := os.Stat(path + ".identity"); !os.IsNotExist(err) {
				t.Fatal("rejection manufactured identity", err)
			}
			check, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = check.Close() }()
			if after := workLegacyEvidence(t, check); after != before {
				t.Fatal("rejected history changed", before, after)
			}
		})
	}
}

func TestWorkJournalMigrationRollbackLeavesAmbiguousIdentityClosed(t *testing.T) {
	path := workTestPath(t)
	db := workLegacyDB(t, path, 12, false)
	workLegacyRow(t, db, "pending", workTestID, "pending", "preserved")
	before := workLegacyEvidence(t, db)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := openWorkJournalWithHook(context.Background(), path, func() (time.Duration, error) { return 0, nil }, func() error { return errors.New("commit failed") }); !errors.Is(err, errWorkStorage) {
		t.Fatal(err)
	}
	check, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = check.Close() }()
	var version, count int
	if check.QueryRow("PRAGMA user_version").Scan(&version) != nil || version != 12 || check.QueryRow("SELECT count(*) FROM sqlite_master WHERE name='work_intents'").Scan(&count) != nil || count != 0 || workLegacyEvidence(t, check) != before {
		t.Fatal("migration partially committed", version, count)
	}
	if _, err = openWorkJournal(context.Background(), path, func() (time.Duration, error) { return 0, nil }); !errors.Is(err, errWorkIdentity) {
		t.Fatal("ambiguous interrupted adoption resumed", err)
	}
}

func TestWorkJournalIdentityLossReplacementAndHalfCreation(t *testing.T) {
	for _, kind := range []string{"missing-database", "missing-sentinel", "mismatched-sentinel", "sentinel-only", "malformed-sentinel"} {
		t.Run(kind, func(t *testing.T) {
			journal, clock, path := newWorkTestJournal(t)
			if err := journal.close(); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "missing-database", "sentinel-only":
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			case "missing-sentinel":
				if err := os.Remove(path + ".identity"); err != nil {
					t.Fatal(err)
				}
			case "mismatched-sentinel":
				if err := os.WriteFile(path+".identity", []byte(workIdentityPrefix+strings.Repeat("e", 64)+"\n"), 0600); err != nil {
					t.Fatal(err)
				}
			case "malformed-sentinel":
				if err := os.WriteFile(path+".identity", []byte("partial"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := openWorkJournal(context.Background(), path, clock.read); !errors.Is(err, errWorkIdentity) {
				t.Fatal("missing or replaced history recreated", err)
			}
		})
	}
}

func TestWorkJournalUnsafeAndCorruptFilesPreserved(t *testing.T) {
	for _, kind := range []string{"database-link", "sentinel-link", "sidecar-link", "world-readable", "corrupt-database", "changed-layout"} {
		t.Run(kind, func(t *testing.T) {
			journal, clock, path := newWorkTestJournal(t)
			if err := journal.close(); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "database-link":
				if err := os.Rename(path, path+".saved"); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(path+".saved", path); err != nil {
					t.Fatal(err)
				}
			case "sentinel-link":
				if err := os.Rename(path+".identity", path+".identity-saved"); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(path+".identity-saved", path+".identity"); err != nil {
					t.Fatal(err)
				}
			case "sidecar-link":
				if err := os.Symlink(path, path+"-wal"); err != nil {
					t.Fatal(err)
				}
			case "world-readable":
				if err := os.Chmod(path, 0644); err != nil {
					t.Fatal(err)
				}
			case "corrupt-database":
				if err := os.WriteFile(path, []byte("not a database"), 0600); err != nil {
					t.Fatal(err)
				}
			case "changed-layout":
				db, err := sql.Open("sqlite", "file:"+path+"?mode=rw")
				if err != nil {
					t.Fatal(err)
				}
				if _, err = db.Exec("DROP TRIGGER work_dispatch_irrevocable"); err != nil {
					t.Fatal(err)
				}
				_ = db.Close()
			}
			if _, err := openWorkJournal(context.Background(), path, clock.read); err == nil {
				t.Fatal("unsafe/corrupt state opened")
			}
			if _, err := os.Lstat(path); err != nil {
				t.Fatal("failed open removed evidence", err)
			}
		})
	}
}

func TestWorkJournalHistoricalCapacityPreservesWithoutAdmission(t *testing.T) {
	for _, kind := range []string{"run", "daemon", "retained", "oversized"} {
		t.Run(kind, func(t *testing.T) {
			path := workTestPath(t)
			db := workLegacyDB(t, path, 12, false)
			workLegacyRow(t, db, "seed", workTestID, "pending", "preserve")
			count, state, run, payload := 257, "pending", workTestID, "preserve"
			switch kind {
			case "daemon":
				count, run = 1024, workOtherID
			case "retained":
				count, state = 10000, "applied"
			case "oversized":
				count, payload = 1, strings.Repeat("x", 32769)
			}
			if _, err := db.Exec("UPDATE pending_operations SET state=?,run_id=?,payload_json=?", state, run, payload); err != nil {
				t.Fatal(err)
			}
			if count > 1 {
				_, err := db.Exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO pending_operations
SELECT 'row-'||x,tool,workspace_id,project_id,task_id,run_id,runner_id,checkout_id,execution_id,assignment_generation,observed_session_id,principal,grant_name,expected_version,payload_hash,payload_json,capture_proof,captured_at,expires_at,policy_decision,state,outcome_json FROM n CROSS JOIN pending_operations WHERE request_id='seed'`, count-1)
				if err != nil {
					t.Fatal(err)
				}
			}
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			journal, err := openWorkJournal(context.Background(), path, func() (time.Duration, error) { return 0, nil })
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = journal.close() }()
			if _, _, err = journal.admit(context.Background(), workTestIntent(t, "new", workTestID, "offline_admitted"), true); !errors.Is(err, errWorkQuota) {
				t.Fatal("historical capacity ignored", err)
			}
			var actual int
			if err = journal.db.QueryRow("SELECT count(*) FROM pending_operations").Scan(&actual); err != nil || actual != count {
				t.Fatal("history pruned", actual, count, err)
			}
		})
	}
}

func TestWorkJournalProcessCrash(t *testing.T) {
	if mode := os.Getenv("BFB_WORK_JOURNAL_CRASH_MODE"); mode != "" {
		path := os.Getenv("BFB_WORK_JOURNAL_CRASH_PATH")
		clock := func() (time.Duration, error) { return 0, nil }
		if mode == "migration" {
			_, _ = openWorkJournalWithHook(context.Background(), path, clock, func() error { os.Exit(83); return nil })
		} else {
			journal, err := openWorkJournal(context.Background(), path, clock)
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err = journal.admit(context.Background(), workTestIntent(t, "crash-intent", workTestID, "offline_admitted"), mode == "dispatch"); err != nil {
				t.Fatal(err)
			}
			os.Exit(84) // No Close: emulate death after durable intent/marker and before acknowledgement.
		}
		t.Fatal("crash helper returned")
	}
	for _, mode := range []string{"migration", "intent", "dispatch"} {
		t.Run(mode, func(t *testing.T) {
			path := workTestPath(t)
			if mode == "migration" {
				db := workLegacyDB(t, path, 12, false)
				workLegacyRow(t, db, "pending", workTestID, "pending", "original")
				_ = db.Close()
			}
			command := exec.Command(os.Args[0], "-test.run=^TestWorkJournalProcessCrash$")
			command.Env = append(os.Environ(), "BFB_WORK_JOURNAL_CRASH_MODE="+mode, "BFB_WORK_JOURNAL_CRASH_PATH="+path)
			output, err := command.CombinedOutput()
			var exited *exec.ExitError
			if !errors.As(err, &exited) || (exited.ExitCode() != 83 && exited.ExitCode() != 84) {
				t.Fatalf("crash helper: %v %s", err, output)
			}
			journal, err := openWorkJournal(context.Background(), path, func() (time.Duration, error) { return 0, nil })
			if mode == "migration" {
				if !errors.Is(err, errWorkIdentity) {
					t.Fatal("half migration reopened", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = journal.close() }()
			intent := workTestIntent(t, "crash-intent", workTestID, "offline_admitted")
			record, found, err := journal.lookup(context.Background(), intent.OperationKey)
			want := "never_sent"
			if mode == "dispatch" {
				want = "unknown"
			}
			if err != nil || !found || record.State != "open" || record.Effect != want {
				t.Fatal("crash fabricated disposition", record, found, err)
			}
		})
	}
}
