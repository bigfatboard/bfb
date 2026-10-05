// ABOUTME: Proves native parent inspection and the daemon assignment adapter.
// ABOUTME: Builds only synthetic SQLite rows; it never opens the real daemon database.

package localmcp

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/journal"
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
	if _, err := db.Exec("CREATE TABLE execution_native_history (execution_id TEXT PRIMARY KEY, history_json TEXT) STRICT"); err != nil {
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
	group := `{"pid":4242,"parent_pid":100,"group_id":4242,"uid":501,"start_identity":"synthetic-start-4242","executable":"/synthetic/provider","command":"synthetic"}`
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
	if _, err := db.Exec("UPDATE local_execution_assignments SET state='running', owned_group_json=? WHERE execution_id='e1'", group); err != nil {
		t.Fatal(err)
	}
	for _, history := range []string{
		`{"uncertain":true}`, `{"uncertain":true,"group":null}`,
		`{"local_released_at":"2026-10-05T00:00:00Z"}`, `{"released_group_hash":"sha256:synthetic"}`, `{"preflight_stopped_at":"2026-10-05T00:00:00Z"}`,
		`{"group":{"unknown":true}}`, `{"group":{"had_escape":true}}`, `{"group":{"incomplete":true}}`, `{"group":{"leader":{"pid":999,"group_id":999,"start_identity":"wrong"}}}`,
		`null`, `[]`, `{`, `{} {}`, `{"uncertain":null}`,
		`{"uncertain":true,"uncertain":false}`, `{"uncertain":true,"Uncertain":false}`,
		`{"group":{"leader":` + group + `},"Group":null}`, `{"group":{"leader":` + group + `,"Leader":null}}`,
		`{"group":{"unknown":true,"unknown":false}}`, `{"group":{"leader":` + group + `,"incomplete":null}}`,
		`{"group":{"leader":{"pid":4242,"group_id":4242,"start_identity":"synthetic-start-4242","zombie":true}}}`,
		`{"group":{"leader":{"pid":4242,"group_id":4242,"start_identity":"synthetic-start-4242","zombie":null}}}`,
		`{"unrelated":"` + strings.Repeat("x", 65536) + `"}`,
	} {
		if _, err := db.Exec("INSERT OR REPLACE INTO execution_native_history VALUES ('e1', ?)", history); err != nil {
			t.Fatal(err)
		}
		record, err := source.Lookup(ctx, "e1", 7)
		if err != nil || !record.Known || record.Active {
			t.Fatal("recorded containment uncertainty ignored", history, record, err)
		}
	}
	for _, history := range []string{`{}`, `{"uncertain":false,"group":null}`, `{"uncertain":false,"unrelated":"ignored","group":{"leader":` + group + `,"unknown":false,"had_escape":false,"incomplete":false}}`} {
		if _, err := db.Exec("UPDATE execution_native_history SET history_json=? WHERE execution_id='e1'", history); err != nil {
			t.Fatal(err)
		}
		record, err := source.Lookup(ctx, "e1", 7)
		if err != nil || !record.Active {
			t.Fatal("healthy projected history rejected", record, err)
		}
	}
}

func TestNilDatabaseFailsClosed(t *testing.T) {
	if _, err := (DaemonAssignments{}).Lookup(context.Background(), "e1", 7); CodeOf(err) != "assignment_unknown" {
		t.Fatalf("nil database must fail closed: %v", err)
	}
}

// bindingsTestDB opens a synthetic L06 hook-journal binding table. Rows are
// inserted directly: this suite proves the adapter, not L06's bind writer.
func bindingsTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+t.TempDir()+"/hook.sqlite?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	_, err = db.Exec(`CREATE TABLE hook_observed_sessions (
execution_id TEXT NOT NULL, assignment_generation INTEGER NOT NULL,
provider TEXT NOT NULL, session_id TEXT NOT NULL, bound_at TEXT NOT NULL,
PRIMARY KEY (execution_id, assignment_generation))`)
	if err != nil {
		t.Fatal(err)
	}
	return db
}

func syntheticRef() AssignmentRef {
	return AssignmentRef{
		ExecutionID:          syntheticBoundary.ExecutionID,
		AssignmentGeneration: syntheticBoundary.Generation,
		RunID:                syntheticBoundary.RunID,
	}
}

func TestJournalBindingsRoundTrip(t *testing.T) {
	ctx := context.Background()
	db := bindingsTestDB(t)
	bindings := JournalBindings{Sessions: journal.NewStore(db)}
	if _, err := bindings.ObservedBinding(ctx, syntheticRef()); !errors.Is(err, ErrSessionNotBound) {
		t.Fatalf("unbound execution must report ErrSessionNotBound: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO hook_observed_sessions
(execution_id, assignment_generation, provider, session_id, bound_at)
VALUES (?, ?, 'synthetic-provider', ?, ?)`,
		syntheticBoundary.ExecutionID, syntheticBoundary.Generation,
		syntheticSession, syntheticTime.Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	binding, err := bindings.ObservedBinding(ctx, syntheticRef())
	if err != nil {
		t.Fatal(err)
	}
	if !bindingMatches(syntheticRef(), binding) {
		t.Fatalf("journal row must satisfy the activation match: %+v", binding)
	}
	if binding.ObservedSessionID != syntheticSession || !binding.ObservedAt.Equal(syntheticTime) {
		t.Fatalf("adapter misreads the trusted row: %+v", binding)
	}
	other := AssignmentRef{ExecutionID: "01SYNTHETICEX00000000000099", AssignmentGeneration: 7, RunID: syntheticBoundary.RunID}
	if _, err := bindings.ObservedBinding(ctx, other); !errors.Is(err, ErrSessionNotBound) {
		t.Fatalf("foreign execution must stay unbound: %v", err)
	}
}

func TestJournalBindingsRejectsMalformedRows(t *testing.T) {
	ctx := context.Background()
	for _, row := range []struct {
		name    string
		session string
		boundAt string
	}{
		{"empty session", "", syntheticTime.Format(time.RFC3339Nano)},
		{"malformed time", syntheticSession, "not-a-time"},
		{"empty time", syntheticSession, ""},
	} {
		t.Run(row.name, func(t *testing.T) {
			db := bindingsTestDB(t)
			if _, err := db.Exec(`INSERT INTO hook_observed_sessions
(execution_id, assignment_generation, provider, session_id, bound_at)
VALUES (?, ?, 'synthetic-provider', ?, ?)`,
				syntheticBoundary.ExecutionID, syntheticBoundary.Generation, row.session, row.boundAt); err != nil {
				t.Fatal(err)
			}
			bindings := JournalBindings{Sessions: journal.NewStore(db)}
			if _, err := bindings.ObservedBinding(ctx, syntheticRef()); !errors.Is(err, ErrSessionNotBound) {
				t.Fatalf("malformed row must fail closed as unbound: %v", err)
			}
		})
	}
}

func TestJournalBindingsWithoutReaderFailsClosed(t *testing.T) {
	if _, err := (JournalBindings{}).ObservedBinding(context.Background(), syntheticRef()); !errors.Is(err, ErrSessionNotBound) {
		t.Fatalf("nil reader must fail closed: %v", err)
	}
}

func TestJournalBindingsPropagatesStorageFaults(t *testing.T) {
	db := bindingsTestDB(t)
	_ = db.Close()
	bindings := JournalBindings{Sessions: journal.NewStore(db)}
	_, err := bindings.ObservedBinding(context.Background(), syntheticRef())
	if err == nil || errors.Is(err, ErrSessionNotBound) {
		t.Fatalf("storage fault must not masquerade as unbound: %v", err)
	}
}

func TestJournalBindingsActivatesCapability(t *testing.T) {
	ctx := context.Background()
	db := bindingsTestDB(t)
	if _, err := db.Exec(`INSERT INTO hook_observed_sessions
(execution_id, assignment_generation, provider, session_id, bound_at)
VALUES (?, ?, 'synthetic-provider', ?, ?)`,
		syntheticBoundary.ExecutionID, syntheticBoundary.Generation,
		syntheticSession, syntheticTime.Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	capability := NewCapability(syntheticBoundary, JournalBindings{Sessions: journal.NewStore(db)}, &fakeAuthority{})
	if err := capability.allowWrite(ctx); err != nil {
		t.Fatalf("bound capability must activate: %v", err)
	}
	if capability.State() != StateActivated || capability.SessionID() != syntheticSession {
		t.Fatalf("activation lost the trusted session: %+v", capability.SessionID())
	}
	unbound := NewCapability(syntheticBoundary, JournalBindings{Sessions: journal.NewStore(bindingsTestDB(t))}, &fakeAuthority{})
	if err := unbound.allowWrite(ctx); CodeOf(err) != "session_not_bound" {
		t.Fatalf("unbound capability must reject writes: %v", err)
	}
}
