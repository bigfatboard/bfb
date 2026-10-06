// ABOUTME: Composes production BFB services for one signed, private exact-Claude-version certification build.
// ABOUTME: Starts only through explicit operator commands and never installs a service or changes provider support.

package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"os/signal"
	"syscall"

	"github.com/qdis/bfb/internal/agentwork"
	"github.com/qdis/bfb/internal/appbridge"
	"github.com/qdis/bfb/internal/artifact"
	"github.com/qdis/bfb/internal/checkout"
	"github.com/qdis/bfb/internal/cli"
	"github.com/qdis/bfb/internal/daemon"
	"github.com/qdis/bfb/internal/journal"
	"github.com/qdis/bfb/internal/providers/claude"
	"github.com/qdis/bfb/internal/runner"
	"github.com/qdis/bfb/internal/supervisor"
)

func main() {
	if cli.IsUnscopedClaudeHook(os.Args[1:]) {
		// An unrelated user-level Claude hook needs neither candidate pins nor
		// private state. Every other entry point retains the signed binding.
		return
	}
	syscall.Umask(0077)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	binding, err := loadBinding(ctx)
	if err != nil {
		_ = json.NewEncoder(os.Stderr).Encode(map[string]any{"error": map[string]string{"code": daemon.AsFailure(err).Code}})
		os.Exit(3)
	}
	arguments, err := fixedArguments(binding, os.Args[1:])
	if err != nil {
		_ = json.NewEncoder(os.Stderr).Encode(map[string]any{"error": map[string]string{"code": daemon.AsFailure(err).Code}})
		os.Exit(3)
	}
	providers, err := candidateRegistry(binding)
	if err != nil {
		os.Exit(3)
	}
	installation := candidateInstallation(binding)
	if err := guardCandidateDoctor(ctx, arguments, installation); err != nil {
		_ = json.NewEncoder(os.Stderr).Encode(map[string]any{"error": map[string]string{"code": daemon.AsFailure(err).Code}})
		os.Exit(3)
	}
	var executions *supervisor.Service
	bridge := appbridge.New(appbridge.Options{WakeIntent: func(ctx context.Context, intent string) error { return executions.Wake(ctx, intent) }})
	accept := func(ctx context.Context, enrollment runner.Enrollment, command runner.CommandReference) error {
		return executions.Accept(ctx, enrollment, command)
	}
	manager := runner.NewManager(runner.ManagerOptions{Providers: providers, Installation: installation, Consumers: map[string]runner.CommandConsumer{"launch": accept, "run_control": accept}, Notifier: bridge})
	executions = supervisor.NewService(supervisor.ServiceOptions{Providers: providers, Installation: installation, Connection: manager.Connection, WakeRunner: manager.Wake, OpenTerminal: bridge.OpenTerminal, FocusTerminal: bridge.FocusTerminal})
	methods := daemon.NewRegistry()
	for _, register := range []func() error{
		func() error { return appbridge.RegisterRPC(methods, bridge) },
		func() error { return checkout.RegisterRPC(methods) },
		func() error { return artifact.RegisterRPC(methods) },
		func() error { return runner.RegisterRPC(methods, manager) },
		func() error { return agentwork.RegisterRPC(methods, manager, executions.CheckAgentOwnership) },
		func() error { return supervisor.RegisterRPC(methods, executions) },
	} {
		if register() != nil {
			os.Exit(3)
		}
	}
	backend := func(db *sql.DB) (journal.Assignments, journal.Observers) {
		view := supervisor.JournalBackend{Intents: supervisor.NewIntentStore(db)}
		return view, view
	}
	telemetry := journal.NewService(journal.ServiceOptions{Providers: providers, Backend: backend, Connection: func(id string) (journal.Connection, error) { return manager.Connection(id) }})
	if journal.RegisterService(methods, telemetry) != nil {
		os.Exit(3)
	}
	commands := cli.NewRegistry()
	cli.RegisterDaemon(commands, methods)
	cli.RegisterMCP(commands)
	cli.RegisterHook(commands, providers, backend)
	cli.RegisterCheckout(commands)
	cli.RegisterArtifact(commands, daemon.Call)
	cli.RegisterRunner(commands)
	claude.RegisterCommands(commands)
	cli.RegisterRun(commands)
	cli.RegisterExecution(commands,
		func(ctx context.Context, paths daemon.Paths, intent string) error {
			return supervisor.RunHelper(ctx, paths, intent, providers)
		},
		func(ctx context.Context, paths daemon.Paths, intent string) error {
			return supervisor.RunExecChild(ctx, paths, intent, providers)
		}, supervisor.RecoverExecution)
	os.Exit(commands.ExecuteWithStderr(ctx, arguments, os.Stdin, os.Stdout, os.Stderr))
}
