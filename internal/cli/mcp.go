// ABOUTME: Exposes the run-scoped local MCP server as bfb mcp stdio on raw standard I/O.
// ABOUTME: Keeps JSON-RPC stdout pure by skipping CLI rendering; diagnostics use standard error.

package cli

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"

	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/localmcp"
	_ "modernc.org/sqlite"
)

// RegisterMCP registers the run-scoped local MCP stdio server. The command
// runs in raw stdio mode: the registry skips response rendering so standard
// output carries JSON-RPC values only.
func RegisterMCP(registry *Registry) {
	if err := registry.Register(Command{
		Path:     "mcp stdio",
		Method:   "mcp.stdio",
		Summary:  "Run the run-scoped local MCP server on stdio",
		RawStdio: true,
		Run: func(ctx context.Context, invocation Invocation) (map[string]any, error) {
			if len(invocation.Args) != 0 {
				return nil, &daemon.Failure{Code: "invalid_request"}
			}
			return nil, runMCPStdio(ctx, invocation)
		},
	}); err != nil {
		panic("duplicate built-in CLI command")
	}
}

func runMCPStdio(ctx context.Context, invocation Invocation) error {
	output := invocation.Output
	if output == nil {
		output = os.Stdout
	}
	env, err := localmcp.ParseEnv(os.Environ(), os.Getuid())
	if err != nil {
		_, _ = os.Stderr.Write([]byte("bfb mcp stdio: invalid_request\n"))
		return &daemon.Failure{Code: "invalid_request"}
	}
	assignments := localmcp.DaemonAssignments{DB: openAssignmentsReadOnly(invocation)}
	authority := localmcp.DaemonAuthority{Assignments: assignments}
	journal, err := localmcp.OpenJournal(filepath.Join(invocation.Paths.Root, "local-mcp-journal.sqlite"))
	if err != nil {
		_, _ = os.Stderr.Write([]byte("bfb mcp stdio: storage_failed\n"))
		return &daemon.Failure{Code: "storage_failed"}
	}
	defer journal.Close()
	server := localmcp.NewServer(ctx, localmcp.Deps{
		Env:         env,
		Inspector:   localmcp.OSInspector(),
		Assignments: assignments,
		Bindings:    localmcp.ProvisionalBindings{},
		Authority:   authority,
		Transport:   localmcp.OfflineTransport{},
		Journal:     journal,
		Policy:      localmcp.DefaultOfflinePolicy{AllowPending: true},
		Grant:       "runner:" + env.RunnerID,
		Stderr:      os.Stderr,
	})
	if code := server.Serve(ctx, invocation.Input, output); code != 0 {
		return &daemon.Failure{Code: "internal_error"}
	}
	return nil
}

// openAssignmentsReadOnly opens the daemon database without migrations or
// writes. A missing database yields no handle; lookups then fail closed as
// assignment_unknown instead of inventing authority.
func openAssignmentsReadOnly(invocation Invocation) *sql.DB {
	path := invocation.Paths.Database
	if path == "" {
		return nil
	}
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil
	}
	return db
}
