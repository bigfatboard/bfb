// ABOUTME: Supplies deterministic journal test doubles without provider or network access.
// ABOUTME: Keeps correlation secrets synthetic and every timestamp fixed for replay.

package journal

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/protocol/generated"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers/fake"
)

var testBase = time.Date(2026, 9, 17, 12, 0, 0, 0, time.UTC)

func testToken(t *testing.T) string {
	t.Helper()
	raw := make([]byte, 32)
	for index := range raw {
		raw[index] = 0x41
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func testRegistry(t *testing.T) *provider.Registry {
	t.Helper()
	registry, err := provider.NewRegistry([]provider.Descriptor{fake.Descriptor()})
	if err != nil {
		t.Fatal(err)
	}
	return registry
}

func openJournalDB(t *testing.T) (*daemon.Store, *Store) {
	t.Helper()
	root, err := os.MkdirTemp("/tmp", "bfb-l06-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	paths, err := daemon.StatePaths(root)
	if err != nil {
		t.Fatal(err)
	}
	if err = paths.Prepare(); err != nil {
		t.Fatal(err)
	}
	state, err := daemon.OpenStore(context.Background(), paths)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = state.Close() })
	return state, NewStore(state.DB)
}

type fakeAssignments struct {
	mu   sync.Mutex
	byID map[string]Assignment
}

func newFakeAssignments() *fakeAssignments {
	return &fakeAssignments{byID: map[string]Assignment{}}
}

func assignmentKey(execution string, generation int64) string {
	return fmt.Sprintf("%s/%d", execution, generation)
}

func (f *fakeAssignments) seed(assignment Assignment) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.byID[assignmentKey(assignment.ExecutionID, assignment.Generation)] = assignment
}

func testAssignment(execution, runner, token string, generation int64) Assignment {
	return Assignment{
		IntentID: "e0da52a9-d0cb-47d8-867b-e08f684b9001", ExecutionID: execution, Generation: generation,
		RunnerID: runner, WorkspaceID: "01JBFB0W0RKSPACE0000000000", ProjectID: "01JBFB0PR0JECTX00000000000",
		TaskID: "01JBFB0TASKXXXX00000000000", RunID: "01JBFB0RVNXXXXX00000000000", CheckoutID: "01JBFB0CHECK0VT0000000000",
		Provider: "fake", Token: token, CreatedAt: localTimestamp(testBase),
	}
}

func (f *fakeAssignments) ByExecution(_ context.Context, execution string, generation int64) (Assignment, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	assignment, ok := f.byID[assignmentKey(execution, generation)]
	if !ok {
		return Assignment{}, failure("unknown_assignment")
	}
	return assignment, nil
}

func (f *fakeAssignments) ByIntent(_ context.Context, intent string) (Assignment, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, assignment := range f.byID {
		if assignment.IntentID == intent {
			return assignment, nil
		}
	}
	return Assignment{}, failure("unknown_assignment")
}

type fakeObservers struct {
	mu       sync.Mutex
	queue    []Observation
	marked   []string
	fail     error
	failMark error
}

func (f *fakeObservers) PendingObservations(_ context.Context, limit int) ([]Observation, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return nil, f.fail
	}
	out := make([]Observation, 0, len(f.queue))
	for _, event := range f.queue {
		already := false
		for _, id := range f.marked {
			if id == event.EventID {
				already = true
			}
		}
		if !already {
			out = append(out, event)
		}
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func (f *fakeObservers) MarkImported(_ context.Context, _ *sql.Tx, eventIDs []string, _ time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail != nil {
		return f.fail
	}
	if f.failMark != nil {
		return f.failMark
	}
	f.marked = append(f.marked, eventIDs...)
	return nil
}

func hookRaw(kind, session, source string) []byte {
	candidate := map[string]any{"kind": kind}
	if session != "" {
		candidate["session_id"] = session
	}
	if source != "" {
		candidate["source_event_id"] = source
	}
	data, _ := json.Marshal(candidate)
	return data
}

func ingest(t *testing.T, store *Store, assignments Assignments, registry *provider.Registry, execution, runner, token, providerName string, raw []byte, captured time.Time) Receipt {
	t.Helper()
	receipt, err := store.Ingest(context.Background(), assignments, registry, HookInput{
		Provider: providerName, Raw: raw, ExecutionID: execution, Generation: 1, Token: token,
		WorkspaceID: "01JBFB0W0RKSPACE0000000000", ProjectID: "01JBFB0PR0JECTX00000000000",
		TaskID: "01JBFB0TASKXXXX00000000000", RunID: "01JBFB0RVNXXXXX00000000000",
		CapturedAt: captured,
	}, captured)
	if err != nil {
		t.Fatal(err)
	}
	return receipt
}

func journalCount(t *testing.T, store *Store) int {
	t.Helper()
	var count int
	if err := store.db.QueryRow("SELECT count(*) FROM hook_journal").Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func quarantineCount(t *testing.T, store *Store) int {
	t.Helper()
	var count int
	if err := store.db.QueryRow("SELECT count(*) FROM hook_quarantine").Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func decodeSubmission(t *testing.T, store *Store, eventID string) generated.RunnerEventSubmission {
	t.Helper()
	var data string
	if err := store.db.QueryRow("SELECT submission_json FROM hook_journal WHERE event_id = ?", eventID).Scan(&data); err != nil {
		t.Fatal(err)
	}
	var submission generated.RunnerEventSubmission
	if err := json.Unmarshal([]byte(data), &submission); err != nil {
		t.Fatal(err)
	}
	return submission
}
