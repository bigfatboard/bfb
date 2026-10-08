// ABOUTME: Exercises hook ingest and status through stable CLI dispatch.
// ABOUTME: Uses synthetic assignments and redacted envelopes without daemon processes.

package cli

import (
	"bytes"
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/journal"
	"github.com/qdis/bfb/internal/protocol"
	"github.com/qdis/bfb/internal/provider"
	"github.com/qdis/bfb/internal/providers/fake"
)

type hookBackend struct {
	assignments journal.Assignments
	observers   journal.Observers
}

type hookAssignment struct {
	assignment journal.Assignment
}

func (h hookAssignment) ByExecution(_ context.Context, _ string, _ int64) (journal.Assignment, error) {
	return h.assignment, nil
}

func (h hookAssignment) ByIntent(_ context.Context, _ string) (journal.Assignment, error) {
	return h.assignment, nil
}

type hookObservers struct{}

func (hookObservers) PendingObservations(_ context.Context, _ int) ([]journal.Observation, error) {
	return nil, nil
}

func (hookObservers) MarkImported(_ context.Context, _ *sql.Tx, _ []string, _ time.Time) error {
	return nil
}

func hookTestPaths(t *testing.T) daemon.Paths {
	t.Helper()
	root, err := os.MkdirTemp("/tmp", "bfb-hook-cli-")
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
	return paths
}

func hookTestRegistry(t *testing.T, assignment journal.Assignment) (*Registry, *provider.Registry) {
	t.Helper()
	providers, err := provider.NewRegistry([]provider.Descriptor{fake.Descriptor()})
	if err != nil {
		t.Fatal(err)
	}
	registry := NewRegistry()
	RegisterHook(registry, providers, func(*sql.DB) (journal.Assignments, journal.Observers) {
		return hookAssignment{assignment: assignment}, hookObservers{}
	})
	return registry, providers
}

func TestHookIngestAndStatus(t *testing.T) {
	paths := hookTestPaths(t)
	state, err := daemon.OpenStore(context.Background(), paths)
	if err != nil {
		t.Fatal(err)
	}
	_ = state.Close()
	assignment := journal.Assignment{
		ExecutionID: "01JBFB0EXECXXXX00000000000", Generation: 1, RunnerID: "01JBFB0RVNNER1D00000000000",
		WorkspaceID: "01JBFB0W0RKSPACE0000000000", Provider: "fake", Token: "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE",
		CreatedAt: "2026-09-17T12:00:00Z",
	}
	registry, _ := hookTestRegistry(t, assignment)
	t.Setenv("BFB_RUN_EXECUTION_ID", assignment.ExecutionID)
	t.Setenv("BFB_ASSIGNMENT_GENERATION", "1")
	t.Setenv("BFB_CORRELATION_TOKEN", assignment.Token)
	t.Setenv("BFB_WORKSPACE_ID", assignment.WorkspaceID)
	var output bytes.Buffer
	exit := registry.Execute(context.Background(), []string{"--json", "--data-dir", paths.Root, "hook", "ingest", "--provider", "fake"}, strings.NewReader(`{"kind":"session_started","session_id":"sess-cli"}`), &output)
	if exit != 0 {
		t.Fatalf("ingest exit %d: %s", exit, output.String())
	}
	decoded := protocol.DecodeWireDocument("local-rpc", output.Bytes())
	if !decoded.OK {
		t.Fatalf("invalid CLI envelope: %s", output.String())
	}
	if !strings.Contains(output.String(), `"hook_status":"accepted"`) {
		t.Fatalf("missing receipt: %s", output.String())
	}
	output.Reset()
	exit = registry.Execute(context.Background(), []string{"--json", "--data-dir", paths.Root, "hook", "status"}, strings.NewReader(""), &output)
	if exit != 0 {
		t.Fatalf("status exit %d: %s", exit, output.String())
	}
	if !strings.Contains(output.String(), `"hook_pending":1`) || !strings.Contains(output.String(), `"telemetry_degraded":false`) {
		t.Fatalf("missing status: %s", output.String())
	}
	if strings.Contains(output.String(), assignment.Token) {
		t.Fatal("correlation secret leaked into CLI output")
	}
}

func TestHookIngestRejectsBadInput(t *testing.T) {
	paths := hookTestPaths(t)
	state, err := daemon.OpenStore(context.Background(), paths)
	if err != nil {
		t.Fatal(err)
	}
	_ = state.Close()
	assignment := journal.Assignment{
		ExecutionID: "01JBFB0EXECXXXX00000000000", Generation: 1, RunnerID: "01JBFB0RVNNER1D00000000000",
		Provider: "fake", Token: "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE",
		CreatedAt: "2026-09-17T12:00:00Z",
	}
	registry, _ := hookTestRegistry(t, assignment)
	t.Setenv("BFB_RUN_EXECUTION_ID", assignment.ExecutionID)
	t.Setenv("BFB_ASSIGNMENT_GENERATION", "1")
	t.Setenv("BFB_CORRELATION_TOKEN", "wrong-token")
	var output bytes.Buffer
	exit := registry.Execute(context.Background(), []string{"--json", "--data-dir", paths.Root, "hook", "ingest", "--provider", "fake"}, strings.NewReader(`{"kind":"session_started","session_id":"sess-cli"}`), &output)
	if exit != 0 || !strings.Contains(output.String(), `"hook_status":"rejected"`) {
		t.Fatalf("bad correlation: %d %s", exit, output.String())
	}
	output.Reset()
	exit = registry.Execute(context.Background(), []string{"--json", "--data-dir", paths.Root, "hook", "ingest"}, strings.NewReader(`{}`), &output)
	if exit != 2 {
		t.Fatalf("missing provider flag: %d %s", exit, output.String())
	}
}
