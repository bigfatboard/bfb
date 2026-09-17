// ABOUTME: Supplies local daemon lifecycle and diagnostic CLI leaf commands.
// ABOUTME: Keeps the future hook entry point explicitly unavailable until implemented.

package cli

import (
	"context"
	"os"
	"strconv"
	"time"

	"github.com/qdis/bfb/internal/daemon"
)

func RegisterDaemon(registry *Registry, methods *daemon.Registry) {
	register := func(command Command) {
		if err := registry.Register(command); err != nil {
			panic("duplicate built-in CLI command")
		}
	}
	register(Command{Path: "daemon run", Method: "daemon.run", Summary: "Run the private per-user daemon", Run: func(ctx context.Context, invocation Invocation) (map[string]any, error) {
		if len(invocation.Args) != 0 {
			return nil, &daemon.Failure{Code: "invalid_request"}
		}
		server, err := daemon.Start(ctx, invocation.Paths, methods)
		if err != nil {
			_ = daemon.NewLogger(invocation.Paths).Record(daemon.LogEvent{Event: "rpc_failed", Code: daemon.AsFailure(err).Diagnostic().Code})
			return nil, err
		}
		<-server.Done
		return map[string]any{"status": "stopping"}, nil
	}})
	for _, action := range []string{"status", "stop"} {
		method := "daemon." + action
		register(Command{Path: "daemon " + action, Method: method, Summary: action + " the local daemon", Run: func(ctx context.Context, invocation Invocation) (map[string]any, error) {
			if len(invocation.Args) != 0 {
				return nil, &daemon.Failure{Code: "invalid_request"}
			}
			response, err := daemon.Call(ctx, invocation.Paths, method, nil)
			return response.Payload, err
		}})
	}
	register(Command{Path: "daemon logs", Method: "daemon.logs", Summary: "Read bounded redacted diagnostics", Run: func(_ context.Context, invocation Invocation) (map[string]any, error) {
		limit := 100
		if len(invocation.Args) != 0 {
			if len(invocation.Args) != 2 || invocation.Args[0] != "--lines" {
				return nil, &daemon.Failure{Code: "invalid_request"}
			}
			var err error
			limit, err = strconv.Atoi(invocation.Args[1])
			if err != nil {
				return nil, &daemon.Failure{Code: "invalid_request"}
			}
		}
		entries, err := daemon.NewLogger(invocation.Paths).Read(limit)
		return map[string]any{"log_entries": entries}, err
	}})
	register(Command{Path: "daemon install", Method: "daemon.install", Summary: "Install the per-user macOS launch agent", Run: func(ctx context.Context, invocation Invocation) (map[string]any, error) {
		label := daemon.ServiceLabel
		if len(invocation.Args) != 0 {
			if len(invocation.Args) != 2 || invocation.Args[0] != "--label" {
				return nil, &daemon.Failure{Code: "invalid_request"}
			}
			label = invocation.Args[1]
		}
		executable, err := os.Executable()
		if err != nil {
			return nil, &daemon.Failure{Code: "install_failed"}
		}
		agentsDir, err := daemon.DefaultAgentsDirectory()
		if err != nil {
			return nil, err
		}
		installContext, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		if err = daemon.Install(installContext, invocation.Paths, executable, agentsDir, label); err != nil {
			return nil, err
		}
		return map[string]any{"status": "installed"}, nil
	}})
	for _, item := range []struct{ path, method string }{{"hook ingest", "hook.ingest"}} {
		register(Command{Path: item.path, Method: item.method, Summary: "Reserved; capability not implemented yet", Run: func(_ context.Context, _ Invocation) (map[string]any, error) {
			return nil, &daemon.Failure{Code: "not_implemented"}
		}})
	}
}
