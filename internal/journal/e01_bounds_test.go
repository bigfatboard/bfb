// ABOUTME: Pins the journal uploader to the E01 ingest route and bounds.
// ABOUTME: Proves a 30-row backlog drains and inbox import never starves uploads.

package journal

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/protocol/generated"
)

// TestUploadActionMatchesWorkerRoute pins the Go uploader to the Worker route
// pattern: the served action in apps/control-worker/src/api/events.ts must
// name the same .../events/ingest action the uploader posts to.
func TestUploadActionMatchesWorkerRoute(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime caller unavailable")
	}
	routeSource, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "..", "apps", "control-worker", "src", "api", "events.ts"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(routeSource), `/events\/(ingest|capabilities)`) {
		t.Fatal("worker route no longer serves events/ingest")
	}
	if UploadAction != "events/ingest" {
		t.Fatalf("uploader posts to %q, worker serves events/ingest", UploadAction)
	}
}

// boundEnforcingConnection simulates the E01 transport bounds: batches over
// 25 items or 65,536 bytes are rejected whole, like the Worker does.
type boundEnforcingConnection struct {
	calls        int
	maxItemsSeen int
	maxBodySeen  int
}

func (f *boundEnforcingConnection) Request(_ context.Context, method, action string, body []byte) ([]byte, error) {
	f.calls++
	if method != "POST" || action != UploadAction {
		return nil, errors.New("unexpected upload request")
	}
	var batch struct {
		SchemaVersion int               `json:"schema_version"`
		Events        []json.RawMessage `json:"events"`
	}
	if err := json.Unmarshal(body, &batch); err != nil || batch.SchemaVersion != 1 {
		return nil, errors.New("unexpected upload body")
	}
	if len(batch.Events) > 25 || len(body) > 65_536 {
		return nil, errors.New("transport rejected oversized batch")
	}
	if len(batch.Events) > f.maxItemsSeen {
		f.maxItemsSeen = len(batch.Events)
	}
	if len(body) > f.maxBodySeen {
		f.maxBodySeen = len(body)
	}
	dispositions := []map[string]any{}
	for _, raw := range batch.Events {
		var submission generated.RunnerEventSubmission
		if err := json.Unmarshal(raw, &submission); err != nil {
			return nil, errors.New("unexpected submission")
		}
		dispositions = append(dispositions, map[string]any{
			"schema_version": 1, "event_id": submission.EventId,
			"source_stream_id": submission.SourceStreamId, "source_sequence": submission.SourceSequence,
			"disposition": "accepted",
		})
	}
	response, _ := json.Marshal(map[string]any{"schema_version": 1, "workspace_id": "01JBFB0W0RKSPACE0000000000", "high_water_cursor": 0, "dispositions": dispositions})
	return response, nil
}

// TestBacklogBeyondServerBatchLimitDrains proves a 30-row backlog drains
// through the E01 bounds instead of stalling on whole-batch rejections.
func TestBacklogBeyondServerBatchLimitDrains(t *testing.T) {
	_, store := openJournalDB(t)
	assignments := newFakeAssignments()
	token := testToken(t)
	seedOne(t, assignments, testExecution, testRunner, token)
	uploadTestEvents(t, store, assignments, token, 30)
	connection := &boundEnforcingConnection{}
	uploader := &Uploader{Store: store, Lookup: func(runner string) (Connection, error) {
		if runner != testRunner {
			return nil, errors.New("runner offline")
		}
		return connection, nil
	}, Now: func() time.Time { return testBase.Add(time.Hour) }}
	uploaded := 0
	var pending int
	var err error
	for range 5 {
		var done int
		done, pending, err = uploader.UploadOnce(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		uploaded += done
		if pending == 0 {
			break
		}
	}
	if err != nil || uploaded != 30 || pending != 0 {
		t.Fatalf("backlog stalled: uploaded %d pending %d err %v", uploaded, pending, err)
	}
	if journalCount(t, store) != 0 {
		t.Fatal("drained backlog left rows queued")
	}
	if connection.calls < 2 {
		t.Fatalf("30 rows drained in %d batch, bounds require at least two", connection.calls)
	}
	if connection.maxItemsSeen > 25 || connection.maxBodySeen > 65_536 {
		t.Fatalf("uploader exceeded server bounds: %d items %d bytes", connection.maxItemsSeen, connection.maxBodySeen)
	}
}

// dbAssignments resolves assignments with queries against the same database
// the journal uses, like the production supervisor backend does.
type dbAssignments struct {
	db *sql.DB
}

func (d *dbAssignments) ByExecution(ctx context.Context, executionID string, generation int64) (Assignment, error) {
	var assignment Assignment
	assignment.ExecutionID = executionID
	assignment.Generation = generation
	if err := d.db.QueryRowContext(ctx, `SELECT token, runner_id, workspace_id, project_id, task_id, run_id, provider, created_at FROM test_assignments WHERE execution_id = ? AND generation = ?`, executionID, generation).Scan(
		&assignment.Token, &assignment.RunnerID, &assignment.WorkspaceID, &assignment.ProjectID, &assignment.TaskID, &assignment.RunID, &assignment.Provider, &assignment.CreatedAt); err != nil {
		return Assignment{}, failure("unknown_assignment")
	}
	assignment.IntentID = "e0da52a9-d0cb-47d8-867b-e08f684b9001"
	assignment.CheckoutID = "01JBFB0CHECK0VT0000000000"
	return assignment, nil
}

func (d *dbAssignments) ByIntent(_ context.Context, _ string) (Assignment, error) {
	return Assignment{}, failure("unknown_assignment")
}

// TestInboxImportWithDatabaseAssignmentsDoesNotDeadlock proves inbox import
// resolves the assignment before opening its transaction: with the daemon's
// single-connection pool, a lookup that queries the same database must not
// wait out the context while a capture file exists.
func TestInboxImportWithDatabaseAssignmentsDoesNotDeadlock(t *testing.T) {
	state, store := openJournalDB(t)
	root := state.Paths.Root
	token := testToken(t)
	if _, err := state.DB.Exec(`CREATE TABLE test_assignments (execution_id TEXT, generation INTEGER, token TEXT, runner_id TEXT, workspace_id TEXT, project_id TEXT, task_id TEXT, run_id TEXT, provider TEXT, created_at TEXT)`); err != nil {
		t.Fatal(err)
	}
	seed := testAssignment(testExecution, testRunner, token, 1)
	if _, err := state.DB.Exec(`INSERT INTO test_assignments (execution_id, generation, token, runner_id, workspace_id, project_id, task_id, run_id, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		seed.ExecutionID, seed.Generation, seed.Token, seed.RunnerID, seed.WorkspaceID, seed.ProjectID, seed.TaskID, seed.RunID, "fake", seed.CreatedAt); err != nil {
		t.Fatal(err)
	}
	if _, err := WriteCapture(root, token, testExecution, 1, "fake", hookRaw("session_started", "sess-db", ""), testBase.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	start := time.Now()
	result, err := store.ImportInbox(ctx, &dbAssignments{db: state.DB}, testRegistry(t), root, 256, testBase.Add(time.Minute))
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("import blocked on the single connection: %v after %v", err, elapsed)
	}
	if result.Imported != 1 {
		t.Fatalf("import result: %+v", result)
	}
	if elapsed >= 5*time.Second {
		t.Fatalf("import burned %v of its context with a capture pending", elapsed)
	}
	if journalCount(t, store) != 1 {
		t.Fatal("imported capture left no journal row")
	}
}
