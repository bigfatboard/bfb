// ABOUTME: Proves native parent inspection and the daemon assignment adapter.
// ABOUTME: Builds only synthetic SQLite rows; it never opens the real daemon database.

package localmcp

import (
	"context"
	"database/sql"
	"os"
	"testing"

	_ "modernc.org/sqlite"
)

func TestInspectParentReportsSelf(t *testing.T) {
	facts, err := OSInspector().Inspect()
	if err != nil {
		t.Fatal(err)
	}
	if facts.UID != os.Getuid() || facts.PID != os.Getppid() {
		t.Fatalf("inspector misidentifies the parent: %+v", facts)
	}
	if facts.GroupID <= 0 || facts.StartIdentity == "" {
		t.Fatalf("inspector misses group or start identity: %+v", facts)
	}
}

func assignmentTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+t.TempDir()+"/assignments.sqlite?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	_, err = db.Exec(`CREATE TABLE local_execution_assignments (
state TEXT, correlation_token TEXT, workspace_id TEXT, project_id TEXT,
task_id TEXT, run_id TEXT, runner_id TEXT, checkout_id TEXT,
supervisor_json TEXT, owned_group_json TEXT,
execution_id TEXT, assignment_generation INTEGER) STRICT`)
	if err != nil {
		t.Fatal(err)
	}
	return db
}

func TestDaemonAssignmentsAdapter(t *testing.T) {
	db := assignmentTestDB(t)
	ctx := context.Background()
	source := DaemonAssignments{DB: db}
	if _, err := source.Lookup(ctx, "missing", 7); CodeOf(err) != "assignment_unknown" {
		t.Fatalf("missing row must fail closed: %v", err)
	}
	group := `{"leader":{"pid":4242,"parent_pid":100,"group_id":4242,"uid":501,"start_identity":"synthetic-start-4242"}}`
	_, err := db.Exec(`INSERT INTO local_execution_assignments VALUES
('group_ready','synthetic-correlation','w1','p1','t1','r1','rn1','c1',NULL,?, 'e1',7)`, group)
	if err != nil {
		t.Fatal(err)
	}
	record, err := source.Lookup(ctx, "e1", 7)
	if err != nil {
		t.Fatal(err)
	}
	if !record.Known || !record.Active || record.OwnedGroupID != 4242 ||
		record.ProviderPID != 4242 || record.ProviderStart != "synthetic-start-4242" ||
		record.Boundary.RunID != "r1" || record.Boundary.Generation != 7 {
		t.Fatalf("adapter misreads the assignment: %+v", record)
	}
	if _, err := db.Exec(`UPDATE local_execution_assignments SET state = 'ended' WHERE execution_id = 'e1'`); err != nil {
		t.Fatal(err)
	}
	ended, err := source.Lookup(ctx, "e1", 7)
	if err != nil {
		t.Fatal(err)
	}
	if !ended.Known || ended.Active {
		t.Fatalf("ended assignment must stay known but inactive: %+v", ended)
	}
	if _, err := db.Exec(`UPDATE local_execution_assignments SET owned_group_json = '{"leader":{}}' WHERE execution_id = 'e1'`); err != nil {
		t.Fatal(err)
	}
	drifted, err := source.Lookup(ctx, "e1", 7)
	if err != nil {
		t.Fatal(err)
	}
	if drifted.OwnedGroupID != 0 || drifted.ProviderPID != 0 {
		t.Fatalf("malformed group evidence must fail closed: %+v", drifted)
	}
}

func TestNilDatabaseFailsClosed(t *testing.T) {
	if _, err := (DaemonAssignments{}).Lookup(context.Background(), "e1", 7); CodeOf(err) != "assignment_unknown" {
		t.Fatalf("nil database must fail closed: %v", err)
	}
}
